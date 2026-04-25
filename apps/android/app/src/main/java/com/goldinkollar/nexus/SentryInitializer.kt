package com.goldinkollar.nexus

import android.content.Context
import android.util.Log
import io.sentry.SentryEvent
import io.sentry.SentryOptions
import io.sentry.android.core.SentryAndroid

/**
 * Sentry crash reporting bootstrap. No-ops cleanly when no DSN is
 * configured (the common case in dev / first-install) so the app
 * doesn't crash at launch with `IllegalArgumentException: DSN is
 * required`.
 *
 * To enable: set a real DSN here (or wire it through BuildConfig from
 * a Gradle property).
 */
object SentryInitializer {
    private const val DSN: String = "" // Set to your Sentry project DSN to enable.

    fun initialize(context: Context) {
        if (DSN.isBlank()) {
            Log.i("SentryInitializer", "DSN not configured — skipping Sentry init")
            return
        }
        try {
            SentryAndroid.init(context) { options ->
                options.dsn = DSN
                options.environment = if (BuildConfig.DEBUG) "development" else "production"
                options.sessionTrackingIntervalMillis = 30_000
                options.tracesSampleRate = if (BuildConfig.DEBUG) 1.0 else 0.1
                options.beforeSend =
                    SentryOptions.BeforeSendCallback { event: SentryEvent, _ -> event }
            }
        } catch (t: Throwable) {
            // Belt and suspenders — never let crash reporting itself crash the app.
            Log.w("SentryInitializer", "Sentry init failed; continuing without crash reporting", t)
        }
    }
}
