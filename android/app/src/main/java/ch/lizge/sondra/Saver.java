package ch.lizge.sondra;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Files the page saves — a conversion, a download, a ZIP — into
 * Downloads/Sondra, where the gallery and the file manager find them.
 *
 * A WebView cannot save a `blob:` address itself, so the page sends the bytes
 * in pieces; each is written before the next is asked for, so a film never
 * has to fit in memory twice. From Android 10 on through MediaStore (no
 * permission), before through the folder itself.
 */
final class Saver {
    interface Done {
        void answer(JSONObject result);
    }

    private static final class Target {
        final String name;
        final Uri uri;
        final File file;
        final OutputStream out;

        Target(String name, Uri uri, File file, OutputStream out) {
            this.name = name;
            this.uri = uri;
            this.file = file;
            this.out = out;
        }
    }

    private final MainActivity activity;
    private final ExecutorService disk = Executors.newSingleThreadExecutor();
    private final Map<Integer, Target> open = new HashMap<>();
    private int next = 1;

    Saver(MainActivity activity) {
        this.activity = activity;
    }

    void begin(String name, String mime, Done done) {
        String clean = cleanName(name);
        String type = mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
        activity.withStorage(() -> disk.execute(() -> {
            try {
                Target target = create(clean, type);
                int handle;
                synchronized (open) {
                    handle = next++;
                    open.put(handle, target);
                }
                reply(done, result(true, null).put("handle", handle));
            } catch (IOException | RuntimeException | JSONException e) {
                Log.w(MainActivity.TAG, "Speichern nicht begonnen: " + e);
                failed(done, clean, e);
            }
        }), () -> reply(done, result(false, "permission")));
    }

    void chunk(int handle, String base64, Done done) {
        disk.execute(() -> {
            Target target;
            synchronized (open) {
                target = open.get(handle);
            }
            if (target == null) {
                reply(done, result(false, "unknown"));
                return;
            }
            try {
                target.out.write(Base64.decode(base64, Base64.DEFAULT));
                reply(done, result(true, null));
            } catch (IOException | IllegalArgumentException e) {
                drop(handle);
                failed(done, target.name, e);
            }
        });
    }

    void end(int handle, Done done) {
        disk.execute(() -> {
            Target target;
            synchronized (open) {
                target = open.remove(handle);
            }
            if (target == null) {
                reply(done, result(false, "unknown"));
                return;
            }
            try {
                target.out.close();
                finish(target);
                Log.i(MainActivity.TAG, "Gespeichert: Downloads/Sondra/" + target.name);
                activity.runOnUiThread(() -> Toast.makeText(activity,
                        activity.getString(R.string.savedTo, target.name), Toast.LENGTH_SHORT).show());
                reply(done, result(true, null).put("where", "Downloads/Sondra/" + target.name));
            } catch (IOException | JSONException e) {
                discard(target);
                failed(done, target.name, e);
            }
        });
    }

    void abort(int handle) {
        disk.execute(() -> drop(handle));
    }

    private void drop(int handle) {
        Target target;
        synchronized (open) {
            target = open.remove(handle);
        }
        if (target != null) discard(target);
    }

    private Target create(String name, String type) throws IOException {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver resolver = activity.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, type);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Sondra");
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("Downloads nicht beschreibbar");
            OutputStream out = resolver.openOutputStream(uri);
            if (out == null) throw new IOException("Downloads nicht beschreibbar");
            return new Target(name, uri, null, out);
        }
        File folder = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Sondra");
        if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("Downloads/Sondra nicht anlegbar");
        File file = free(folder, name);
        return new Target(file.getName(), null, file, new FileOutputStream(file));
    }

    private void finish(Target target) {
        if (target.uri != null) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            activity.getContentResolver().update(target.uri, values, null, null);
        } else if (target.file != null) {
            MediaScannerConnection.scanFile(activity, new String[] {target.file.getAbsolutePath()}, null, null);
        }
    }

    private void discard(Target target) {
        try {
            target.out.close();
        } catch (IOException ignored) {
            // Already broken; it goes either way.
        }
        if (target.uri != null) activity.getContentResolver().delete(target.uri, null, null);
        else if (target.file != null && !target.file.delete()) Log.w(MainActivity.TAG, "Halbe Datei blieb: " + target.file);
    }

    /** „Film.mp4“, else „Film (1).mp4“, as MediaStore does it from Android 10 on. */
    private static File free(File folder, String name) {
        File file = new File(folder, name);
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; file.exists(); i++) file = new File(folder, stem + " (" + i + ")" + ext);
        return file;
    }

    /** What the file systems refuse goes; an empty name becomes „Sondra“. */
    static String cleanName(String name) {
        String clean = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        while (clean.startsWith(".")) clean = clean.substring(1);
        if (clean.length() > 120) {
            int dot = clean.lastIndexOf('.');
            String ext = dot > 0 && clean.length() - dot <= 10 ? clean.substring(dot) : "";
            clean = clean.substring(0, 120 - ext.length()) + ext;
        }
        return clean.isEmpty() ? "Sondra" : clean;
    }

    private void failed(Done done, String name, Exception e) {
        activity.runOnUiThread(() -> Toast.makeText(activity,
                activity.getString(R.string.saveFailed, name), Toast.LENGTH_LONG).show());
        reply(done, result(false, String.valueOf(e.getMessage())));
    }

    private static JSONObject result(boolean ok, String error) {
        JSONObject answer = new JSONObject();
        try {
            answer.put("ok", ok);
            if (error != null) answer.put("error", error);
        } catch (JSONException e) {
            throw new IllegalArgumentException(e);
        }
        return answer;
    }

    private static void reply(Done done, JSONObject answer) {
        done.answer(answer);
    }
}
