package com.goldinkollar.nexus

import android.content.Context
import io.sentry.Sentry
import io.sentry.android.core.SentryAndroid
import io.sentry.android.core.SentryAndroidOptions

object SentryInitializer {
    fun initialize(context: Context) {
        SentryAndroid.init(context) { options ->
            options.dsn = "https://examplePublicKey@o0.ingest.sentry.io/0"
            options.environment = if (BuildConfig.DEBUG) "development" else "production"
            options.sessionTrackingIntervalMillis = 30000
            options.enablePerformanceV2 = true
            options.attachScreenshot = true
            options.attachViewHierarchy = true
            options.beforeSend = { event, hint ->
                // Filter out sensitive data before sending
                event
            }
        }
    }
}
