package ch.lizge.sondra;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.SystemClock;
import android.util.Log;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Scope;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Google Drive for the page, signed in with Android's own account sheet.
 *
 * The same actions the Windows app answers (`desktop/googleDrive.mjs`), so
 * the page's app path (`lib/googleDrive.ts`) needs nothing new: status,
 * connect, cancel, token, disconnect — each answering `{ ok: true, … }` or
 * `{ ok: false, error, detail }`.
 *
 * Google Play services keeps the grant: a token is asked for silently each
 * hour, no refresh token and no client secret live in the app. Google knows
 * the app by its package and the fingerprint of its key — an OAuth client
 * „Android“ in the website's Google Cloud project (so both see the same
 * „Sondra“ folder); without it the answer is `not-configured`.
 */
final class DriveAuth {
    interface Done {
        void answer(JSONObject result);
    }

    private static final String SCOPE = "https://www.googleapis.com/auth/drive.file";
    /** Google's tokens hold an hour; asked for anew a few minutes before. */
    private static final long TOKEN_LIFE = 55 * 60 * 1000L;

    private final Activity activity;
    private final SharedPreferences prefs;
    private final ActivityResultLauncher<IntentSenderRequest> consent;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private Done waiting;
    private String token;
    private long tokenUntil;

    DriveAuth(androidx.activity.ComponentActivity activity) {
        this.activity = activity;
        this.prefs = activity.getSharedPreferences("drive", Activity.MODE_PRIVATE);
        this.consent = activity.registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), result -> {
            Done done = waiting;
            waiting = null;
            if (done == null) return;
            if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
                done.answer(error("cancelled", null));
                return;
            }
            try {
                AuthorizationResult granted = Identity.getAuthorizationClient(activity)
                        .getAuthorizationResultFromIntent(result.getData());
                take(granted, done, true);
            } catch (ApiException e) {
                done.answer(problem(e));
            }
        });
    }

    void handle(String action, JSONArray args, Done done) {
        switch (action) {
            case "status":
                done.answer(ok().put("configured", true).put("connected", linked()).put("lasting", true));
                break;
            case "connect":
                authorize(true, done);
                break;
            case "cancel":
                if (waiting != null) waiting.answer(error("cancelled", null));
                waiting = null;
                done.answer(ok());
                break;
            case "token": {
                boolean refused = args != null && args.optBoolean(0);
                if (!refused && token != null && SystemClock.elapsedRealtime() < tokenUntil) {
                    done.answer(tokenAnswer());
                } else {
                    token = null;
                    authorize(false, done);
                }
                break;
            }
            case "disconnect":
                disconnect(done);
                break;
            default:
                done.answer(error("rejected", null));
        }
    }

    private boolean linked() {
        return prefs.getBoolean("linked", false);
    }

    /** Asks Google Play services; with `interactive`, the account sheet may open. */
    private void authorize(boolean interactive, Done done) {
        AuthorizationRequest request = AuthorizationRequest.builder()
                .setRequestedScopes(Collections.singletonList(new Scope(SCOPE)))
                .build();
        Identity.getAuthorizationClient(activity).authorize(request)
                .addOnSuccessListener(result -> {
                    if (!result.hasResolution()) {
                        take(result, done, interactive);
                    } else if (!interactive) {
                        // Withdrawn in the Google account, or never given: the page asks for a click.
                        prefs.edit().putBoolean("linked", false).apply();
                        done.answer(error("unauthorized", null));
                    } else if (result.getPendingIntent() != null) {
                        if (waiting != null) waiting.answer(error("cancelled", null));
                        waiting = done;
                        consent.launch(new IntentSenderRequest.Builder(result.getPendingIntent().getIntentSender()).build());
                    } else {
                        done.answer(error("failed", "keine Zustimmung möglich"));
                    }
                })
                .addOnFailureListener(e -> done.answer(problem(e)));
    }

    private void take(AuthorizationResult result, Done done, boolean connecting) {
        if (!result.getGrantedScopes().contains(new Scope(SCOPE))) {
            done.answer(error("scope", null));
            return;
        }
        token = result.getAccessToken();
        tokenUntil = SystemClock.elapsedRealtime() + TOKEN_LIFE;
        if (token == null) {
            done.answer(error("failed", "kein Zugang erhalten"));
            return;
        }
        if (!linked()) Log.i(MainActivity.TAG, "Google Drive: verbunden");
        prefs.edit().putBoolean("linked", true).apply();
        done.answer(connecting ? ok().put("lasting", true) : tokenAnswer());
    }

    private void disconnect(Done done) {
        String last = token;
        token = null;
        prefs.edit().putBoolean("linked", false).apply();
        if (last == null) {
            done.answer(ok());
            return;
        }
        // Withdrawn at Google as well, so the grant does not linger in the
        // account; offline, the app has let go of it either way.
        network.execute(() -> {
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL("https://oauth2.googleapis.com/revoke").openConnection();
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setConnectTimeout(10_000);
                connection.setReadTimeout(10_000);
                connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(("token=" + URLEncoder.encode(last, "UTF-8")).getBytes(StandardCharsets.UTF_8));
                }
                connection.getResponseCode();
                connection.disconnect();
            } catch (Exception e) {
                Log.w(MainActivity.TAG, "Google Drive: Zurückziehen nicht erreicht");
            }
            Log.i(MainActivity.TAG, "Google Drive: getrennt");
            activity.runOnUiThread(() -> done.answer(ok()));
        });
    }

    private Answer tokenAnswer() {
        // The page's clock: how long the token holds, from now.
        long left = tokenUntil - SystemClock.elapsedRealtime();
        return ok().put("token", token).put("expiresAt", System.currentTimeMillis() + Math.max(0, left));
    }

    private static Answer problem(Exception e) {
        if (e instanceof ApiException) {
            int status = ((ApiException) e).getStatusCode();
            if (status == CommonStatusCodes.DEVELOPER_ERROR) {
                return error("not-configured",
                        "In Google Cloud fehlt der OAuth-Client „Android“ für ch.lizge.sondra mit dem Fingerabdruck dieser App.");
            }
            if (status == CommonStatusCodes.NETWORK_ERROR) return error("offline", null);
            if (status == CommonStatusCodes.CANCELED) return error("cancelled", null);
            if (status == CommonStatusCodes.SIGN_IN_REQUIRED) return error("unauthorized", null);
        }
        Log.w(MainActivity.TAG, "Google Drive: " + e);
        return error("failed", e.getMessage());
    }

    private static Answer ok() {
        return new Answer().put("ok", true);
    }

    private static Answer error(String code, String detail) {
        Answer answer = new Answer().put("ok", false).put("error", code);
        return detail != null ? answer.put("detail", detail) : answer;
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
