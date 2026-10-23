package ch.lizge.sondra;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * A static shortcut lands here (Android adds NEW_TASK | CLEAR_TASK to it);
 * the address goes on to the running Sondra, which switches to that tool
 * without starting over.
 */
public class ShortcutActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent intent = new Intent(this, MainActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .setData(getIntent().getData())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(intent);
        finish();
    }
}
