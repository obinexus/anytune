package org.obinexus.anytune

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.webkit.WebViewAssetLoader
import org.obinexus.anytune.polycall.PolycallBridge
import org.obinexus.anytune.polycall.RecorderSession

/**
 * The app's one screen: AnyTune's UI (the same TypeScript and .obix components as the web build) in a WebView, served from the APK's assets at
 * https://appassets.androidplatform.net — a secure context, and the only origin the WebView will load. The page reaches native code only through
 * [AnyTuneAndroid]: the recorder (through Polycall), never the session token, never a file path.
 */
class MainActivity : ComponentActivity() {
    private var session: RecorderSession? = null
    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        session = try {
            RecorderSession.start(filesDir).also { Log.i(TAG, "${PolycallBridge.nativeVersion()}; recorder at ${it.endpoint}") }
        } catch (error: IllegalStateException) {
            Log.e(TAG, "the recorder did not start: ${error.message}")
            null
        }
        val assets = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.mediaPlaybackRequiresUserGesture = true
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = assets.shouldInterceptRequest(request.url)
                // only AnyTune's own pages: anything else is refused, never opened in the app
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = request.url.host != ASSET_HOST
            }
            addJavascriptInterface(AnyTuneAndroid(), "AnyTuneAndroid")
        }
        setContentView(webView)
        webView.loadUrl("https://$ASSET_HOST/assets/web/index.html")
    }

    override fun onDestroy() {
        webView.destroy()
        session?.stop()
        session = null
        super.onDestroy()
    }

    /** What the page may ask of native code. Each method returns a reply envelope as JSON text — {"ok":true,"output":…} or {"ok":false,"error":…}. */
    inner class AnyTuneAndroid {
        @JavascriptInterface
        fun recording(operation: String, inputObjectJson: String): String =
            session?.recording(operation, inputObjectJson)
                ?: """{"ok":false,"error":{"code":"transport.unreachable","message":"the recorder did not start"}}"""

        @JavascriptInterface
        fun platform(): String = """{"platform":"android","polycall":"${PolycallBridge.nativeVersion()}"}"""
    }

    companion object {
        private const val TAG = "AnyTune"
        const val ASSET_HOST = "appassets.androidplatform.net"
    }
}
