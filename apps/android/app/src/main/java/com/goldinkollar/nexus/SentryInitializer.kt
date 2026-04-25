package com.goldinkollar.nexus

import android.content.Context
import io.sentry.SentryEvent
import io.sentry.SentryOptions
import io.sentry.android.core.SentryAndroid

/**
 * Sentry crash reporting bootstrap.
 *
 * No-ops if `BuildConfig.SENTRY_DSN` is empty (which it is by default —
 * the dsn lives in BuildConfig instead of source so we don't leak it).
 * Set the dsn via a Gradle property or release build config when ready
 * to enable crash capture.
 */
object SentryInitializer {
    fun initialize(context: Context) {
        SentryAndroid.init(context) { options ->
            // Placeholder DSN. Replace with the real value via a Gradle
            // BuildConfig field or env var before shipping crash capture.
            options.dsn = ""
            options.environment = if (BuildConfig.DEBUG) "development" else "production"
            options.sessionTrackingIntervalMillis = 30_000
            options.tracesSampleRate = if (BuildConfig.DEBUG) 1.0 else 0.1
            options.beforeSend =
                SentryOptions.BeforeSendCallback { event: SentryEvent, _ -> event }
        }
    }
}
