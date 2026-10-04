import java.util.Properties
import com.google.firebase.crashlytics.buildtools.gradle.CrashlyticsExtension

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Verification builds must remain unsigned and must not contact Firebase upload
// endpoints even when a developer already has client configuration locally.
val isBuildOnly = System.getenv("PONLET_ANDROID_BUILD_ONLY") == "1"
val hasGoogleServices = !isBuildOnly && file("google-services.json").exists()
if (hasGoogleServices) {
    apply(plugin = "com.google.gms.google-services")
    apply(plugin = "com.google.firebase.crashlytics")
}

val releaseKeystorePath = if (isBuildOnly) "" else System.getenv("PONLET_ANDROID_KEYSTORE").orEmpty()
val releaseKeystorePassword = if (isBuildOnly) "" else System.getenv("ANDROID_KEYSTORE_PASSWORD").orEmpty()
val releaseKeyAlias = if (isBuildOnly) "" else System.getenv("ANDROID_KEY_ALIAS").orEmpty()
val releaseKeyPassword = if (isBuildOnly) "" else System.getenv("ANDROID_KEY_PASSWORD").orEmpty()

// Missing means false. A malformed explicit flag must not silently return to legacy collection.
fun privacyBoolean(name: String): String {
    val value = providers.gradleProperty(name).orNull ?: return "false"
    if (value != "true" && value != "false") throw GradleException("$name must be true or false")
    return value
}
val privacyFeatureEnabled = privacyBoolean("ponletPrivacyFeatureEnabled") == "true"

android {
    compileSdk = 36
    namespace = "jp.yasagure.ponlet"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        manifestPlaceholders["ponletPrivacyFeatureEnabled"] = privacyFeatureEnabled.toString()
        manifestPlaceholders["ponletFirebaseAutoInitEnabled"] = (!privacyFeatureEnabled).toString()
        // Public native configuration only. No credential/App Check token belongs in these properties.
        for (name in listOf("ApiOrigin", "Audience", "PolicyVersion", "ReceiptDays", "ObservationDays", "RetiredKeyPolicy")) {
            manifestPlaceholders["ponletPrivacy$name"] = providers.gradleProperty("ponletPrivacy$name").orNull ?: ""
        }
        manifestPlaceholders["ponletPrivacyComponentsVerified"] = privacyBoolean("ponletPrivacyComponentsVerified")
        manifestPlaceholders["ponletPrivacyProtocolVerified"] = privacyBoolean("ponletPrivacyProtocolVerified")
        applicationId = "jp.yasagure.ponlet"
        minSdk = 31
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    signingConfigs {
        if (releaseKeystorePath.isNotBlank()) {
            create("ponletRelease") {
                storeFile = file(releaseKeystorePath)
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            if (releaseKeystorePath.isNotBlank()) {
                signingConfig = signingConfigs.getByName("ponletRelease")
            }
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
            if (hasGoogleServices) {
                configure<CrashlyticsExtension> {
                    nativeSymbolUploadEnabled = true
                    unstrippedNativeLibsDir = file("src/main/jniLibs")
                }
            }
        }
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
}

apply(from = "tauri.build.gradle.kts")

afterEvaluate {
    if (hasGoogleServices) {
        tasks.matching { it.name.startsWith("bundle") && it.name.endsWith("Release") }.configureEach {
            val variant = name.removePrefix("bundle")
            tasks.findByName("uploadCrashlyticsSymbolFile$variant")?.let { finalizedBy(it) }
        }
    }
}
