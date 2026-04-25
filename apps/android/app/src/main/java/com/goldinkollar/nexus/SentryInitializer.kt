package com.goldinkollar.nexus

import android.content.Context
import android.util.Log

/**
 * Sentry crash reporting bootstrap.
 *
 * INTENTIONALLY a no-op stub right now. Importing
 * `io.sentry.android.core.SentryAndroid` was a suspect for the launch
 * crash (the SDK ships native libs and a startup ContentProvider; some
 * Samsung One UI / API 35 builds fail to load it). To eliminate
 * Sentry as a variable, this object holds NO references to any Sentry
 * class. The `io.sentry:sentry-android` dependency is also dropped from
 * build.gradle.kts — re-add when ready to wire up real crash capture.
 */
object SentryInitializer {
    fun initialize(context: Context) {
        Log.i("SentryInitializer", "Sentry currently disabled at this build")
    }
}
