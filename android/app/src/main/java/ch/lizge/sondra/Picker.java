package ch.lizge.sondra;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.webkit.WebChromeClient.FileChooserParams;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The page's file picker as Android's own: one file, several, or a whole
 * folder (`webkitdirectory`, the „Ordner“ page), whose files the page then
 * gets as if picked one by one.
 */
final class Picker {
    /** FileChooserParams' folder mode; public in the platform, hidden in the SDK. */
    private static final int MODE_OPEN_FOLDER = 2;

    private Picker() {}

    // WebView reports `webkitdirectory` with the folder mode the SDK hides.
    @SuppressLint("WrongConstant")
    static Intent intent(FileChooserParams params) {
        if (params.getMode() == MODE_OPEN_FOLDER) {
            return new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
        String[] types = acceptedTypes(params.getAcceptTypes());
        if (types.length == 1) {
            intent.setType(types[0]);
        } else {
            intent.setType("*/*");
            if (types.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
        }
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
        return intent;
    }

    /** `accept` as the page wrote it — „video/*,.mkv“ — as types Android filters by. */
    private static String[] acceptedTypes(String[] accept) {
        List<String> types = new ArrayList<>();
        if (accept != null) {
            for (String entry : accept) {
                for (String part : entry.split(",")) {
                    String type = part.trim().toLowerCase(Locale.ROOT);
                    if (type.isEmpty()) continue;
                    if (type.startsWith(".")) {
                        // An extension: Android filters by type, so anything goes.
                        return new String[0];
                    }
                    if (!types.contains(type)) types.add(type);
                }
            }
        }
        return types.toArray(new String[0]);
    }

    static Uri[] uris(Context context, int resultCode, Intent data) {
        if (resultCode != Activity.RESULT_OK || data == null) return null;
        Uri tree = data.getData();
        if (tree != null && DocumentsContract.isTreeUri(tree)) return folder(context, tree);
        ClipData clip = data.getClipData();
        if (clip != null) {
            Uri[] out = new Uri[clip.getItemCount()];
            for (int i = 0; i < out.length; i++) out[i] = clip.getItemAt(i).getUri();
            return out;
        }
        return tree != null ? new Uri[] {tree} : null;
    }

    /** Every file in the folder and below it, at most 5000. */
    private static Uri[] folder(Context context, Uri tree) {
        List<Uri> files = new ArrayList<>();
        List<String> pending = new ArrayList<>();
        pending.add(DocumentsContract.getTreeDocumentId(tree));
        String[] columns = {DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_MIME_TYPE};
        while (!pending.isEmpty() && files.size() < 5000) {
            String parent = pending.remove(pending.size() - 1);
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent);
            try (Cursor cursor = context.getContentResolver().query(children, columns, null, null, null)) {
                if (cursor == null) continue;
                while (cursor.moveToNext()) {
                    String id = cursor.getString(0);
                    if (DocumentsContract.Document.MIME_TYPE_DIR.equals(cursor.getString(1))) pending.add(id);
                    else files.add(DocumentsContract.buildDocumentUriUsingTree(tree, id));
                }
            } catch (RuntimeException e) {
                // A folder that cannot be read is skipped; the rest still come.
            }
        }
        return files.toArray(new Uri[0]);
    }
}
