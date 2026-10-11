/*
 * The AnyTune Android app (docs/ANDROID.md).
 *
 *  - Native: the JNI bridge and AnyTune's recorder module, built by CMake from src/main/cpp and native/recorder, linked against the Polycall library staged
 *    in native/android/<abi>/ (npm run native:stage) — packaged as staged, byte for byte (keepDebugSymbols: AGP must not strip it again).
 *  - Web: the AnyTune UI and its TypeScript music logic, built by Vite (npm run build:android) into dist/android-web and packaged as assets, served to the
 *    WebView from https://appassets.androidplatform.net (a secure context).
 *  - Audio capture and the timing-critical path are Kotlin, on their own thread, never a WebView timer.
 *
 * ABIs: arm64-v8a (phones) and x86_64 (the emulator). minSdk 28: Polycall's provider host uses posix_spawn, which bionic has from API 28.
 */
plugins {
    id("com.android.application")
}

val anytuneRoot: File = rootDir.parentFile.parentFile
val webBuild: File = anytuneRoot.resolve("dist/android-web")

android {
    namespace = "org.obinexus.anytune"
    compileSdk = 37
    ndkVersion = "27.1.12297006"

    defaultConfig {
        applicationId = "org.obinexus.anytune"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk {
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
        externalNativeBuild {
            cmake {
                arguments += listOf("-DANYTUNE_ROOT=${anytuneRoot.absolutePath.replace('\\', '/')}")
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    sourceSets {
        getByName("main") {
            // the staged, verified Polycall libraries: native/android/arm64-v8a/libpolycall.so, native/android/x86_64/libpolycall.so
            jniLibs.directories.add(anytuneRoot.resolve("native/android").absolutePath)
            assets.directories.add(layout.buildDirectory.dir("generated/anytune-web").get().asFile.absolutePath)
        }
    }

    packaging {
        jniLibs {
            keepDebugSymbols += "**/libpolycall.so"
            useLegacyPackaging = false
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // a release is signed with the owner's key, configured outside this repository (docs/ANDROID.md); none is committed
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    testOptions {
        unitTests.isReturnDefaultValues = false
    }
}

// The web UI, copied from the Vite build under the APK's assets/web/. A missing build fails here, with what to run — never an app with no UI.
val syncWebAssets = tasks.register<Sync>("syncWebAssets") {
    from(webBuild)
    into(layout.buildDirectory.dir("generated/anytune-web/web"))
    doFirst {
        if (!webBuild.resolve("index.html").exists()) {
            throw GradleException("The AnyTune web UI is not built: run `npm run build:android` in ${anytuneRoot}")
        }
    }
}
tasks.named("preBuild") { dependsOn(syncWebAssets) }

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.11.0")
    implementation("androidx.webkit:webkit:1.17.1")

    testImplementation("junit:junit:4.13.2")

    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:core:1.7.0")
}
