package com.goldinkollar.nexus

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build

/**
 * Application bootstrap — deliberately minimal during launch-crash
 * diagnosis.
 *
 * Removed during diagnosis (will be re-added once the underlying
 * launch crash is identified):
 *   - `Configuration.Provider` interface for WorkManager. The default
 *     auto-init works without it; the only thing we lose is the
 *     debug-vs-release logging level toggle.
 *   - Sentry init (already stubbed in SentryInitializer; the
 *     dependency is also commented out of build.gradle.kts).
 *
 * Kept:
 *   - CrashRecorder global handler, installed in attachBaseContext
 *     BEFORE anything else can throw. So even if the launch dies in
 *     onCreate, the crash report lands on disk for MainActivity to
 *     surface on next launch.
 *   - Notification channels (essential for proposals + recording fg svc).
 */
class NexusApplication : Application() {

    override fun attachBaseContext(base: Context?) {
        super.attachBaseContext(base)
        try {
            CrashRecorder.installGlobalHandler(this)
        } catch (t: Throwable) {
            android.util.Log.w("NexusApp", "CrashRecorder install failed", t)
        }
    }

    override fun onCreate() {
        super.onCreate()
        try {
            SentryInitializer.initialize(this)
        } catch (t: Throwable) {
            CrashRecorder.record(filesDir, "Application.SentryInitializer", t)
            android.util.Log.w("NexusApp", "SentryInitializer threw — ignoring", t)
        }
        try {
            ensureNotificationChannels()
        } catch (t: Throwable) {
            CrashRecorder.record(filesDir, "Application.ensureNotificationChannels", t)
            android.util.Log.w("NexusApp", "ensureNotificationChannels threw — ignoring", t)
        }
    }

    private fun ensureNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_APPROVALS,
                "Approvals",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "New tasks Nexus is asking you to approve."
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_RECORDING,
                "Background recording",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Persistent notice while watching the call-recording folder."
            },
        )
    }

    companion object {
        const val CHANNEL_APPROVALS = "approvals"
        const val CHANNEL_RECORDING = "recording"
    }
}
