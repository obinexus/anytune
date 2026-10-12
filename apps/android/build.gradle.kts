// AGP 9 builds Kotlin itself (it brings the Kotlin Gradle plugin): no separate Kotlin plugin is applied.
plugins {
    id("com.android.application") version "9.4.1" apply false
}
