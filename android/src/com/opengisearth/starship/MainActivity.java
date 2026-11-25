package com.opengisearth.starship;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/** The whole app: one full-screen WebView on the game. Touches reach the page as they are (several fingers at once), as do gamepads. */
public class MainActivity extends Activity {
    private static final String HOST = "opengisearth.com", HOME = "https://" + HOST + "/?play";
    private static final String OFFLINE = "<body style='background:#0b2a4a;color:#fff;font-family:sans-serif;text-align:center;padding-top:30vh'>"
        + "<h2>OpenStarshipEarth</h2><p>Sin conexi&oacute;n / No connection</p><p><a style='color:#7fd4ff;font-size:20px' href='" + HOME + "'>Reintentar / Retry</a></p></body>";
    private WebView web;
    private long backAt;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // the game keeps its progress in localStorage
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportZoom(false); s.setBuiltInZoomControls(false); s.setDisplayZoomControls(false); // two fingers are two controls, never a zoom
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false; // the game stays in the app; any other link opens in the browser
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception e) { /* nothing on the phone opens it */ }
                return true;
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) v.loadDataWithBaseURL(null, OFFLINE, "text/html", "utf-8", null);
            }
        });
        setContentView(web);
        if (saved == null) web.loadUrl(HOME); else web.restoreState(saved);
    }

    @Override public void onWindowFocusChanged(boolean has) { // full screen, the system bars hidden until swiped in
        super.onWindowFocusChanged(has);
        if (has) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }
    @Override protected void onPause() { web.onPause(); super.onPause(); } // the music stops with the app in the background
    @Override protected void onResume() { super.onResume(); web.onResume(); }

    @Override public void onBackPressed() { // back twice leaves: once is too easy to do by accident in the middle of a flight
        long now = System.currentTimeMillis();
        if (now - backAt < 2000) { super.onBackPressed(); return; }
        backAt = now;
        Toast.makeText(this, "Atrás otra vez para salir / Back again to leave", Toast.LENGTH_SHORT).show();
    }
}
