package ch.lizge.sondra;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.SystemBarStyle;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.webkit.ServiceWorkerClientCompat;
import androidx.webkit.ServiceWorkerControllerCompat;
import androidx.webkit.WebViewFeature;

/**
 * Sondra: the website in the app's own WebView, full screen between the
 * system bars, with the parts a page cannot do itself handed to the app
 * ({@link Bridge} and {@link Updater}). Only sondra.lizge.ch stays inside;
 * every other address goes to the browser.
 */
public class MainActivity extends ComponentActivity {
    static final String TAG = "SondraApp";
    static final String HOST = "sondra.lizge.ch";
    static final String ORIGIN = "https://" + HOST;

    private FrameLayout root;
    private WebView webView;
    private View offline;
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenDone;
    private Bridge bridge;
    private Updater updater;
    private boolean drawn;
    private boolean pageDark;
    private int wakeLockCount = 0;
    private int previousOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;

    private ValueCallback<Uri[]> pickDone;
    private PermissionRequest micRequest;
    private Runnable afterStorage;
    private Runnable storageDenied;

    /** Pauses media immediately when headphones or Bluetooth audio are disconnected. */
    private final BroadcastReceiver noisyAudioReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction()) && webView != null) {
                Log.i(TAG, "Audio Becoming Noisy: Pausiere Wiedergabe");
                webView.evaluateJavascript("document.querySelectorAll('video, audio').forEach(el => el.pause());", null);
            }
        }
    };

    private final ActivityResultLauncher<Intent> picker =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                ValueCallback<Uri[]> done = pickDone;
                pickDone = null;
                if (done != null) done.onReceiveValue(Picker.uris(this, result.getResultCode(), result.getData()));
            });

    private final ActivityResultLauncher<String> micPermission =
            registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
                PermissionRequest request = micRequest;
                micRequest = null;
                if (request == null) return;
                if (granted) request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                else {
                    request.deny();
                    Toast.makeText(this, R.string.micDenied, Toast.LENGTH_LONG).show();
                }
            });

    private final ActivityResultLauncher<String> storagePermission =
            registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
                Runnable next = granted ? afterStorage : storageDenied;
                afterStorage = null;
                storageDenied = null;
                if (!granted) Toast.makeText(this, R.string.storageDenied, Toast.LENGTH_LONG).show();
                if (next != null) next.run();
            });

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Enforce hardware acceleration on the window level for fluid 60fps canvas & video
        getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);

        SplashScreen splash = SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);
        long started = SystemClock.uptimeMillis();
        // The icon stays until the page has drawn, at most four seconds.
        splash.setKeepOnScreenCondition(() -> !drawn && SystemClock.uptimeMillis() - started < 4000);

        pageDark = systemDark();
        applyBars();

        root = new FrameLayout(this);
        setContentView(root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            // The page between the bars and above the keyboard; in full screen, all of it.
            Insets bars = fullscreen != null
                    ? Insets.NONE
                    : insets.getInsets(WindowInsetsCompat.Type.systemBars()
                            | WindowInsetsCompat.Type.displayCutout()
                            | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        bridge = new Bridge(this);
        updater = new Updater(this, bridge);
        bridge.setUpdater(updater);

        createWebView();

        // Register noisy receiver to pause audio when headphones are unplugged
        registerReceiver(noisyAudioReceiver, new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY));

        // Silent background update check 20 seconds after app startup
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (!isFinishing() && !isDestroyed()) {
                updater.checkForUpdates(false, null);
            }
        }, 20000);

        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)
                && WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_SHOULD_INTERCEPT_REQUEST)) {
            // The service worker's own requests, so files handed to Sondra reach it there too.
            ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(new ServiceWorkerClientCompat() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                    return bridge.intercept(request.getUrl());
                }
            });
        }

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (fullscreen != null) {
                    leaveFullscreen();
                } else if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                }
            }
        });

        bridge.received(getIntent());
        // Back from Google after Android ended Sondra meanwhile: the new page takes the answer.
        if (fromSignIn(getIntent())) bridge.signInReturned(getIntent().getData());
        String url = addressFrom(getIntent());
        if (savedInstanceState == null || webView.restoreState(savedInstanceState) == null) {
            Log.i(TAG, "Adresse: " + url);
            webView.loadUrl(url);
        }
    }

    /** Ref-counted screen wake lock (FLAG_KEEP_SCREEN_ON). */
    public synchronized void setKeepScreenOn(boolean keep) {
        if (keep) {
            wakeLockCount++;
        } else {
            wakeLockCount = Math.max(0, wakeLockCount - 1);
        }
        boolean active = wakeLockCount > 0;
        runOnUiThread(() -> {
            if (active) {
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView() {
        webView = new WebView(this);
        webView.setBackgroundColor(ContextCompat.getColor(this, pageDark ? R.color.canvasDark : R.color.canvas));
        root.addView(webView, 0, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        // Enhanced WebSettings for fluid playback & accurate mobile layout
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        // The page can tell it runs here; the bridge is what it really relies on.
        settings.setUserAgentString(settings.getUserAgentString() + " SondraAndroid/" + version());

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        bridge.attach(webView);
        webView.setWebViewClient(new Client());
        webView.setWebChromeClient(new Chrome());
        webView.setDownloadListener((url, userAgent, disposition, mime, length) -> openOutside(Uri.parse(url)));
    }

    private static boolean fromSignIn(Intent intent) {
        return intent != null && Bridge.isSignInReturn(intent.getData());
    }

    /** The page's address for an intent: a link, a shortcut, else the Merkliste. */
    private String addressFrom(Intent intent) {
        Uri data = intent != null ? intent.getData() : null;
        if (data != null && "https".equals(data.getScheme()) && isOwn(data) && !fromSignIn(intent)) return data.toString();
        return getString(R.string.launchUrl);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        bridge.received(intent);
        Uri data = intent.getData();
        if (fromSignIn(intent)) {
            // Back from the Google sign-in in the browser; the page takes the answer.
            bridge.signInReturned(data);
            return;
        }
        if (data == null || !"https".equals(data.getScheme()) || !isOwn(data) || webView == null) return;
        String url = data.toString();
        Log.i(TAG, "Adresse: " + url);
        Uri current = webView.getUrl() != null ? Uri.parse(webView.getUrl()) : null;
        if (current != null && isOwn(current) && data.getFragment() != null
                && String.valueOf(current.getPath()).equals(String.valueOf(data.getPath()))) {
            // Only the tool changes: the page stays, with what it holds.
            webView.evaluateJavascript("location.hash = " + Bridge.quote("#" + data.getFragment()), null);
        } else {
            webView.loadUrl(url);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (bridge != null) bridge.resumed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // The Drive sign-in lives in a cookie of the website's function: kept
        // on disk now, not only when the WebView gets round to it.
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        try {
            unregisterReceiver(noisyAudioReceiver);
        } catch (Exception ignored) {}
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    static boolean isOwn(Uri uri) {
        String host = uri.getHost();
        return host != null && (host.equals(HOST) || host.equals("www." + HOST));
    }

    /** Hands an address to whatever opens it: the browser, a mail app, the Play Store. */
    void openOutside(Uri uri) {
        Intent intent = new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.noBrowser, Toast.LENGTH_SHORT).show();
        }
    }

    private boolean systemDark() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
    }

    /** The page says which theme it shows; bars and background follow. */
    void setPageDark(boolean dark) {
        if (dark == pageDark) return;
        pageDark = dark;
        applyBars();
    }

    private void applyBars() {
        int canvas = ContextCompat.getColor(this, pageDark ? R.color.canvasDark : R.color.canvas);
        SystemBarStyle style = pageDark
                ? SystemBarStyle.dark(Color.TRANSPARENT)
                : SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT);
        EdgeToEdge.enable(this, style, style);
        getWindow().getDecorView().setBackgroundColor(canvas);
        if (root != null) root.setBackgroundColor(canvas);
        if (webView != null) webView.setBackgroundColor(canvas);
    }

    String version() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "?";
        }
    }

    /** Runs after the storage permission, which only Android 9 and older ask for. */
    void withStorage(Runnable next, Runnable denied) {
        if (android.os.Build.VERSION.SDK_INT >= 29
                || ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                        == PackageManager.PERMISSION_GRANTED) {
            next.run();
            return;
        }
        if (storageDenied != null) storageDenied.run();
        afterStorage = next;
        storageDenied = denied;
        storagePermission.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE);
    }

    private void showOffline(boolean show) {
        if (show && offline == null) {
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setGravity(Gravity.CENTER);
            int pad = Math.round(32 * getResources().getDisplayMetrics().density);
            box.setPadding(pad, pad, pad, pad);
            box.setBackgroundColor(ContextCompat.getColor(this, pageDark ? R.color.canvasDark : R.color.canvas));
            int ink = pageDark ? Color.parseColor("#E4EDE6") : Color.parseColor("#162019");

            TextView title = new TextView(this);
            title.setText(R.string.offlineTitle);
            title.setTextSize(20);
            title.setTextColor(ink);
            title.setGravity(Gravity.CENTER);
            TextView text = new TextView(this);
            text.setText(R.string.offlineText);
            text.setTextSize(15);
            text.setTextColor(ink);
            text.setGravity(Gravity.CENTER);
            text.setPadding(0, pad / 2, 0, pad / 2);
            Button retry = new Button(this);
            retry.setText(R.string.offlineRetry);
            retry.setOnClickListener(v -> {
                showOffline(false);
                if (webView != null) webView.reload();
            });
            box.addView(title);
            box.addView(text);
            box.addView(retry);
            offline = box;
            root.addView(offline, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        } else if (!show && offline != null) {
            root.removeView(offline);
            offline = null;
        }
    }

    private void leaveFullscreen() {
        if (fullscreen == null) return;
        root.removeView(fullscreen);
        fullscreen = null;

        // Restore underlying WebView visibility
        if (webView != null) webView.setVisibility(View.VISIBLE);

        // Restore previous screen orientation
        setRequestedOrientation(previousOrientation);

        // Release fullscreen wake lock
        setKeepScreenOn(false);

        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.show(WindowInsetsCompat.Type.systemBars());
        if (fullscreenDone != null) fullscreenDone.onCustomViewHidden();
        fullscreenDone = null;
        ViewCompat.requestApplyInsets(root);
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if ("https".equals(uri.getScheme()) && isOwn(uri)) return false;
            openOutside(uri);
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return bridge.intercept(request.getUrl());
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            drawn = true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            drawn = true;
            Log.i(TAG, "Seite geladen: " + url);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            Log.w(TAG, "Nicht geladen: " + error.getDescription());
            drawn = true;
            showOffline(true);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The page's process died (memory, most likely): a new WebView
            // instead of taking the app down with it.
            Log.w(TAG, "WebView-Prozess beendet, Sondra lädt neu");
            String url = view.getUrl();
            root.removeView(view);
            view.destroy();
            webView = null;
            createWebView();
            webView.loadUrl(url != null && isOwn(Uri.parse(url)) ? url : getString(R.string.launchUrl));
            return true;
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> done, FileChooserParams params) {
            if (pickDone != null) pickDone.onReceiveValue(null);
            pickDone = done;
            try {
                picker.launch(Picker.intent(params));
                return true;
            } catch (ActivityNotFoundException e) {
                pickDone = null;
                return false;
            }
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            boolean own = isOwn(request.getOrigin());
            boolean audio = false;
            for (String resource : request.getResources()) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) audio = true;
            }
            if (!own || !audio) {
                request.deny();
                return;
            }
            if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            } else {
                if (micRequest != null) micRequest.deny();
                micRequest = request;
                micPermission.launch(Manifest.permission.RECORD_AUDIO);
            }
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (fullscreen != null) {
                callback.onCustomViewHidden();
                return;
            }
            fullscreen = view;
            fullscreenDone = callback;
            view.setBackgroundColor(Color.BLACK);

            // Hide webView to eliminate dual-GPU compositor layers
            if (webView != null) webView.setVisibility(View.GONE);

            root.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

            // Save orientation and switch to sensor landscape for full immersion
            previousOrientation = getRequestedOrientation();
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);

            // Keep screen on while video is playing in fullscreen
            setKeepScreenOn(true);

            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
            controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            controller.hide(WindowInsetsCompat.Type.systemBars());
            ViewCompat.requestApplyInsets(root);
        }

        @Override
        public void onHideCustomView() {
            leaveFullscreen();
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, android.os.Message result) {
            // A new window (a Drive folder, a link with target="_blank"): its
            // first address goes to the browser.
            WebView catcher = new WebView(MainActivity.this);
            catcher.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView w, WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    if ("https".equals(uri.getScheme()) && isOwn(uri)) webView.loadUrl(uri.toString());
                    else openOutside(uri);
                    w.destroy();
                    return true;
                }

                @Override
                public boolean onRenderProcessGone(WebView w, RenderProcessGoneDetail detail) {
                    w.destroy();
                    return true;
                }
            });
            WebView.WebViewTransport transport = (WebView.WebViewTransport) result.obj;
            transport.setWebView(catcher);
            result.sendToTarget();
            return true;
        }
    }
}
