import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
}

// One version for website, Windows app and Android app: the website's package.json.
val sondraVersion = (JsonSlurper().parse(rootProject.file("../package.json")) as Map<*, *>)["version"] as String
val versionParts = sondraVersion.split(".").map { it.toInt() }

// The key the app is signed with. Without one (a first run, a fork) the debug
// key signs it: the app installs and runs, but the next build cannot update it.
val keystore: String? = System.getenv("SONDRA_ANDROID_KEYSTORE")

android {
    namespace = "ch.lizge.sondra"
    compileSdk = 36

    defaultConfig {
        applicationId = "ch.lizge.sondra"
        minSdk = 24
        targetSdk = 36
        versionName = sondraVersion
        versionCode = versionParts[0] * 10000 + versionParts[1] * 100 + versionParts[2]
    }

    signingConfigs {
        create("release") {
            if (keystore != null) {
                storeFile = file(keystore)
                storePassword = System.getenv("SONDRA_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SONDRA_ANDROID_KEY_ALIAS") ?: "sondra"
                keyPassword = System.getenv("SONDRA_ANDROID_KEY_PASSWORD") ?: System.getenv("SONDRA_ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            // What the app does not use of androidbrowserhelper and its libraries goes.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            signingConfig = signingConfigs.getByName(if (keystore != null) "release" else "debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.4")
}
