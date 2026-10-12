package org.obinexus.anytune

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import org.obinexus.anytune.polycall.PolycallBridge
import org.obinexus.anytune.polycall.RecorderSession

/**
 * The app's one screen: AnyTune's UI (the same TypeScript and .obix components as the web build) in a WebView, served from the APK's assets at
 * https://appassets.androidplatform.net — a secure context, and the only origin the WebView will load. The page reaches native code only through
 * [AnyTuneAndroid]: the recorder (through Polycall), never the session token, never a file path.
 *
 * The microphone: when the page asks for it (Start, in the tuner or in practice), Android's own permission is asked for if it was not granted, and the
 * page is granted audio capture — only AnyTune's own page, and only audio. When the app leaves the foreground, the page is told to stop listening.
 */
class MainActivity : ComponentActivity() {
    private var session: RecorderSession? = null
    private lateinit var webView: WebView

    /** the page's microphone request, waiting for the learner's answer to Android's permission dialog */
    private var pendingAudio: PermissionRequest? = null
    private val askMicrophone = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val request = pendingAudio ?: return@registerForActivityResult
        pendingAudio = null
        if (granted) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny()
    }

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
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    // AnyTune's own page, asking for the microphone — nothing else is granted (no camera, no other origin)
                    if (request.origin.host != ASSET_HOST || PermissionRequest.RESOURCE_AUDIO_CAPTURE !in request.resources) {
                        request.deny()
                        return
                    }
                    if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    } else {
                        pendingAudio?.deny()
                        pendingAudio = request
                        askMicrophone.launch(Manifest.permission.RECORD_AUDIO)
                    }
                }

                override fun onPermissionRequestCanceled(request: PermissionRequest) {
                    if (pendingAudio === request) pendingAudio = null
                }
            }
            addJavascriptInterface(AnyTuneAndroid(), "AnyTuneAndroid")
        }
        // Android 15 draws the app edge to edge: the page is kept clear of the status and navigation bars (and a display cutout) by padding its container
        val frame = FrameLayout(this).apply { addView(webView, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)) }
        ViewCompat.setOnApplyWindowInsetsListener(frame) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(frame)
        webView.loadUrl("https://$ASSET_HOST/assets/web/index.html")
    }

    override fun onPause() {
        // nothing keeps listening in the background: the page stops practice and the tuner and releases the microphone (src/harness/main.ts)
        webView.evaluateJavascript("document.dispatchEvent(new Event('$PAUSE_EVENT'))", null)
        super.onPause()
    }

    override fun onDestroy() {
        pendingAudio?.deny()
        pendingAudio = null
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

        /** the event the page listens for to stop listening (src/harness/main.ts) */
        const val PAUSE_EVENT = "anytune-pause"
    }
}
