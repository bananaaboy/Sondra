package ch.lizge.sondra;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Log;
import android.webkit.MimeTypeMap;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLException;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.YoutubeDLResponse;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

import kotlin.Unit;

/**
 * Downloading as the Windows app does: yt-dlp on the device.
 *
 * The Windows app runs yt-dlp on the user's own machine (desktop/downloader.mjs),
 * so every site yt-dlp knows loads in full resolution. On the phone the page
 * had only the website's resolver — YouTube at 360p, many sites not at all.
 * youtubedl-android brings yt-dlp with its own Python and FFmpeg; it is
 * unpacked on first use, not at the start of the app, and yt-dlp is brought
 * up to date from its GitHub releases once a week, as the Windows app does —
 * the sites change faster than Sondra is released.
 *
 * A download is written to the app's cache, merged there by FFmpeg, then
 * handed to Downloads/Sondra and the cache cleared. Progress goes to the page
 * as `ytdlp` events and to a notification, so it can be followed with the
 * app in the background.
 */
final class YtDlp {
    interface Done {
        void done(JSONObject result);
    }

    private static final String TAG = MainActivity.TAG;
    private static final String CHANNEL_ID = "sondra_ytdlp";
    private static final String PREFS = "ytdlp";
    private static final long UPDATE_EVERY_MS = 7L * 24 * 60 * 60 * 1000;

    private final MainActivity activity;
    private final Bridge bridge;
    private final NotificationManager notifications;
    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    private final Set<String> cancelled = Collections.newSetFromMap(new ConcurrentHashMap<>());
    private final AtomicInteger notificationIds = new AtomicInteger(5000);
    private final Object readyLock = new Object();
    private boolean ready;

    YtDlp(MainActivity activity, Bridge bridge) {
        this.activity = activity;
        this.bridge = bridge;
        this.notifications = (NotificationManager) activity.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && notifications != null) {
            notifications.createNotificationChannel(new NotificationChannel(
                    CHANNEL_ID, "Herunterladen mit yt-dlp", NotificationManager.IMPORTANCE_LOW));
        }
    }

    /** Unpacks Python, yt-dlp and FFmpeg once, and brings yt-dlp up to date once a week. */
    private void ensureReady() throws YoutubeDLException {
        synchronized (readyLock) {
            if (ready) return;
            Context context = activity.getApplicationContext();
            YoutubeDL.getInstance().init(context);
            FFmpeg.getInstance().init(context);
            ready = true;
            Log.i(TAG, "yt-dlp bereit: " + YoutubeDL.getInstance().versionName(context));
        }
        SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long last = prefs.getLong("updatedAt", 0);
        if (System.currentTimeMillis() - last > UPDATE_EVERY_MS) {
            try {
                YoutubeDL.getInstance().updateYoutubeDL(activity.getApplicationContext(), YoutubeDL.UpdateChannel._STABLE);
                prefs.edit().putLong("updatedAt", System.currentTimeMillis()).apply();
                Log.i(TAG, "yt-dlp aktualisiert: " + YoutubeDL.getInstance().versionName(activity.getApplicationContext()));
            } catch (Exception e) {
                // The bundled one still works; next time again.
                Log.w(TAG, "yt-dlp nicht aktualisiert: " + e.getMessage());
            }
        }
    }

    /** What lies behind an address: title, length, picture, and the heights it comes in. */
    void info(String url, Done done) {
        pool.execute(() -> {
            try {
                ensureReady();
                YoutubeDLRequest request = new YoutubeDLRequest(url);
                request.addOption("--dump-single-json");
                request.addOption("--no-playlist");
                request.addOption("--no-warnings");
                YoutubeDLResponse response = YoutubeDL.getInstance().execute(request, null, null);
                JSONObject json = new JSONObject(response.getOut());
                TreeSet<Integer> heights = new TreeSet<>(Collections.reverseOrder());
                boolean video = false;
                JSONArray formats = json.optJSONArray("formats");
                if (formats != null) {
                    for (int i = 0; i < formats.length(); i++) {
                        JSONObject format = formats.optJSONObject(i);
                        if (format == null) continue;
                        String vcodec = format.optString("vcodec", "none");
                        int height = format.optInt("height", 0);
                        if (!"none".equals(vcodec) && height > 0) {
                            video = true;
                            heights.add(height);
                        }
                    }
                }
                if (!video && json.optInt("height", 0) > 0) {
                    video = true;
                    heights.add(json.optInt("height"));
                }
                JSONArray list = new JSONArray();
                for (int height : heights) list.put(height);
                reply(done, new JSONObject()
                        .put("ok", true)
                        .put("title", json.optString("title", ""))
                        .put("uploader", json.optString("uploader", json.optString("channel", "")))
                        .put("duration", json.optDouble("duration", 0))
                        .put("thumbnail", json.optString("thumbnail", ""))
                        .put("extractor", json.optString("extractor_key", json.optString("extractor", "")))
                        .put("video", video)
                        .put("heights", list));
            } catch (Exception e) {
                Log.w(TAG, "yt-dlp (Info): " + e.getMessage());
                reply(done, failure(e));
            }
        });
    }

    /**
     * Starts a download and answers at once with its id; how it goes comes as
     * `ytdlp` events: running with a percentage, then done, failed or cancelled.
     */
    void download(String url, String mode, int height, String audioFormat, String title, Done done) {
        String job = "y" + System.currentTimeMillis() + "-" + notificationIds.incrementAndGet();
        int notification = notificationIds.incrementAndGet();
        try {
            reply(done, new JSONObject().put("ok", true).put("job", job));
        } catch (JSONException ignored) {}
        String label = title != null && !title.trim().isEmpty() ? title.trim() : url;
        pool.execute(() -> {
            File folder = new File(activity.getCacheDir(), "ytdlp/" + job);
            try {
                ensureReady();
                if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("Zwischenablage nicht anlegbar");
                YoutubeDLRequest request = new YoutubeDLRequest(url);
                request.addOption("-o", folder.getAbsolutePath() + "/%(title).120B.%(ext)s");
                request.addOption("--no-playlist");
                request.addOption("--no-mtime");
                request.addOption("--newline");
                request.addOption("--no-warnings");
                if ("audio".equals(mode)) {
                    String format = "mp3".equals(audioFormat) || "opus".equals(audioFormat) ? audioFormat : "m4a";
                    request.addOption("-f", "ba/b");
                    request.addOption("-x");
                    request.addOption("--audio-format", format);
                    request.addOption("--audio-quality", "0");
                } else {
                    // The highest up to the chosen height, as MP4 with AAC where
                    // the site has it — what every phone plays.
                    request.addOption("-f", "bv*+ba/b");
                    request.addOption("-S", (height > 0 ? "res:" + height + "," : "") + "ext:mp4:m4a");
                    request.addOption("--merge-output-format", "mp4");
                }
                progress(job, notification, label, 0, -1, "Wird vorbereitet …");
                final long[] lastTell = {0};
                YoutubeDL.getInstance().execute(request, job, (percent, eta, line) -> {
                    long now = System.currentTimeMillis();
                    if (now - lastTell[0] > 600) {
                        lastTell[0] = now;
                        progress(job, notification, label, percent, eta, line);
                    }
                    return Unit.INSTANCE;
                });
                if (cancelled.remove(job)) throw new YoutubeDL.CanceledException();
                File file = largestIn(folder);
                if (file == null) throw new IOException("yt-dlp hat keine Datei geschrieben.");
                progress(job, notification, label, 100, 0, "Wird in Downloads gelegt …");
                String saved = intoDownloads(file);
                finish(job, notification, "done", file.getName(), saved, null);
            } catch (YoutubeDL.CanceledException e) {
                finish(job, notification, "cancelled", null, null, null);
            } catch (Exception e) {
                boolean wasCancelled = cancelled.remove(job);
                if (wasCancelled) {
                    finish(job, notification, "cancelled", null, null, null);
                } else {
                    Log.w(TAG, "yt-dlp (Laden): " + e.getMessage());
                    finish(job, notification, "error", null, null, reason(e));
                }
            } finally {
                deleteAll(folder);
            }
        });
    }

    void cancel(String job) {
        cancelled.add(job);
        try {
            YoutubeDL.getInstance().destroyProcessById(job);
        } catch (Exception ignored) {}
    }

    /* ---------------------------------------------------------------- */

    private void progress(String job, int notification, String label, float percent, long eta, String line) {
        try {
            bridge.tellEvent(new JSONObject()
                    .put("event", "ytdlp")
                    .put("job", job)
                    .put("status", "running")
                    .put("progress", Math.max(0, Math.min(100, percent)))
                    .put("eta", eta)
                    .put("line", line != null ? line : ""));
        } catch (JSONException ignored) {}
        notify(notification, label, percent, false, null);
    }

    private void finish(String job, int notification, String status, String name, String saved, String error) {
        try {
            JSONObject event = new JSONObject().put("event", "ytdlp").put("job", job).put("status", status);
            if (name != null) event.put("name", name);
            if (saved != null) event.put("savedPath", saved);
            if (error != null) event.put("error", error);
            bridge.tellEvent(event);
        } catch (JSONException ignored) {}
        if ("done".equals(status)) notify(notification, name, 100, true, "In Downloads/Sondra gespeichert");
        else if ("error".equals(status)) notify(notification, "Nicht geladen", 0, true, error);
        else if (notifications != null) notifications.cancel(notification);
    }

    @SuppressLint("MissingPermission")
    private void notify(int id, String title, float percent, boolean finished, String text) {
        if (notifications == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return;
        try {
            NotificationCompat.Builder builder = new NotificationCompat.Builder(activity, CHANNEL_ID)
                    .setSmallIcon(finished ? android.R.drawable.stat_sys_download_done : android.R.drawable.stat_sys_download)
                    .setContentTitle(title)
                    .setOnlyAlertOnce(true)
                    .setOngoing(!finished)
                    .setAutoCancel(finished);
            if (finished) {
                if (text != null) builder.setContentText(text);
            } else if (percent > 0) {
                builder.setProgress(100, Math.round(percent), false).setContentText(Math.round(percent) + " %");
            } else {
                builder.setProgress(0, 0, true).setContentText("Wird vorbereitet …");
            }
            notifications.notify(id, builder.build());
        } catch (Exception ignored) {}
    }

    /** The finished file: the largest in its folder (yt-dlp leaves at most a thumbnail beside it). */
    private static File largestIn(File folder) {
        File[] files = folder.listFiles();
        if (files == null) return null;
        File best = null;
        for (File file : files) {
            if (!file.isFile() || file.getName().endsWith(".part") || file.getName().endsWith(".ytdl")) continue;
            if (best == null || file.length() > best.length()) best = file;
        }
        return best;
    }

    /** Copies the file into Downloads/Sondra; returns where it went, in words. */
    private String intoDownloads(File source) throws IOException {
        String name = source.getName();
        String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (mime == null) mime = "application/octet-stream";
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver resolver = activity.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Sondra");
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("Downloads nicht beschreibbar");
            try (InputStream in = new FileInputStream(source); OutputStream out = resolver.openOutputStream(uri)) {
                if (out == null) throw new IOException("Downloads nicht beschreibbar");
                copy(in, out);
            } catch (IOException e) {
                resolver.delete(uri, null, null);
                throw e;
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(uri, done, null, null);
            return "Downloads/Sondra/" + name;
        }
        File base = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Sondra");
        if (!base.isDirectory() && !base.mkdirs()) throw new IOException("Downloads/Sondra nicht anlegbar");
        File target = new File(base, name);
        for (int i = 1; target.exists() && i < 1000; i++) {
            int dot = name.lastIndexOf('.');
            target = new File(base, (dot > 0 ? name.substring(0, dot) : name) + " (" + i + ")" + (dot > 0 ? name.substring(dot) : ""));
        }
        try (InputStream in = new FileInputStream(source); OutputStream out = new FileOutputStream(target)) {
            copy(in, out);
        }
        return "Downloads/Sondra/" + target.getName();
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[65536];
        int read;
        while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
    }

    private static void deleteAll(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteAll(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    /** yt-dlp's own reason: its last „ERROR:“ line, without the prefix. */
    private static String reason(Exception e) {
        String text = e.getMessage() != null ? e.getMessage() : e.toString();
        List<String> errors = new ArrayList<>();
        for (String line : text.split("\n")) {
            String trimmed = line.trim();
            if (trimmed.startsWith("ERROR:")) errors.add(trimmed.substring(6).trim());
        }
        String found = errors.isEmpty() ? text.trim() : errors.get(errors.size() - 1);
        return found.length() > 400 ? found.substring(0, 400) + " …" : found;
    }

    private static JSONObject failure(Exception e) {
        try {
            return new JSONObject().put("ok", false).put("error", reason(e));
        } catch (JSONException x) {
            throw new RuntimeException(x);
        }
    }

    private void reply(Done done, JSONObject result) {
        activity.runOnUiThread(() -> done.done(result));
    }
}
