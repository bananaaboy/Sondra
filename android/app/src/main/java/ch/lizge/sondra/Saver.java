package ch.lizge.sondra;

import android.content.ContentResolver;
import android.content.ContentValues;
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
 * Saves a file from the page into Downloads/Sondra.
 *
 * A WebView cannot open a `blob:` address for download, so the page sends the
 * bytes in pieces through the bridge.
 *
 * From Android 10 on, MediaStore puts files into Downloads without a storage
 * permission; on Android 9 and older the app asks for it before starting.
 */
final class Saver {
    interface Done {
        void done(JSONObject result);
    }

    private static class Target {
        final String name;
        /** Under Downloads/Sondra: „Staffel 1“ for a file from a folder that was sent, else empty. */
        final String dir;
        final Uri uri;
        final File file;
        final OutputStream out;

        Target(String name, String dir, Uri uri, File file, OutputStream out) {
            this.name = name;
            this.dir = dir;
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

    void begin(String name, String mime, String dir, Done done) {
        String clean = cleanName(name);
        String sub = cleanDir(dir);
        String type = mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
        activity.withStorage(() -> disk.execute(() -> {
            try {
                Target target = create(clean, sub, type);
                int handle;
                synchronized (open) {
                    handle = next++;
                    open.put(handle, target);
                }
                activity.setKeepScreenOn(true);
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
            boolean empty;
            synchronized (open) {
                target = open.remove(handle);
                empty = open.isEmpty();
            }
            if (empty) activity.setKeepScreenOn(false);
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
                reply(done, result(true, null).put("where", "Downloads/Sondra/" + target.dir + target.name));
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
        boolean empty;
        synchronized (open) {
            target = open.remove(handle);
            empty = open.isEmpty();
        }
        if (target != null) discard(target);
        if (empty) activity.setKeepScreenOn(false);
    }

    private Target create(String name, String sub, String type) throws IOException {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver resolver = activity.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            values.put(MediaStore.MediaColumns.MIME_TYPE, type);
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Sondra" + (sub.isEmpty() ? "" : "/" + sub));
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("Downloads nicht beschreibbar");
            OutputStream out = resolver.openOutputStream(uri);
            if (out == null) throw new IOException("Downloads nicht beschreibbar");
            return new Target(name, sub.isEmpty() ? "" : sub + "/", uri, null, out);
        }
        File folder = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Sondra" + (sub.isEmpty() ? "" : "/" + sub));
        if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("Downloads/Sondra nicht anlegbar");
        File file = free(folder, name);
        return new Target(file.getName(), sub.isEmpty() ? "" : sub + "/", null, file, new FileOutputStream(file));
    }

    private void finish(Target target) {
        if (target.uri != null) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            activity.getContentResolver().update(target.uri, values, null, null);
        }
    }

    private void discard(Target target) {
        try {
            target.out.close();
        } catch (IOException ignored) {}
        if (target.uri != null) activity.getContentResolver().delete(target.uri, null, null);
        if (target.file != null) target.file.delete();
    }

    /**
     * A folder inside Downloads/Sondra as the page names it („Anime/Staffel 1“):
     * each part cleaned like a file name, nothing that climbs out (`..`) or
     * stands for the current place (`.`), at most eight deep.
     */
    private static String cleanDir(String dir) {
        if (dir == null || dir.trim().isEmpty()) return "";
        StringBuilder out = new StringBuilder();
        int depth = 0;
        for (String part : dir.split("/")) {
            String clean = cleanName(part).trim();
            if (part.trim().isEmpty() || part.trim().equals(".") || part.trim().equals("..") || clean.isEmpty()) continue;
            if (++depth > 8) break;
            if (out.length() > 0) out.append('/');
            out.append(clean);
        }
        return out.toString();
    }

    private static String cleanName(String name) {
        if (name == null || name.trim().isEmpty()) return "sondra-datei";
        return name.replace('/', '_').replace('\\', '_');
    }

    private static File free(File folder, String name) {
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

    private void failed(Done done, String name, Exception e) {
        activity.runOnUiThread(() -> Toast.makeText(activity,
                activity.getString(R.string.saveFailed, name), Toast.LENGTH_LONG).show());
        reply(done, result(false, e.getMessage()));
    }

    private void reply(Done done, JSONObject result) {
        activity.runOnUiThread(() -> done.done(result));
    }
}
