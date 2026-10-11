package org.obinexus.anytune

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.obinexus.anytune.polycall.PolycallBridge
import org.obinexus.anytune.polycall.RecorderSession
import java.io.File

/**
 * On a device or an emulator: the APK's libpolycall.so (Polycall 1.1.0, built for this ABI with the NDK) runs an in-process runtime, AnyTune's recorder
 * module is registered in it by the JNI bridge, and Kotlin reaches it through Polycall's polycall_call over loopback. Nothing is mocked.
 */
@RunWith(AndroidJUnit4::class)
class RecorderThroughPolycallTest {
    private lateinit var session: RecorderSession
    private lateinit var directory: File

    @Before
    fun start() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        directory = File(context.cacheDir, "recorder-test-${System.nanoTime()}").apply { mkdirs() }
        session = RecorderSession.start(directory)
    }

    @After
    fun stop() {
        session.stop()
        directory.deleteRecursively()
    }

    private fun ok(reply: String): JSONObject {
        val json = JSONObject(reply)
        assertTrue("expected success: $reply", json.getBoolean("ok"))
        return json.getJSONObject("output")
    }

    private fun code(reply: String): String = JSONObject(reply).getJSONObject("error").getString("code")

    @Test
    fun polycallIsTheStagedVersionAndServesOnLoopback() {
        assertTrue(PolycallBridge.nativeVersion(), PolycallBridge.nativeVersion().startsWith("Polycall 1.1.0, Binding ABI 1"))
        assertTrue(session.endpoint, session.endpoint.matches(Regex("127\\.0\\.0\\.1:[0-9]+")))
    }

    @Test
    fun anAttemptIsRecordedAndReplayedInOrderThroughPolycall() {
        val meta = JSONObject().put("referenceId", "ref-fur-elise").put("clock", JSONObject().put("domain", "capture-monotonic").put("unit", "s"))
        val created = ok(session.recording("create", JSONObject().put("kind", "attempt").put("meta", meta).toString()))
        val id = created.getString("recordingId")
        assertTrue(id.matches(Regex("[0-9a-f]{32}")))
        val events = JSONArray()
            .put(JSONObject().put("t", 0.01).put("kind", "pitch").put("hz", 329.63).put("note", "E4 — é"))
            .put(JSONObject().put("t", 0.25).put("kind", "onset").put("strength", 0.7))
        assertEquals(2, ok(session.recording("append", JSONObject().put("recordingId", id).put("events", events).toString())).getInt("appended"))
        assertEquals(2, ok(session.recording("finish", JSONObject().put("recordingId", id).toString())).getInt("events"))
        val read = ok(session.recording("read", JSONObject().put("recordingId", id).toString()))
        assertTrue(read.getBoolean("complete"))
        assertTrue(read.getBoolean("intact"))
        assertEquals("ref-fur-elise", read.getJSONObject("header").getJSONObject("meta").getString("referenceId"))
        assertEquals(events.toString(), read.getJSONArray("events").toString())
        assertTrue(File(File(directory, "recordings"), "$id.atrec").isFile)
    }

    @Test
    fun theRecorderRefusesWithoutTheSessionTokenAndKeepsTimeOrder() {
        // straight through Polycall, without the session: no token, no recording
        assertEquals("auth.denied", code(PolycallBridge.nativeCall("recording", "list", "{}", 5000)))
        assertEquals("auth.denied", code(PolycallBridge.nativeCall("recording", "list", """{"token":"${"0".repeat(64)}"}""", 5000)))
        // a caller cannot bring its own token through the session
        assertEquals("input.invalid", code(session.recording("list", """{"token":"x"}""")))
        val id = ok(session.recording("create", """{"kind":"reference","meta":{"referenceId":"r"}}""")).getString("recordingId")
        ok(session.recording("append", """{"recordingId":"$id","events":[{"t":1.0,"kind":"note"}]}"""))
        assertEquals("recording.order", code(session.recording("append", """{"recordingId":"$id","events":[{"t":0.5,"kind":"note"}]}""")))
        assertEquals("input.invalid", code(session.recording("read", """{"recordingId":"../../../data"}""")))
        val listed = ok(session.recording("list", """{"referenceId":"r"}""")).getJSONArray("recordings")
        assertEquals(1, listed.length())
        assertFalse(listed.getJSONObject(0).getBoolean("complete"))
    }
}
