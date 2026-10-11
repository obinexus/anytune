package org.obinexus.anytune

import android.Manifest
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * On a device or an emulator: the app's own page, in MainActivity's WebView — the journey's shell loads from the APK's assets, the recorder bridge is there
 * (and is not given the session token), and when the microphone permission is held, the page's request for the microphone is granted by the WebView
 * (onPermissionRequest). Whether audio then flows depends on the device's microphone: the test says what getUserMedia answered, and requires only that
 * permission was not what refused it.
 */
@RunWith(AndroidJUnit4::class)
class AppPageTest {
    @Before
    fun grantMicrophone() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.grantRuntimePermission(instrumentation.targetContext.packageName, Manifest.permission.RECORD_AUDIO)
    }

    /** Runs JavaScript in the page and returns its JSON result. */
    private fun eval(scenario: ActivityScenario<MainActivity>, script: String): String {
        val latch = CountDownLatch(1)
        var result = ""
        scenario.onActivity { activity ->
            val webView = (activity.findViewById<ViewGroup>(android.R.id.content).getChildAt(0) as ViewGroup).getChildAt(0) as WebView
            webView.evaluateJavascript(script) { value ->
                result = value
                latch.countDown()
            }
        }
        assertTrue("the page did not answer: $script", latch.await(10, TimeUnit.SECONDS))
        return result
    }

    /** Polls the page until `condition` is true (JavaScript), or fails after 20 s. */
    private fun waitFor(scenario: ActivityScenario<MainActivity>, condition: String) {
        val until = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < until) {
            if (eval(scenario, "Boolean($condition)") == "true") return
            Thread.sleep(200)
        }
        throw AssertionError("the page never reached: $condition")
    }

    @Test
    fun theJourneyLoadsFromTheApkWithTheRecorderBridge() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            waitFor(scenario, "document.querySelector('.shell main h1')")
            assertEquals("\"Groove to any tune.\"", eval(scenario, "document.querySelector('.shell main h1').textContent"))
            assertEquals("\"https://${MainActivity.ASSET_HOST}\"", eval(scenario, "location.origin"))
            assertEquals("true", eval(scenario, "window.isSecureContext"))
            // the bridge offers the recorder and the platform — and nothing that gives the token away
            val platform = eval(scenario, "AnyTuneAndroid.platform()")
            assertTrue(platform, platform.contains("Polycall 1.1.0"))
            val listed = eval(scenario, "AnyTuneAndroid.recording('list', '{}')")
            assertTrue(listed, listed.contains("\\\"ok\\\":true"))
            assertEquals("\"undefined\"", eval(scenario, "typeof AnyTuneAndroid.token"))
        }
    }

    @Test
    fun thePagesMicrophoneRequestIsGrantedWhenThePermissionIsHeld() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            waitFor(scenario, "document.querySelector('.shell')")
            eval(
                scenario,
                """
                window.__mic = null;
                navigator.mediaDevices.getUserMedia({ audio: true })
                  .then((stream) => { window.__mic = 'granted:' + stream.getAudioTracks().length; stream.getTracks().forEach((t) => t.stop()); })
                  .catch((error) => { window.__mic = 'refused:' + error.name; });
                """.trimIndent(),
            )
            waitFor(scenario, "window.__mic")
            val answer = eval(scenario, "window.__mic")
            android.util.Log.i("AnyTuneTest", "getUserMedia answered $answer")
            assertNotEquals("the WebView refused the page's microphone request", "\"refused:NotAllowedError\"", answer)
        }
    }

    @Test
    fun thePageIsNeverGrantedTheCamera() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            waitFor(scenario, "document.querySelector('.shell')")
            eval(
                scenario,
                """
                window.__camera = null;
                navigator.mediaDevices.getUserMedia({ video: true })
                  .then((stream) => { window.__camera = 'granted'; stream.getTracks().forEach((t) => t.stop()); })
                  .catch((error) => { window.__camera = 'refused:' + error.name; });
                """.trimIndent(),
            )
            waitFor(scenario, "window.__camera")
            val answer = eval(scenario, "window.__camera")
            android.util.Log.i("AnyTuneTest", "getUserMedia(video) answered $answer")
            assertTrue(answer, answer.startsWith("\"refused:"))
        }
    }
}
