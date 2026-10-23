package ch.lizge.sondra;

import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import androidx.browser.customtabs.CustomTabsIntent;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Google Drive for the page: the sign-in, and the key that keeps it.
 *
 * The same actions the Windows app answers (`desktop/googleDrive.mjs`), so
 * the page's app path (`lib/googleDrive.ts`) needs nothing new: status,
 * connect, cancel, token, disconnect — each answering `{ ok: true, … }` or
 * `{ ok: false, error, detail }`.
 *
 * And the same way in: Google lets no WebView sign in, so the sign-in opens
 * in the browser (a Custom Tab over Sondra) and Google's answer comes to a
 * port of this phone for one request (loopback with PKCE, RFC 8252), with
 * Google's „Desktop app“ client the Windows app uses. Nothing in Google
 * Cloud has to know this app or the key it is signed with. The browser is
 * then sent back to Sondra (`ch.lizge.sondra://angemeldet`, which carries
 * nothing). What Google hands back to keep — the refresh token — stays on
 * the phone, encrypted with a key in the Android Keystore that never leaves
 * it; the page asks for an access token when it needs one, an hour each.
 */
final class DriveAuth {
    interface Done {
        void answer(JSONObject result);
    }

    static final String RETURN_SCHEME = "ch.lizge.sondra";
    static final String RETURN_HOST = "angemeldet";

    private static final String SCOPE = "https://www.googleapis.com/auth/drive.file";
    private static final String AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
    private static final String TOKEN = "https://oauth2.googleapis.com/token";
    private static final String REVOKE = "https://oauth2.googleapis.com/revoke";
    /** How long the browser has for the sign-in before the port closes again. */
    private static final int SIGN_IN_TIMEOUT = 5 * 60 * 1000;
    /** Back in Sondra without an answer from Google: the tab was closed. */
    private static final long GAVE_UP_AFTER = 1500;
    private static final String KEY_ALIAS = "sondra-drive";

    private final MainActivity activity;
    private final SharedPreferences prefs;
    private final boolean configured = !BuildConfig.GOOGLE_CLIENT_ID.isEmpty() && !BuildConfig.GOOGLE_CLIENT_SECRET.isEmpty();
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private String refresh;
    private String access;
    private long accessUntil;
    private SignIn pending;

    DriveAuth(MainActivity activity) {
        this.activity = activity;
        this.prefs = activity.getSharedPreferences("drive", Context.MODE_PRIVATE);
        // The sign-in of the version before, through Google Play services, held nothing to keep.
        prefs.edit().remove("linked").apply();
        String stored = prefs.getString("refresh", null);
        if (stored != null) {
            try {
                refresh = decrypt(stored);
            } catch (GeneralSecurityException | IOException | IllegalArgumentException e) {
                // A backup on a new phone, or a key the system dropped: sign in anew.
                Log.w(MainActivity.TAG, "Google Drive: Schlüssel nicht lesbar, neu anmelden");
                prefs.edit().remove("refresh").apply();
            }
        }
    }

    /** Runs on the main thread, as the page's messages come. */
    void handle(String action, JSONArray args, Done done) {
        switch (action) {
            case "status":
                done.answer(ok().put("configured", configured).put("connected", refresh != null)
                        .put("lasting", true).put("waiting", pending != null));
                break;
            case "connect":
                connect(done);
                break;
            case "cancel":
                if (pending != null) pending.finish(error("cancelled", null));
                done.answer(ok());
                break;
            case "token":
                token(args != null && args.optBoolean(0), done);
                break;
            case "disconnect":
                disconnect(done);
                break;
            default:
                done.answer(error("rejected", null));
        }
    }

    /** Sondra is in front again; without Google's answer by now, the sign-in was given up. */
    void resumed() {
        SignIn own = pending;
        if (own == null || !own.opened) return;
        main.postDelayed(() -> {
            if (pending == own && !own.answered) own.finish(error("cancelled", null));
        }, GAVE_UP_AFTER);
    }

    /* ---------------------------------------------------------------- */
    /* Signing in                                                        */
    /* ---------------------------------------------------------------- */

    private void connect(Done done) {
        if (!configured) {
            done.answer(error("not-configured", null));
            return;
        }
        if (pending != null) pending.finish(error("cancelled", null));
        SignIn own = new SignIn(done);
        pending = own;
        own.start();
    }

    /**
     * One sign-in: a port on this phone for the one request the browser
     * sends back, the browser itself, the code turned into a key.
     */
    private final class SignIn {
        private final Done done;
        private final String verifier = random(48);
        private final String state = random(16);
        private ServerSocket server;
        private String redirect;
        /** The browser is open; set on the main thread. */
        boolean opened;
        /** Google's answer reached the port; from then on it is only a matter of time. */
        volatile boolean answered;
        private boolean finished;

        SignIn(Done done) {
            this.done = done;
        }

        void start() {
            Thread thread = new Thread(this::run, "sondra-drive-anmeldung");
            thread.setDaemon(true);
            thread.start();
        }

        private void run() {
            try {
                server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
                server.setSoTimeout(SIGN_IN_TIMEOUT);
                redirect = "http://127.0.0.1:" + server.getLocalPort() + "/";
            } catch (IOException e) {
                post(error("failed", "kein Port frei: " + e.getMessage()));
                return;
            }
            main.post(this::openBrowser);
            String code;
            try {
                code = awaitCode();
            } catch (SocketTimeoutException e) {
                post(error("timeout", null));
                return;
            } catch (IOException e) {
                // Closed by finish(): cancelled, or a second sign-in took the place.
                post(error("cancelled", null));
                return;
            } catch (Refused e) {
                post(e.answer);
                return;
            } finally {
                close();
            }
            try {
                JSONObject body = tokenRequest(form(
                        "grant_type", "authorization_code",
                        "code", code,
                        "redirect_uri", redirect,
                        "code_verifier", verifier));
                String scope = body.optString("scope", SCOPE);
                if (!(" " + scope + " ").contains(" " + SCOPE + " ")) {
                    post(error("scope", null));
                    return;
                }
                String kept = body.optString("refresh_token", "");
                if (kept.isEmpty()) {
                    post(error("failed", "kein refresh_token"));
                    return;
                }
                String token = body.getString("access_token");
                long until = System.currentTimeMillis() + body.optLong("expires_in", 3600) * 1000L;
                main.post(() -> {
                    if (finished) return;
                    keep(kept);
                    access = token;
                    accessUntil = until;
                    Log.i(MainActivity.TAG, "Google Drive: verbunden");
                    finish(ok().put("lasting", true));
                });
            } catch (Refused e) {
                post(e.answer);
            } catch (JSONException e) {
                post(error("failed", "Antwort von Google unlesbar"));
            }
        }

        private void openBrowser() {
            if (finished) return;
            Uri url = Uri.parse(AUTH).buildUpon()
                    .appendQueryParameter("client_id", BuildConfig.GOOGLE_CLIENT_ID)
                    .appendQueryParameter("redirect_uri", redirect)
                    .appendQueryParameter("response_type", "code")
                    .appendQueryParameter("scope", SCOPE)
                    .appendQueryParameter("code_challenge", challenge(verifier))
                    .appendQueryParameter("code_challenge_method", "S256")
                    .appendQueryParameter("state", state)
                    .appendQueryParameter("access_type", "offline")
                    // Without it a second sign-in brings no refresh token.
                    .appendQueryParameter("prompt", "consent")
                    .build();
            try {
                new CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, url);
                opened = true;
                Log.i(MainActivity.TAG, "Google Drive: Anmeldung im Browser geöffnet");
            } catch (ActivityNotFoundException e) {
                finish(error("failed", "Kein Browser für die Anmeldung bei Google gefunden."));
            }
        }

        /** Waits for the browser; the favicon and anything else without `state` is turned away. */
        private String awaitCode() throws IOException, Refused {
            while (true) {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(10_000);
                    Map<String, String> query = readQuery(socket.getInputStream());
                    OutputStream out = socket.getOutputStream();
                    if (query == null || !query.containsKey("state")) {
                        respond(out, "404 Not Found", "text/plain", "");
                        continue;
                    }
                    answered = true;
                    String refusal = query.get("error");
                    boolean sameState = state.equals(query.get("state"));
                    String code = query.get("code");
                    boolean good = sameState && refusal == null && code != null;
                    respond(out, "200 OK", "text/html; charset=utf-8", answerPage(good));
                    if (!sameState) throw new Refused(error("failed", "state"));
                    if (refusal != null) throw new Refused(error("access_denied".equals(refusal) ? "denied" : "failed", refusal));
                    if (code == null) throw new Refused(error("failed", "kein Code"));
                    return code;
                }
            }
        }

        private void post(JSONObject answer) {
            main.post(() -> finish(answer));
        }

        /** Answers the page once; the port closes whatever happened. */
        void finish(JSONObject answer) {
            if (finished) return;
            finished = true;
            close();
            if (pending == this) pending = null;
            String code = answer.optString("error", "");
            if (!code.isEmpty() && !"cancelled".equals(code)) {
                Log.w(MainActivity.TAG, "Google Drive: connect → " + code + " " + answer.optString("detail", ""));
            }
            done.answer(answer);
        }

        private void close() {
            ServerSocket own = server;
            if (own == null) return;
            try {
                own.close();
            } catch (IOException e) {
                // Closed already.
            }
        }
    }

    /** The first line of the browser's request, as its query; the rest is read and dropped. */
    private static Map<String, String> readQuery(InputStream in) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.ISO_8859_1));
        String first = reader.readLine();
        String line;
        do {
            line = reader.readLine();
        } while (line != null && !line.isEmpty());
        if (first == null) return null;
        String[] parts = first.split(" ");
        if (parts.length < 2 || !"GET".equals(parts[0])) return null;
        Uri target = Uri.parse("http://127.0.0.1" + parts[1]);
        Map<String, String> query = new LinkedHashMap<>();
        for (String name : target.getQueryParameterNames()) query.put(name, target.getQueryParameter(name));
        return query;
    }

    private static void respond(OutputStream out, String status, String type, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Referrer-Policy: no-referrer\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(bytes);
        out.flush();
    }

    /**
     * The page the browser shows after the sign-in: it sends the browser
     * straight back to Sondra, and says so with a button where the browser
     * waits for a tap first.
     */
    private static String answerPage(boolean ok) {
        String back = "intent://" + RETURN_HOST + "#Intent;scheme=" + RETURN_SCHEME + ";package=" + BuildConfig.APPLICATION_ID + ";end";
        String text = ok
                ? "Sondra ist mit Google Drive verbunden."
                : "Die Anmeldung bei Google hat nicht geklappt. Versuchen Sie es in Sondra noch einmal.";
        return "<!doctype html><html lang=\"de\"><meta charset=\"utf-8\">"
                + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<title>Sondra · Google Drive</title>"
                + "<style>body{font:17px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;"
                + "background:#f8faf8;color:#0b4a22}main{max-width:30em;margin:24px}"
                + "a{display:inline-block;margin-top:16px;padding:12px 20px;border-radius:10px;background:#0b4a22;color:#f8faf8;"
                + "text-decoration:none;font-weight:600}"
                + "@media(prefers-color-scheme:dark){body{background:#0a110d;color:#a6ecb9}a{background:#a6ecb9;color:#0a110d}}</style>"
                + "<main><p>" + text + "</p><a href=\"" + back + "\">Zurück zu Sondra</a></main>"
                + "<script>location.replace(" + JSONObject.quote(back) + ")</script></html>";
    }

    /* ---------------------------------------------------------------- */
    /* Tokens                                                            */
    /* ---------------------------------------------------------------- */

    /** An access token for the page, new when the last one is about to end or was refused. */
    private void token(boolean force, Done done) {
        if (refresh == null) {
            done.answer(error("unauthorized", null));
            return;
        }
        if (!force && access != null && accessUntil - 60_000 > System.currentTimeMillis()) {
            done.answer(tokenAnswer());
            return;
        }
        String asked = refresh;
        network.execute(() -> {
            JSONObject answer;
            try {
                JSONObject body = tokenRequest(form("grant_type", "refresh_token", "refresh_token", asked));
                String token = body.getString("access_token");
                long until = System.currentTimeMillis() + body.optLong("expires_in", 3600) * 1000L;
                main.post(() -> {
                    if (!asked.equals(refresh)) {
                        done.answer(error("unauthorized", null));
                        return;
                    }
                    access = token;
                    accessUntil = until;
                    done.answer(tokenAnswer());
                });
                return;
            } catch (Refused e) {
                answer = e.answer;
            } catch (JSONException e) {
                answer = error("failed", "Antwort von Google unlesbar");
            }
            JSONObject failed = answer;
            main.post(() -> {
                if ("revoked".equals(failed.optString("error")) && asked.equals(refresh)) {
                    // Withdrawn in the Google account: the next step is a new sign-in.
                    forget();
                    Log.i(MainActivity.TAG, "Google Drive: Zugang bei Google zurückgezogen, neu anmelden");
                    done.answer(error("unauthorized", null));
                } else {
                    done.answer(failed);
                }
            });
        });
    }

    private Answer tokenAnswer() {
        return ok().put("token", access).put("expiresAt", accessUntil);
    }

    private void disconnect(Done done) {
        String last = refresh;
        forget();
        if (last == null) {
            done.answer(ok());
            return;
        }
        // Withdrawn at Google as well, so the grant does not linger in the
        // account; offline, the key is gone here either way.
        network.execute(() -> {
            try {
                send(REVOKE, form("token", last));
            } catch (IOException e) {
                Log.w(MainActivity.TAG, "Google Drive: Zurückziehen nicht erreicht");
            }
            Log.i(MainActivity.TAG, "Google Drive: getrennt");
            main.post(() -> done.answer(ok()));
        });
    }

    private JSONObject tokenRequest(String fields) throws Refused {
        String all = form("client_id", BuildConfig.GOOGLE_CLIENT_ID, "client_secret", BuildConfig.GOOGLE_CLIENT_SECRET) + "&" + fields;
        Response response;
        try {
            response = send(TOKEN, all);
        } catch (IOException e) {
            throw new Refused(error("offline", e.getMessage()));
        }
        JSONObject body;
        try {
            body = new JSONObject(response.text);
        } catch (JSONException e) {
            body = new JSONObject();
        }
        if (response.status < 200 || response.status >= 300) {
            String code = body.optString("error", "");
            // A withdrawn or expired grant.
            if ("invalid_grant".equals(code)) throw new Refused(error("revoked", body.optString("error_description", "")));
            String detail = (response.status + " " + code + " " + body.optString("error_description", "")).trim();
            throw new Refused(error("failed", detail));
        }
        return body;
    }

    private static final class Response {
        final int status;
        final String text;

        Response(int status, String text) {
            this.status = status;
            this.text = text;
        }
    }

    private static Response send(String address, String form) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(20_000);
            connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
            try (OutputStream out = connection.getOutputStream()) {
                out.write(form.getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            ByteArrayOutputStream text = new ByteArrayOutputStream();
            if (in != null) {
                try (InputStream stream = in) {
                    byte[] buffer = new byte[8192];
                    int read;
                    while ((read = stream.read(buffer)) > 0) text.write(buffer, 0, read);
                }
            }
            return new Response(status, text.toString("UTF-8"));
        } finally {
            connection.disconnect();
        }
    }

    private static String form(String... pairs) {
        StringBuilder out = new StringBuilder();
        try {
            for (int i = 0; i + 1 < pairs.length; i += 2) {
                if (out.length() > 0) out.append('&');
                out.append(URLEncoder.encode(pairs[i], "UTF-8")).append('=').append(URLEncoder.encode(pairs[i + 1], "UTF-8"));
            }
        } catch (java.io.UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
        return out.toString();
    }

    /* ---------------------------------------------------------------- */
    /* The key on this phone                                             */
    /* ---------------------------------------------------------------- */

    private void keep(String token) {
        refresh = token;
        try {
            prefs.edit().putString("refresh", encrypt(token)).apply();
        } catch (GeneralSecurityException | IOException e) {
            // Without the Keystore it holds until Sondra closes.
            Log.w(MainActivity.TAG, "Google Drive: Schlüssel nicht gespeichert (" + e + ")");
        }
    }

    private void forget() {
        refresh = null;
        access = null;
        accessUntil = 0;
        prefs.edit().remove("refresh").apply();
    }

    private static SecretKey key() throws GeneralSecurityException, IOException {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        KeyStore.Entry entry = store.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }

    private static String encrypt(String text) throws GeneralSecurityException, IOException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] sealed = cipher.doFinal(text.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP);
    }

    private static String decrypt(String stored) throws GeneralSecurityException, IOException {
        int split = stored.indexOf(':');
        if (split < 0) throw new IllegalArgumentException("kein IV");
        byte[] iv = Base64.decode(stored.substring(0, split), Base64.NO_WRAP);
        byte[] sealed = Base64.decode(stored.substring(split + 1), Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(sealed), StandardCharsets.UTF_8);
    }

    /* ---------------------------------------------------------------- */

    private static String random(int bytes) {
        byte[] data = new byte[bytes];
        new SecureRandom().nextBytes(data);
        return Base64.encodeToString(data, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    private static String challenge(String verifier) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII));
            return Base64.encodeToString(hash, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    /** A step that ends in an answer for the page instead of a key. */
    private static final class Refused extends Exception {
        final JSONObject answer;

        Refused(JSONObject answer) {
            super(answer.optString("error"));
            this.answer = answer;
        }
    }

    private static Answer ok() {
        return new Answer().put("ok", true);
    }

    private static Answer error(String code, String detail) {
        Answer answer = new Answer().put("ok", false).put("error", code);
        return detail != null && !detail.isEmpty() ? answer.put("detail", detail) : answer;
    }

    /** A JSONObject whose put cannot fail for the plain values used here. */
    private static final class Answer extends JSONObject {
        @Override
        public Answer put(String name, Object value) {
            try {
                super.put(name, value);
            } catch (JSONException e) {
                throw new IllegalArgumentException(e);
            }
            return this;
        }

        @Override
        public Answer put(String name, boolean value) {
            return put(name, (Object) value);
        }

        @Override
        public Answer put(String name, long value) {
            return put(name, (Object) value);
        }
    }
}
