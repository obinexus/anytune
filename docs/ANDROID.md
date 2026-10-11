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
- **The timing-critical audio path** never runs on a WebView timer. Capture is an AudioWorklet on the WebView's audio thread (`src/harness/practice-audio.ts`). It posts frames of 1024 samples, each stamped with the AudioContext frame of its first sample. The reference and the click are scheduled on that same AudioContext clock, so what was played and what was heard are compared on one clock. The analysis runs on the stamped frames, never on arrival time. There is no Kotlin capture path. The speaker-to-microphone delay is the browser's own estimate and has not been measured on a device (see *Tests*).
- **The microphone in the WebView.** `MainActivity`'s `WebChromeClient` grants audio capture only to AnyTune's own origin, and grants nothing else (a camera request is denied). If Android's `RECORD_AUDIO` permission is not held, it is asked for at that moment, so the dialog appears when the learner presses Start, not at launch.
- **Leaving the foreground.** `onPause` tells the page (`anytune-pause`) to stop practice and the tuner and release the microphone. A WebView's page is not reliably told it is hidden.
- **Edge to edge (Android 15+).** The WebView's container is padded by the system-bar and cutout insets, so the page never draws under the status or navigation bar.

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

`AppPageTest` drives the app's own page in `MainActivity`'s WebView:

- the journey's shell loads from the APK as a secure context at `https://appassets.androidplatform.net`;
- the bridge offers the recorder (a `list` through Polycall succeeds) and does not expose the token;
- with `RECORD_AUDIO` held, the page's `getUserMedia({ audio: true })` is not refused for permission, so the WebView granted it;
- `getUserMedia({ video: true })` is refused.

**Recorded result (2026-10-11):** 6/6 passed on the emulator `Smoke_SmallPhone`: Android 17 (API 37), x86_64, **16 KB memory pages** (`getconf PAGE_SIZE` = 16384), Google APIs Play Store image. The camera request was refused with `NotAllowedError`. The microphone request was granted, then failed with `NotReadableError`, because that emulator was started with `-no-audio` and has no input device. The app launched, the log showed `Polycall 1.1.0, Binding ABI 1, runtime ABI 1; recorder at 127.0.0.1:<port>`, and screenshots showed Home, the Practise screen (the first note and its suggested position on the diagram), and the supplied guitar artwork with its credit, all within the phone's width and clear of the system bars.

**Not yet done:**

- **No physical arm64 device** has run it: none was attached.
- **No audio has been captured on Android.** The permission path is tested, but no device with a microphone has delivered sound to the practice analysis, so practice on a phone is unverified.
- **No latency measurement.** The speaker-to-microphone delay used is the WebView's own estimate.
