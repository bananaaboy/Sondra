package ch.lizge.sondra;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import androidx.browser.customtabs.CustomTabsIntent;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.FileNotFoundException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * What the page asks of the app, and what the app hands the page.
 *
 * The page sees one object, `SondraNative` (androidx.webkit's
 * WebMessageListener), and only on https://sondra.lizge.ch — no other
 * address that might end up in the WebView gets it. A message is a JSON
 * object with an `id` and a `type`; the answer comes back with the same `id`.
 */
final class Bridge {
    private static final String OPENED_PATH = "/__app/opened/";
    /** Where `google-drive.html` sends the browser back after the Google sign-in. */
    static final String RETURN_SCHEME = "ch.lizge.sondra";
    static final String RETURN_HOST = "angemeldet";
    /** Back in Sondra without an answer by then: the browser was closed. */
    private static final long GAVE_UP_AFTER = 1500;

    private final MainActivity activity;
    private final Saver saver;
    private final Downloader downloader;
    private Updater updater;
    private final Handler main = new Handler(Looper.getMainLooper());
    /** The sign-in is open in the browser. */
    private boolean signingIn;
    /** Google's answer, as the query of the address it came back with, until the page takes it. */
    private String signInAnswer;
    private JavaScriptReplyProxy page;
    private final List<JSONObject> waiting = new ArrayList<>();
    private final Map<String, Uri> served = Collections.synchronizedMap(new HashMap<>());
    private final Map<String, String> servedTypes = Collections.synchronizedMap(new HashMap<>());

    Bridge(MainActivity activity) {
        this.activity = activity;
        this.saver = new Saver(activity);
        this.downloader = new Downloader(activity);
        // What the app's own sign-in kept before it went the website's way.
        activity.deleteSharedPreferences("drive");
    }

    void setUpdater(Updater updater) {
        this.updater = updater;
    }

    // The listener, and with it every reply proxy, exists only where the feature does.
    @SuppressLint("RequiresFeature")
    void attach(WebView webView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Log.w(MainActivity.TAG, "WebView ohne WebMessageListener: Sondra läuft ohne die Teile der App");
            return;
        }
        WebViewCompat.addWebMessageListener(webView, "SondraNative", Collections.singleton(MainActivity.ORIGIN),
                (view, message, origin, isMainFrame, reply) -> {
                    if (!isMainFrame || !MainActivity.isOwn(origin)) return;
                    if (page == null) Log.i(MainActivity.TAG, "Seite verbunden");
                    page = reply;
                    String data = message.getType() == WebMessageCompat.TYPE_STRING ? message.getData() : null;
                    if (data == null) return;
                    try {
                        handle(new JSONObject(data), reply);
                    } catch (JSONException e) {
                        Log.w(MainActivity.TAG, "Unlesbare Nachricht der Seite");
                    }
                });
    }

    private void handle(JSONObject message, JavaScriptReplyProxy reply) throws JSONException {
        String id = message.optString("id");
        switch (message.optString("type")) {
            case "hello":
                answer(reply, id, new JSONObject().put("version", activity.version()));
                break;
            case "sign-in":
                answer(reply, id, openSignIn(message.optString("url")));
                break;
            case "sign-in-result": {
                String taken = signInAnswer;
                signInAnswer = null;
                answer(reply, id, taken != null ? taken : JSONObject.NULL);
                break;
            }
            case "opened":
                answer(reply, id, takeOpened());
                break;
            case "save-begin":
                saver.begin(message.optString("name"), message.optString("mime"), result -> answer(reply, id, result));
                break;
            case "save-chunk":
                saver.chunk(message.optInt("handle"), message.optString("data"), result -> answer(reply, id, result));
                break;
            case "save-end":
                saver.end(message.optInt("handle"), result -> answer(reply, id, result));
                break;
            case "save-abort":
                saver.abort(message.optInt("handle"));
                break;
            case "direct-download":
                downloader.downloadDirect(
                        message.optString("url"),
                        message.optString("filename"),
                        message.optString("mime"),
                        message.optString("subFolder"),
                        result -> answer(reply, id, result));
                break;
            case "direct-download-abort":
                downloader.abort(message.optInt("taskId"));
                answer(reply, id, new JSONObject().put("ok", true));
                break;
            case "theme":
                activity.setPageDark(message.optBoolean("dark"));
                break;

            // --- Auto-Updater ---
            case "update-state":
                answer(reply, id, updater != null ? updater.getState() : new JSONObject().put("status", "off"));
                break;
            case "update-check":
                if (updater != null) {
                    updater.checkForUpdates(true, result -> answer(reply, id, result));
                } else {
                    answer(reply, id, new JSONObject().put("status", "off"));
                }
                break;
            case "update-download":
                if (updater != null) {
                    updater.startDownload(result -> answer(reply, id, result));
                } else {
                    answer(reply, id, new JSONObject().put("status", "off"));
                }
                break;
            case "update-install":
                boolean started = updater != null && updater.installUpdate();
                answer(reply, id, new JSONObject().put("ok", started));
                break;

            // --- Screen Wake Lock / Power Save Blocker ---
            case "wake-lock":
            case "power-save-blocker":
                activity.setKeepScreenOn(message.optBoolean("active", false));
                answer(reply, id, new JSONObject().put("ok", true));
                break;

            // --- Fullscreen Screen Orientation ---
            case "fullscreen-orientation": {
                String mode = message.optString("orientation");
                activity.runOnUiThread(() -> {
                    if ("portrait".equals(mode)) {
                        activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT);
                    } else if ("landscape".equals(mode)) {
                        activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                    } else {
                        activity.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                    }
                });
                answer(reply, id, new JSONObject().put("ok", true));
                break;
            }

            default:
                answer(reply, id, new JSONObject().put("ok", false).put("error", "rejected"));
        }
    }

    /** Emits an update state change event to the web page. */
    @SuppressLint("RequiresFeature")
    void tellUpdate(JSONObject state) {
        if (page == null) return;
        try {
            page.postMessage(new JSONObject().put("event", "update").put("state", state).toString());
        } catch (JSONException | IllegalStateException ignored) {}
    }

    /* ---------------------------------------------------------------- */
    /* The Google sign-in                                                */
    /* ---------------------------------------------------------------- */

    private JSONObject openSignIn(String address) throws JSONException {
        Uri url = Uri.parse(address);
        // Only Google's sign-in; the page has no reason to open anything else this way.
        if (!"https".equals(url.getScheme()) || !"accounts.google.com".equals(url.getHost())) {
            return new JSONObject().put("ok", false).put("error", "rejected");
        }
        try {
            new CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, url);
        } catch (ActivityNotFoundException e) {
            return new JSONObject().put("ok", false).put("error", "Kein Browser für die Anmeldung bei Google gefunden.");
        }
        signingIn = true;
        signInAnswer = null;
        Log.i(MainActivity.TAG, "Anmeldung bei Google im Browser geöffnet");
        return new JSONObject().put("ok", true);
    }

    static boolean isSignInReturn(Uri data) {
        if (data == null) return false;
        if (RETURN_SCHEME.equals(data.getScheme())) return RETURN_HOST.equals(data.getHost());
        // As an App Link (once Android trusts the app for the site), the
        // browser may hand Google's return to the page straight to the app.
        return "https".equals(data.getScheme()) && MainActivity.isOwn(data)
                && "/google-drive.html".equals(data.getPath())
                && (data.getEncodedQuery() != null || data.getEncodedFragment() != null);
    }

    /** Google's answer is back: kept for the page, and the page is told. */
    void signInReturned(Uri data) {
        StringBuilder query = new StringBuilder();
        if (data.getEncodedQuery() != null) query.append(data.getEncodedQuery());
        if (!RETURN_SCHEME.equals(data.getScheme()) && data.getEncodedFragment() != null) {
            if (query.length() > 0) query.append('&');
            query.append(data.getEncodedFragment());
        }
        signingIn = false;
        signInAnswer = query.toString();
        Log.i(MainActivity.TAG, "Zurück von der Anmeldung bei Google");
        tell("sign-in");
    }

    /** Sondra is in front again, after the browser, a picker or another app. */
    void resumed() {
        if (!signingIn) return;
        main.postDelayed(() -> {
            if (signingIn && signInAnswer == null) {
                signingIn = false;
                tell("sign-in-closed");
            }
        }, GAVE_UP_AFTER);
    }

    /** An event for the page, if it listens already; otherwise it asks when it is ready. */
    @SuppressLint("RequiresFeature")
    private void tell(String event) {
        if (page == null) return;
        try {
            page.postMessage(new JSONObject().put("event", event).toString());
        } catch (JSONException | IllegalStateException e) {
            // The page asks itself when it is ready.
        }
    }

    /** Answers on the main thread, as the reply proxy wants. */
    @SuppressLint("RequiresFeature")
    private void answer(JavaScriptReplyProxy reply, String id, Object result) {
        activity.runOnUiThread(() -> {
            try {
                reply.postMessage(new JSONObject().put("id", id).put("answer", result).toString());
            } catch (JSONException | IllegalStateException e) {
                // The page went away meanwhile; nobody waits for the answer.
            }
        });
    }

    /* ---------------------------------------------------------------- */
    /* Files shared with Sondra or opened with it                        */
    /* ---------------------------------------------------------------- */

    /** Takes the files an intent brings; the page collects them, now or when it asks. */
    @SuppressLint("RequiresFeature")
    void received(Intent intent) {
        if (intent == null) return;
        List<Uri> uris = new ArrayList<>();
        String action = intent.getAction();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) uris.add(uri);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        } else if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null
                && "content".equals(intent.getData().getScheme())) {
            uris.add(intent.getData());
        }
        if (uris.isEmpty()) {
            ClipData clip = intent.getClipData();
            if (clip != null && (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action))) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    if (clip.getItemAt(i).getUri() != null) uris.add(clip.getItemAt(i).getUri());
                }
            }
        }
        if (uris.isEmpty()) return;
        // Taken now, so a second share does not repeat the first one.
        intent.setAction(Intent.ACTION_MAIN);
        for (Uri uri : uris) {
            JSONObject entry = describe(uri);
            if (entry != null) waiting.add(entry);
        }
        Log.i(MainActivity.TAG, "Geteilt oder geöffnet: " + waiting.size() + " Datei(en)");
        tell("opened");
    }

    private JSONObject describe(Uri uri) {
        String name = null;
        long size = -1;
        try (Cursor cursor = activity.getContentResolver().query(uri,
                new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                name = cursor.getString(0);
                if (!cursor.isNull(1)) size = cursor.getLong(1);
            }
        } catch (RuntimeException e) {
            // Without a name the file still comes, called after its address.
        }
        if (name == null) name = uri.getLastPathSegment() != null ? uri.getLastPathSegment() : "geteilt";
        String type;
        try {
            type = activity.getContentResolver().getType(uri);
        } catch (RuntimeException e) {
            type = null;
        }
        String token = UUID.randomUUID().toString();
        served.put(token, uri);
        servedTypes.put(token, type != null ? type : "application/octet-stream");
        try {
            return new JSONObject()
                    .put("url", MainActivity.ORIGIN + OPENED_PATH + token)
                    .put("name", name)
                    .put("type", type != null ? type : "")
                    .put("size", size);
        } catch (JSONException e) {
            return null;
        }
    }

    private JSONArray takeOpened() {
        JSONArray out = new JSONArray();
        for (JSONObject entry : waiting) out.put(entry);
        waiting.clear();
        return out;
    }

    /**
     * The page fetching a shared file: streamed from Android, once. Any other
     * address goes to the network as usual (null).
     */
    WebResourceResponse intercept(Uri url) {
        if (url == null || !MainActivity.isOwn(url) || url.getPath() == null
                || !url.getPath().startsWith(OPENED_PATH)) {
            return null;
        }
        String token = url.getPath().substring(OPENED_PATH.length());
        Uri uri = served.remove(token);
        String type = servedTypes.remove(token);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        if (uri == null) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
        }
        try {
            InputStream in = activity.getContentResolver().openInputStream(uri);
            return new WebResourceResponse(type, null, 200, "OK", headers, in);
        } catch (FileNotFoundException | SecurityException e) {
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, null);
        }
    }

    static String quote(String text) {
        return JSONObject.quote(text);
    }
}
