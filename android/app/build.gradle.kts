import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    require(file.exists()) { "android/local.properties is missing; run scripts/bootstrap-android.sh" }
    file.inputStream().use(::load)
}
require(localProperties.getProperty("sdk.dir") != null) {
    "sdk.dir must be set in android/local.properties; run scripts/bootstrap-android.sh"
}

android {
    namespace = "dev.carraes.snapdoc"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.carraes.snapdoc"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // Release signing is optional: without keystore.properties the release
    // build simply stays unsigned rather than failing the whole project.
    val keystorePropertiesFile = rootProject.file("keystore.properties")
    val releaseSigning = if (keystorePropertiesFile.exists()) {
        val signingProperties = Properties().apply { keystorePropertiesFile.inputStream().use(::load) }
        signingConfigs.create("personalRelease") {
            storeFile = file(requireNotNull(signingProperties.getProperty("storeFile")))
            storePassword = requireNotNull(signingProperties.getProperty("storePassword"))
            keyAlias = requireNotNull(signingProperties.getProperty("keyAlias"))
            keyPassword = requireNotNull(signingProperties.getProperty("keyPassword"))
        }
    } else null

    buildTypes.getByName("release") {
        isMinifyEnabled = false
        signingConfig = releaseSigning
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.kotlinx.coroutines.core)
    debugImplementation(libs.androidx.compose.ui.tooling)
    testImplementation(kotlin("test-junit"))
    testImplementation(libs.kotlinx.coroutines.test)
    // android.jar's org.json is stubbed for JVM unit tests; this supplies a
    // real implementation so the response parser can be tested off-device.
    testImplementation("org.json:json:20250517")
}
