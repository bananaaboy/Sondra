package ch.lizge.sondra;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.pm.PackageManager;
import androidx.core.content.ContextCompat;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.widget.Toast;

import androidx.core.app.NotificationCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Native Direct-to-Disk Downloader for Android.
 *
 * Streams remote video and audio files directly to disk (MediaStore.Downloads/Sondra)
 * with a small 64 KB buffer, consuming 0 MB of WebView JavaScript RAM. Runs in
 * background threads with native system notification progress.
 */
final class Downloader {
    private static final String CHANNEL_ID = "sondra_downloads";
    private static final int BUFFER_SIZE = 65536;

    interface Done {
        void done(JSONObject result);
    }

    private static class DownloadTask {
        final int id;
        final String filename;
        final String url;
        volatile boolean cancelled;
        HttpURLConnection connection;

        DownloadTask(int id, String filename, String url) {
            this.id = id;
            this.filename = filename;
            this.url = url;
        }
    }

    private final MainActivity activity;
    private final NotificationManager notificationManager;
    private final ExecutorService pool = Executors.newFixedThreadPool(2);
    private final Map<Integer, DownloadTask> activeTasks = Collections.synchronizedMap(new HashMap<>());
    private final AtomicInteger taskCounter = new AtomicInteger(1000);

    Downloader(MainActivity activity) {
        this.activity = activity;
        this.notificationManager = (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
        createNotificationChannel();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && notificationManager != null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Sondra Downloads",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Fortschritt laufender Mediendownloads in Sondra");
            channel.setShowBadge(false);
            notificationManager.createNotificationChannel(channel);
        }
    }

    void downloadDirect(String urlString, String filename, String mime, String subFolder, Done done) {
        int taskId = taskCounter.incrementAndGet();
        DownloadTask task = new DownloadTask(taskId, cleanName(filename), urlString);
        activeTasks.put(taskId, task);

        activity.setKeepScreenOn(true);

        pool.execute(() -> {
            OutputStream out = null;
            InputStream in = null;
            Uri fileUri = null;
            File targetFile = null;
            long totalWritten = 0;

            try {
                // Open HTTP connection with redirects support
                HttpURLConnection conn = openConnectionWithRedirects(urlString);
                task.connection = conn;

                if (task.cancelled) {
                    throw new IOException("Abgebrochen");
                }

                long contentLength = conn.getContentLengthLong();
                String contentType = mime != null && !mime.isEmpty() ? mime : conn.getContentType();
                if (contentType == null || contentType.isEmpty()) {
                    contentType = "application/octet-stream";
                }

                // Create target file in MediaStore or File
                TargetFile target = createTarget(task.filename, contentType, subFolder);
                fileUri = target.uri;
                targetFile = target.file;
                out = target.out;

                in = conn.getInputStream();
                byte[] buffer = new byte[BUFFER_SIZE];
                int bytesRead;
                long lastNotificationUpdate = 0;

                showProgressNotification(taskId, task.filename, 0, contentLength);

                while (!task.cancelled && (bytesRead = in.read(buffer)) != -1) {
                    out.write(buffer, 0, bytesRead);
                    totalWritten += bytesRead;

                    long now = System.currentTimeMillis();
                    if (now - lastNotificationUpdate > 800) {
                        lastNotificationUpdate = now;
                        showProgressNotification(taskId, task.filename, totalWritten, contentLength);
                    }
                }

                if (task.cancelled) {
                    throw new IOException("Download abgebrochen");
                }

                out.flush();
                out.close();
                out = null;

                finishTarget(target);
                showCompletionNotification(taskId, task.filename, totalWritten);

                Log.i(MainActivity.TAG, "Direct-Download abgeschlossen: " + task.filename + " (" + totalWritten + " Bytes)");
                activity.runOnUiThread(() -> Toast.makeText(activity,
                        activity.getString(R.string.savedTo, task.filename), Toast.LENGTH_SHORT).show());

                String relativeSaved = "Downloads/Sondra/" + (subFolder != null && !subFolder.trim().isEmpty() ? subFolder.trim() + "/" : "") + task.filename;
                reply(done, new JSONObject()
                        .put("ok", true)
                        .put("savedPath", relativeSaved)
                        .put("bytesWritten", totalWritten));

            } catch (Exception e) {
                Log.w(MainActivity.TAG, "Direct-Download fehlgeschlagen (" + task.filename + "): " + e.getMessage());
                if (out != null) {
                    try { out.close(); } catch (IOException ignored) {}
                }
                discardTarget(fileUri, targetFile);
                dismissNotification(taskId);

                if (!task.cancelled) {
                    activity.runOnUiThread(() -> Toast.makeText(activity,
                            activity.getString(R.string.saveFailed, task.filename), Toast.LENGTH_LONG).show());
                }
                reply(done, result(false, e.getMessage()));
            } finally {
                if (in != null) {
                    try { in.close(); } catch (IOException ignored) {}
                }
                activeTasks.remove(taskId);
                if (activeTasks.isEmpty()) {
                    activity.setKeepScreenOn(false);
                }
            }
        });
    }

    void abort(int taskId) {
        DownloadTask task = activeTasks.remove(taskId);
        if (task != null) {
            task.cancelled = true;
            if (task.connection != null) {
                try { task.connection.disconnect(); } catch (Exception ignored) {}
            }
        }
        if (activeTasks.isEmpty()) {
            activity.setKeepScreenOn(false);
        }
    }

    private HttpURLConnection openConnectionWithRedirects(String urlString) throws IOException {
        String currentUrl = urlString;
        for (int redirects = 0; redirects < 6; redirects++) {
            URL url = new URL(currentUrl);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(60000);
            conn.setInstanceFollowRedirects(true);
            conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 SondraAndroid/" + activity.version());
            conn.setRequestProperty("Accept-Encoding", "identity");

            int code = conn.getResponseCode();
            if (code == HttpURLConnection.HTTP_MOVED_PERM ||
                code == HttpURLConnection.HTTP_MOVED_TEMP ||
                code == 307 || code == 308) {
                String location = conn.getHeaderField("Location");
                if (location != null && !location.isEmpty()) {
                    conn.disconnect();
                    currentUrl = location;
                    continue;
                }
            }
            if (code >= 400) {
                throw new IOException("Server-Antwortfehler: HTTP " + code);
            }
            return conn;
        }
        throw new IOException("Zu viele Weiterleitungen");
    }

    private static class TargetFile {
        final String name;
        final Uri uri;
        final File file;
        final OutputStream out;

        TargetFile(String name, Uri uri, File file, OutputStream out) {
            this.name = name;
            this.uri = uri;
            this.file = file;
            this.out = out;
        }
    }

    private TargetFile createTarget(String name, String type, String subFolder) throws IOException {
        String cleanSub = subFolder != null && !subFolder.trim().isEmpty() ? subFolder.trim() : null;
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver resolver = activity.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, type);
            String path = Environment.DIRECTORY_DOWNLOADS + "/Sondra" + (cleanSub != null ? "/" + cleanSub : "");
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, path);
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("Downloads nicht beschreibbar");
            OutputStream out = resolver.openOutputStream(uri);
            if (out == null) throw new IOException("Downloads nicht beschreibbar");
            return new TargetFile(name, uri, null, out);
        }
        File base = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Sondra" + (cleanSub != null ? "/" + cleanSub : ""));
        if (!base.isDirectory() && !base.mkdirs()) throw new IOException("Downloads/Sondra nicht anlegbar");
        File file = freeFile(base, name);
        return new TargetFile(file.getName(), null, file, new FileOutputStream(file));
    }

    private void finishTarget(TargetFile target) {
        if (target.uri != null && Build.VERSION.SDK_INT >= 29) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            activity.getContentResolver().update(target.uri, values, null, null);
        }
    }

    private void discardTarget(Uri uri, File file) {
        if (uri != null) {
            try { activity.getContentResolver().delete(uri, null, null); } catch (Exception ignored) {}
        }
        if (file != null) {
            try { file.delete(); } catch (Exception ignored) {}
        }
    }

    private boolean canPostNotifications() {
        if (notificationManager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS)
                    == PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    @SuppressLint("MissingPermission")
    private void showProgressNotification(int id, String filename, long loaded, long total) {
        if (!canPostNotifications()) return;
        try {
            NotificationCompat.Builder b = new NotificationCompat.Builder(activity, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_sys_download)
                    .setContentTitle(filename)
                    .setOngoing(true)
                    .setOnlyAlertOnce(true);

            if (total > 0) {
                int percent = (int) Math.min(100, Math.max(0, (loaded * 100) / total));
                b.setProgress(100, percent, false);
                b.setContentText("Lädt herunter … " + percent + "% (" + formatBytes(loaded) + " / " + formatBytes(total) + ")");
            } else {
                b.setProgress(0, 0, true);
                b.setContentText("Lädt herunter … " + formatBytes(loaded));
            }
            notificationManager.notify(id, b.build());
        } catch (Exception ignored) {}
    }

    @SuppressLint("MissingPermission")
    private void showCompletionNotification(int id, String filename, long total) {
        if (!canPostNotifications()) return;
        try {
            NotificationCompat.Builder b = new NotificationCompat.Builder(activity, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setContentTitle("Download abgeschlossen")
                    .setContentText(filename + " (" + formatBytes(total) + ")")
                    .setOngoing(false)
                    .setAutoCancel(true);
            notificationManager.notify(id, b.build());
        } catch (Exception ignored) {}
    }

    private void dismissNotification(int id) {
        if (notificationManager != null) {
            try { notificationManager.cancel(id); } catch (Exception ignored) {}
        }
    }

    private static String formatBytes(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format(java.util.Locale.US, "%.1f KB", bytes / 1024.0);
        if (bytes < 1024 * 1024 * 1024) return String.format(java.util.Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0));
        return String.format(java.util.Locale.US, "%.2f GB", bytes / (1024.0 * 1024.0 * 1024.0));
    }

    private static String cleanName(String name) {
        if (name == null || name.trim().isEmpty()) return "sondra-datei";
        return name.replace('/', '_').replace('\\', '_');
    }

    private static File freeFile(File folder, String name) {
        File file = new File(folder, name);
        if (!file.exists()) return file;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            File candidate = new File(folder, base + " (" + i + ")" + ext);
            if (!candidate.exists()) return candidate;
        }
        return file;
    }

    private static JSONObject result(boolean ok, String error) {
        try {
            JSONObject out = new JSONObject().put("ok", ok);
            if (error != null) out.put("error", error);
            return out;
        } catch (JSONException e) {
            throw new RuntimeException(e);
        }
    }

    private void reply(Done done, JSONObject result) {
        activity.runOnUiThread(() -> done.done(result));
    }
}
