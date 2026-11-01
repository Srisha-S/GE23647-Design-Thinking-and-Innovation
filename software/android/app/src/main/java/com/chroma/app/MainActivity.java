package com.chroma.app;

import com.getcapacitor.BridgeActivity;
import android.os.Bundle;
import android.os.SystemClock;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;

public class MainActivity extends BridgeActivity {
    private volatile boolean startupArtworkReady = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // The system splash hands directly to the supplied artwork in the WebView.
        SplashScreen splashScreen = SplashScreen.installSplashScreen(this);
        long startupDeadline = SystemClock.uptimeMillis() + 5000;
        super.onCreate(savedInstanceState);
        splashScreen.setKeepOnScreenCondition(
            () -> !startupArtworkReady && SystemClock.uptimeMillis() < startupDeadline
        );
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() == null) { finish(); return; }
                getBridge().getWebView().evaluateJavascript(
                    "Boolean(window.chromaHandleBack && window.chromaHandleBack())",
                    result -> {
                        if (!"true".equals(result)) {
                            setEnabled(false);
                            getOnBackPressedDispatcher().onBackPressed();
                            setEnabled(true);
                        }
                    }
                );
            }
        });
    }

    @Override
    protected void load() {
        // Register before Capacitor loads index.html so the very first page has it.
        WebView webView = findViewById(com.getcapacitor.android.R.id.webview);
        webView.addJavascriptInterface(new StartupBridge(), "ChromaStartupBridge");
        super.load();
    }

    public final class StartupBridge {
        @JavascriptInterface
        public void ready() {
            startupArtworkReady = true;
        }
    }
}
