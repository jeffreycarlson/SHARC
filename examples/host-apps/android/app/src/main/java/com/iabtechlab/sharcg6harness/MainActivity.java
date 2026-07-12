package com.iabtechlab.sharcg6harness;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String TAG = "SHARC_G6";
    private static final String EXTRA_HARNESS_URL = "harness-url";
    private static final String DEFAULT_URL =
            "http://10.0.2.2:18865/examples/host-apps/android/harness/index.html"
            + "?creativeOrigin=http%3A%2F%2F10.0.2.2%3A18867";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ((HarnessApplication) getApplication()).registerHarness(this);

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        webView.setWebViewClient(new WebViewClient());
        webView.addJavascriptInterface(new HarnessBridge(), "sharcHarness");
        setContentView(webView);
        loadFromIntent(getIntent(), true);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        loadFromIntent(intent, false);
    }

    @Override
    protected void onDestroy() {
        ((HarnessApplication) getApplication()).unregisterHarness(this);
        if (webView != null) {
            webView.removeJavascriptInterface("sharcHarness");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private void loadFromIntent(Intent intent, boolean initial) {
        String url = intent != null ? intent.getStringExtra(EXTRA_HARNESS_URL) : null;
        if (url == null || url.length() == 0) url = DEFAULT_URL;
        String current = webView != null ? webView.getUrl() : null;
        if (initial || current == null || !current.equals(url)) {
            webView.loadUrl(url);
        }
    }

    void pushActiveWithExposureReasserts() {
        pushHostLifecycle("active");
        pushHostExposure(100);
        int[] delays = new int[] { 250, 750, 1250 };
        for (int delay : delays) {
            handler.postDelayed(() -> {
                pushHostLifecycle("active");
                pushHostExposure(100);
            }, delay);
        }
    }

    void pushHostLifecycle(String state) {
        evaluateHarnessJavaScript("__sharcHarnessSetHostLifecycle", JSONObject.quote(state));
    }

    void pushHostExposure(int percent) {
        evaluateHarnessJavaScript("__sharcHarnessSetHostExposure", String.valueOf(percent));
    }

    private void evaluateHarnessJavaScript(String functionName, String argument) {
        if (webView == null) return;
        String source = "(function(){"
                + "if(typeof window." + functionName + "!==\"function\")return;"
                + "try{window." + functionName + "(" + argument + ");}catch(e){}"
                + "})();";
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(source, null);
        });
    }

    public final class HarnessBridge {
        @JavascriptInterface
        public void postMessage(String message) {
            if (message == null) return;
            Log.i(TAG, message);
            try {
                JSONObject parsed = new JSONObject(message);
                if ("summary".equals(parsed.optString("type"))) {
                    handler.postDelayed(() -> {
                        try { finishAndRemoveTask(); } catch (Throwable ignored) { finish(); }
                    }, 100);
                }
            } catch (Throwable ignored) {
                // Rows are still useful even if a non-JSON diagnostic slips through.
            }
        }
    }
}
