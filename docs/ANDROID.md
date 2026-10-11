# The Android app

`apps/android` is a Gradle project (AGP 9.4.1, Kotlin built into AGP, Gradle 9.7.1 wrapper). It targets:

- **ABIs:** `arm64-v8a` for phones and `x86_64` for the emulator.
- **SDK levels:** `minSdk` 28 (Polycall uses `posix_spawn`, which Android's libc has from API 28), `targetSdk` 36, `compileSdk` 37 (androidx.core 1.19 needs it).

## What runs where

```
WebView (https://appassets.androidplatform.net/assets/web/index.html)
  AnyTune's UI (.obix) and TypeScript music logic, built by Vite
        │  window.AnyTuneAndroid.recording(op, inputJson)   (no token, no paths)
        ▼
Kotlin (MainActivity, RecorderSession)  ── adds the session token ──►  JNI: PolycallBridge.nativeCall
        ▼
libanytune_bridge.so  ── polycall_call (Polycall Binding ABI v1) ──►  127.0.0.1:<ephemeral>
        ▼
libpolycall.so: an in-process Polycall runtime  ──►  recording.* operations (AnyTune's recorder module, compiled in)
        ▼
<filesDir>/recordings/<id>.atrec   (anytune-recording/1, app-private storage)
```

- **Polycall** (`libpolycall.so`) is not built by Gradle. It is the staged library from `native/android/<abi>/`, built from Polycall's pinned commit with the NDK by `npm run native:stage`, and packaged byte for byte:
  - `keepDebugSymbols` stops AGP from stripping it again.
  - `npm run native:verify -- --apk <apk>` checks it in the APK.
- **AnyTune's native code** (`libanytune_bridge.so`) is built by Gradle's CMake from `app/src/main/cpp/` and `native/recorder/`. It is linked with 16 KB page alignment.
- **The UI** is the same `.obix` components and TypeScript as the web build. `npm run build:android` builds it with relative paths into `dist/android-web`, and Gradle's `syncWebAssets` copies it into the APK's `assets/web/`. A missing build fails the Gradle build with the command to run.
- **The timing-critical audio path** (capture, timestamps, analysis) belongs in Kotlin on its own thread, never in a WebView timer. Microphone capture is not wired yet (see *Status*).

## Security and privacy

- **Loopback access is guarded by the recorder.** The Polycall runtime listens on `127.0.0.1`, where other apps on the device can connect, and Polycall authenticates no request. So:
  - The recorder requires a session token on every operation.
  - `RecorderSession` generates the token per session with `SecureRandom`. It is never stored and never given to the WebView, and a WebView input that brings its own `token` is refused.
  - The runtime's shutdown takes a second random token that stays in the bridge.
- **The WebView is locked down.** It loads only `appassets.androidplatform.net` and refuses other navigation. It has no file or content access, and the page reaches native code only through `AnyTuneAndroid`.
- **Permissions:**
  - `INTERNET` is declared because Android requires it for any socket, loopback included.
  - `RECORD_AUDIO` is for the tuner and practice capture, and is asked for only when the learner starts.
  - AnyTune uploads nothing: no microphone audio and no recording leaves the device.
- **Backups are off** (`allowBackup="false"`), so recordings stay in app-private storage.

## Building

From the AnyTune checkout, with Node ≥ 26, the Android SDK (NDK 27.1.12297006, CMake 3.22.1, platform 37) and JDK 17+ (Android Studio's JBR works):

```bash
npm ci
npm run native:stage
npm run build:android
cd apps/android
./gradlew assembleDebug
cd ../..
npm run native:verify -- --apk apps/android/app/build/outputs/apk/debug/app-debug.apk
```

`npm run native:stage` takes `-- --polycall-src <clone>`, or fetches Polycall's pinned commit itself.

Notes:

- `apps/android/local.properties` (`sdk.dir=…`) is machine-local and is not committed. Set it, or set `ANDROID_HOME`.
- **Release:** `./gradlew bundleRelease` (AAB) or `assembleRelease` builds a release, but **a signed release needs the owner's signing key**, configured outside this repository (for example, a `signingConfig` read from environment variables or a local `keystore.properties`). No key is in the repository, and none should be.
- **Before distributing an APK**, Polycall's licence question must be settled (`native/README.md`).

## Tests

```bash
cd apps/android
./gradlew connectedDebugAndroidTest
```

This needs a device or a running emulator. `RecorderThroughPolycallTest` runs on the device, with nothing mocked:

- the APK's own `libpolycall.so` reports Polycall 1.1.0, Binding ABI 1, and serves on loopback;
- an attempt is created, appended, finished and replayed through Polycall, with every event in order;
- calls without the session token, or with a wrong one, are refused (`auth.denied`), and a caller can't bring its own token;
- time order is enforced (`recording.order`), and a path given as a recording ID is refused.

**Recorded result (2026-10-11):** 3/3 passed on the emulator `Smoke_SmallPhone`: Android 17 (API 37), x86_64, **16 KB memory pages** (`getconf PAGE_SIZE` = 16384), Google APIs Play Store image. The app launched there, the log showed `Polycall 1.1.0, Binding ABI 1, runtime ABI 1; recorder at 127.0.0.1:<port>`, and the WebView rendered AnyTune's UI.

**Not yet done:**

- **No physical arm64 device** has run it: none was attached.
- **No microphone capture** on Android yet.
- **The UI overflows a phone's width**, a layout defect seen on the emulator.
