plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "itiscuneo.zephyrdroneandroidserver"
    //noinspection GradleDependency
    compileSdk = 35

    defaultConfig {
        applicationId = "itiscuneo.zephyrdroneandroidserver"
        minSdk = 27
        //noinspection OldTargetApi
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk {
            //noinspection ChromeOsAbiSupport
            abiFilters += "arm64-v8a"
        }
        multiDexKeepProguard = file("multidex-keep.pro")

    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }




    buildFeatures {
        compose = true
    }

    packaging {
        jniLibs {
            pickFirsts += setOf(
                "lib/arm64-v8a/libc++_shared.so",
                "lib/armeabi-v7a/libc++_shared.so"
            )
            keepDebugSymbols += setOf(
                "*/*/libconstants.so",
                "*/*/libdji_innertools.so",
                "*/*/libdjibase.so",
                "*/*/libDJICSDKCommon.so",
                "*/*/libDJIFlySafeCore-CSDK.so",
                "*/*/libdjifs_jni-CSDK.so",
                "*/*/libDJIRegister.so",
                "*/*/libdjisdk_jni.so",
                "*/*/libDJIUpgradeCore.so",
                "*/*/libDJIUpgradeJNI.so",
                "*/*/libDJIWaypointV2Core-CSDK.so",
                "*/*/libdjiwpv2-CSDK.so",
                "*/*/libFlightRecordEngine.so",
                "*/*/libvideo-framing.so",
                "*/*/libwaes.so",
                "*/*/libagora-rtsa-sdk.so",
                "*/*/libc++.so",
                "*/*/libc++_shared.so",
                "*/*/libmrtc_28181.so",
                "*/*/libmrtc_agora.so",
                "*/*/libmrtc_core.so",
                "*/*/libmrtc_core_jni.so",
                "*/*/libmrtc_data.so",
                "*/*/libmrtc_log.so",
                "*/*/libmrtc_onvif.so",
                "*/*/libmrtc_rtmp.so",
                "*/*/libmrtc_rtsp.so"
            )
        }
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
            excludes += "META-INF/INDEX.LIST"
            excludes += "META-INF/io.netty.versions.properties"
        }
    }
    kotlinOptions {
        jvmTarget = "17"
    }

}

dependencies {
    implementation(libs.dji.sdk.v5.aircraft)
    implementation(libs.core.ktx)
    implementation(libs.androidx.fragment.ktx)
    implementation(libs.androidx.appcompat)

    compileOnly(libs.dji.sdk.v5.aircraft.provided)


    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    implementation(libs.ktor.server.core)
    implementation(libs.ktor.server.netty)
    implementation(libs.ktor.server.websockets)
    implementation(libs.ktor.server.content.negotiation)
    implementation(libs.ktor.serialization.kotlinx.json)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation("androidx.multidex:multidex:2.0.1")

}