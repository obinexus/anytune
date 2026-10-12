package org.obinexus.anytune.polycall

import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom

/**
 * The JNI boundary (src/main/cpp/anytune_bridge.c): an in-process Polycall runtime that serves AnyTune's recorder module on loopback, and Polycall's
 * `polycall_call` to reach it. Polycall connects; it decides nothing musical.
 */
object PolycallBridge {
    init {
        System.loadLibrary("anytune_bridge") // its DT_NEEDED libpolycall.so is loaded with it, from the APK
    }

    /** Configure the recorder (directory, session token), register its operations, serve on 127.0.0.1:0. Returns the bound "host:port". */
    @JvmStatic external fun nativeStart(recordingsDirectory: String, token: String): String

    /** One polycall_rpc v1 round trip. Returns {"ok":true,"output":…} or {"ok":false,"error":{"code","message"}} — never throws for a failed call. */
    @JvmStatic external fun nativeCall(service: String, operation: String, inputJson: String, timeoutMs: Int): String

    @JvmStatic external fun nativeStop()

    @JvmStatic external fun nativeVersion(): String
}

/**
 * One session of the recorder through Polycall: a fresh random token (never shown to the WebView, never stored), recordings kept in the app's private
 * storage. Callers pass the operation's input without the token; the session adds it.
 */
class RecorderSession private constructor(val endpoint: String, private val token: String) {
    companion object {
        /** Start the runtime with the recorder; recordings live in `<filesDir>/recordings`. */
        fun start(filesDir: File): RecorderSession {
            val directory = File(filesDir, "recordings").apply { mkdirs() }
            val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            val token = bytes.joinToString("") { "%02x".format(it) }
            return RecorderSession(PolycallBridge.nativeStart(directory.absolutePath, token), token)
        }
    }

    /**
     * Call `recording.<operation>` with `inputObjectJson` (a JSON object without the token, e.g. `{"kind":"attempt","meta":{…}}`); the session adds its
     * token. An input that brings a `token` of its own is refused: which of two duplicate keys reached the recorder would depend on a JSON parser.
     */
    fun recording(operation: String, inputObjectJson: String, timeoutMs: Int = 5000): String {
        if (!operation.matches(Regex("[a-z]{1,16}"))) return refusal("input.invalid", "an operation name, not $operation")
        val input = try {
            JSONObject(inputObjectJson)
        } catch (error: JSONException) {
            return refusal("input.invalid", "the input is not a JSON object")
        }
        if (input.has("token")) return refusal("input.invalid", "the input may not carry a token: the session adds its own")
        input.put("token", token)
        return PolycallBridge.nativeCall("recording", operation, input.toString(), timeoutMs)
    }

    private fun refusal(code: String, message: String): String =
        JSONObject().put("ok", false).put("error", JSONObject().put("code", code).put("message", message)).toString()

    fun stop() = PolycallBridge.nativeStop()
}
