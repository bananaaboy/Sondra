package ch.lizge.sondra;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Scanner;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Android Auto-Updater for Sondra:
 * Checks GitHub Releases API for new APK releases, downloads updates in the background
 * with progress reporting, verifies package integrity, and triggers installation via FileProvider.
 */
final class Updater {
    private static final String GITHUB_API_URL = "https://api.github.com/repos/bananaaboy/Sondra/releases/latest";
    private static final String CHANNEL = "apk";

    interface Callback {
        void onResult(JSONObject state);
    }

    private final MainActivity activity;
    private final Bridge bridge;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private final String currentVersion;
    private String latestVersion = null;
    private String downloadUrl = null;
    private String releaseNotes = null;
    private long assetSize = 0;

    private String status = "idle"; // idle, checking, current, available, downloading, ready, error
    private int progressPercent = 0;
    private String errorMessage = null;
    private File downloadedApk = null;

    Updater(MainActivity activity, Bridge bridge) {
        this.activity = activity;
        this.bridge = bridge;
        this.currentVersion = activity.version();
    }

    JSONObject getState() {
        JSONObject state = new JSONObject();
        try {
            state.put("status", status);
            state.put("version", currentVersion);
            state.put("channel", CHANNEL);
            if (latestVersion != null) state.put("next", latestVersion);
            if ("downloading".equals(status)) state.put("percent", progressPercent);
            if ("error".equals(status) && errorMessage != null) state.put("message", errorMessage);
            if (downloadUrl != null) state.put("download", downloadUrl);
            if (releaseNotes != null) state.put("notes", releaseNotes);
        } catch (JSONException ignored) {}
        return state;
    }

    private void publish(String newStatus, String error) {
        this.status = newStatus;
        this.errorMessage = error;
        JSONObject state = getState();
        mainHandler.post(() -> bridge.tellUpdate(state));
    }

    /**
     * Checks GitHub API for updates.
     */
    void checkForUpdates(boolean userInitiated, Callback callback) {
        if ("downloading".equals(status)) {
            if (callback != null) callback.onResult(getState());
            return;
        }

        publish("checking", null);
        if (callback != null) callback.onResult(getState());

        executor.execute(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(GITHUB_API_URL);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setRequestProperty("User-Agent", "Sondra-Android/" + currentVersion);
                conn.setRequestProperty("Accept", "application/vnd.github.v3+json");
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(15000);

                int code = conn.getResponseCode();
                if (code != 200) {
                    throw new Exception("GitHub API HTTP " + code);
                }

                String responseBody;
                try (InputStream in = conn.getInputStream();
                     Scanner scanner = new Scanner(in, StandardCharsets.UTF_8.name())) {
                    responseBody = scanner.useDelimiter("\\A").hasNext() ? scanner.next() : "";
                }

                JSONObject release = new JSONObject(responseBody);
                String tag = release.optString("tag_name", "").trim();
                String rawVersion = tag.startsWith("v") || tag.startsWith("V") ? tag.substring(1) : tag;
                latestVersion = rawVersion;
                releaseNotes = release.optString("body", "");

                // Locate the APK asset: the one built for this device's
                // processor (smaller than the universal one), else the universal
                // Sondra-Android.apk, else any APK. The device's processor is
                // the first it lists, which is what the installed app runs on
                // whichever of them it was installed from.
                JSONArray assets = release.optJSONArray("assets");
                downloadUrl = null;
                assetSize = 0;
                String own = Build.SUPPORTED_ABIS.length > 0
                        ? "Sondra-Android-" + Build.SUPPORTED_ABIS[0] + ".apk" : "";
                int best = Integer.MAX_VALUE;
                if (assets != null) {
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject asset = assets.getJSONObject(i);
                        String name = asset.optString("name", "");
                        int rank = name.equals(own) ? 0
                                : name.equals("Sondra-Android.apk") ? 1
                                : name.endsWith(".apk") ? 2 : Integer.MAX_VALUE;
                        if (rank < best) {
                            best = rank;
                            downloadUrl = asset.optString("browser_download_url");
                            assetSize = asset.optLong("size", 0);
                        }
                    }
                }

                if (downloadUrl == null) {
                    throw new Exception("Keine APK im neuesten Release gefunden.");
                }

                if (isNewer(latestVersion, currentVersion)) {
                    // Check if APK was already downloaded in cache
                    File cached = getTargetApkFile(latestVersion);
                    if (cached.exists() && isValidApk(cached)) {
                        downloadedApk = cached;
                        publish("ready", null);
                    } else {
                        publish("available", null);
                    }
                    Log.i(MainActivity.TAG, "Update verfügbar: " + latestVersion);
                } else {
                    publish("current", null);
                    Log.i(MainActivity.TAG, "Sondra ist aktuell: " + currentVersion);
                }
            } catch (Exception e) {
                Log.w(MainActivity.TAG, "Update-Prüfung fehlgeschlagen: " + e.getMessage());
                publish("error", e.getMessage());
                if (userInitiated) {
                    mainHandler.post(() -> Toast.makeText(activity, "Update-Suche nicht möglich", Toast.LENGTH_SHORT).show());
                }
            } finally {
                if (conn != null) conn.disconnect();
                if (callback != null) {
                    mainHandler.post(() -> callback.onResult(getState()));
                }
            }
        });
    }

    /**
     * Downloads the APK file with progress tracking.
     */
    void startDownload(Callback callback) {
        if (downloadUrl == null || latestVersion == null) {
            publish("error", "Keine Download-Adresse vorhanden");
            if (callback != null) callback.onResult(getState());
            return;
        }

        File targetApk = getTargetApkFile(latestVersion);
        if (targetApk.exists() && isValidApk(targetApk)) {
            downloadedApk = targetApk;
            publish("ready", null);
            if (callback != null) callback.onResult(getState());
            return;
        }

        publish("downloading", null);
        progressPercent = 0;
        if (callback != null) callback.onResult(getState());

        activity.setKeepScreenOn(true); // Keep screen awake during APK download

        executor.execute(() -> {
            File tempApk = new File(targetApk.getAbsolutePath() + ".tmp");
            HttpURLConnection conn = null;
            try {
                URL url = new URL(downloadUrl);
                conn = (HttpURLConnection) url.openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", "Sondra-Android/" + currentVersion);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(30000);

                int status = conn.getResponseCode();
                if (status == HttpURLConnection.HTTP_MOVED_TEMP || status == HttpURLConnection.HTTP_MOVED_PERM || status == 307) {
                    String redirectUrl = conn.getHeaderField("Location");
                    conn.disconnect();
                    conn = (HttpURLConnection) new URL(redirectUrl).openConnection();
                }

                long totalSize = conn.getContentLengthLong();
                if (totalSize <= 0 && assetSize > 0) totalSize = assetSize;

                File parent = tempApk.getParentFile();
                if (parent != null && !parent.exists()) parent.mkdirs();

                try (InputStream in = conn.getInputStream();
                     OutputStream out = new FileOutputStream(tempApk)) {
                    byte[] buffer = new byte[16384];
                    long downloaded = 0;
                    int read;
                    long lastBroadcast = 0;

                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                        downloaded += read;
                        if (totalSize > 0) {
                            int pct = (int) ((downloaded * 100) / totalSize);
                            long now = System.currentTimeMillis();
                            if (pct != progressPercent && (now - lastBroadcast > 300 || pct == 100)) {
                                progressPercent = pct;
                                lastBroadcast = now;
                                JSONObject current = getState();
                                mainHandler.post(() -> bridge.tellUpdate(current));
                            }
                        }
                    }
                    out.flush();
                }

                if (tempApk.renameTo(targetApk) && isValidApk(targetApk)) {
                    downloadedApk = targetApk;
                    publish("ready", null);
                    Log.i(MainActivity.TAG, "Update heruntergeladen: " + targetApk.getAbsolutePath());
                } else {
                    tempApk.delete();
                    throw new Exception("Heruntergeladene APK ungültig oder beschädigt.");
                }
            } catch (Exception e) {
                Log.w(MainActivity.TAG, "Download fehlgeschlagen: " + e.getMessage());
                if (tempApk.exists()) tempApk.delete();
                publish("error", e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
                activity.setKeepScreenOn(false);
                if (callback != null) mainHandler.post(() -> callback.onResult(getState()));
            }
        });
    }

    /**
     * Launches the system package installer for the downloaded APK.
     */
    boolean installUpdate() {
        if (downloadedApk == null || !downloadedApk.exists() || !isValidApk(downloadedApk)) {
            publish("error", "Keine installierbare APK-Datei gefunden.");
            return false;
        }

        // On Android 8.0+ (API 26+), check unknown sources permission
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (!activity.getPackageManager().canRequestPackageInstalls()) {
                mainHandler.post(() -> {
                    Toast.makeText(activity, "Bitte erlauben Sie Sondra das Installieren von Updates.", Toast.LENGTH_LONG).show();
                    Intent settingsIntent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + activity.getPackageName()));
                    activity.startActivity(settingsIntent);
                });
                return false;
            }
        }

        try {
            Uri apkUri = FileProvider.getUriForFile(
                    activity,
                    activity.getPackageName() + ".fileprovider",
                    downloadedApk
            );

            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(apkUri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(install);
            Log.i(MainActivity.TAG, "Installationsdialog gestartet.");
            return true;
        } catch (Exception e) {
            Log.e(MainActivity.TAG, "Installation konnte nicht gestartet werden: " + e.getMessage());
            publish("error", "Installationsfehler: " + e.getMessage());
            return false;
        }
    }

    private File getTargetApkFile(String version) {
        File dir = new File(activity.getCacheDir(), "updates");
        return new File(dir, "Sondra-Android-" + version + ".apk");
    }

    private boolean isValidApk(File file) {
        try {
            PackageManager pm = activity.getPackageManager();
            PackageInfo info = pm.getPackageArchiveInfo(file.getAbsolutePath(), 0);
            return info != null && activity.getPackageName().equals(info.packageName);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Semantic version comparison: returns true if candidate is newer than current.
     */
    static boolean isNewer(String candidate, String base) {
        if (candidate == null || base == null) return false;
        String[] cParts = candidate.replaceAll("[^0-9.]", "").split("\\.");
        String[] bParts = base.replaceAll("[^0-9.]", "").split("\\.");
        int length = Math.max(cParts.length, bParts.length);

        for (int i = 0; i < length; i++) {
            int c = i < cParts.length && !cParts[i].isEmpty() ? Integer.parseInt(cParts[i]) : 0;
            int b = i < bParts.length && !bParts[i].isEmpty() ? Integer.parseInt(bParts[i]) : 0;
            if (c > b) return true;
            if (c < b) return false;
        }
        return false;
    }
}
