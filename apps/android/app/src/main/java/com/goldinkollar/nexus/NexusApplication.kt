package com.goldinkollar.nexus

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.work.Configuration

class NexusApplication : Application(), Configuration.Provider {

    override fun attachBaseContext(base: Context?) {
        super.attachBaseContext(base)
        // Install BEFORE anything else can throw. Captures crashes in
        // any thread and persists them to the no-backup files dir so
        // MainActivity can render them on next launch.
        try {
            CrashRecorder.installGlobalHandler(this)
        } catch (t: Throwable) {
            android.util.Log.w("NexusApp", "CrashRecorder install failed", t)
        }
    }

    override fun onCreate() {
        super.onCreate()
        // Each step wrapped so a single failure doesn't kill the app.
        // Anything that DOES escape gets captured by the global handler
        // installed in attachBaseContext.
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

    // WorkManager configuration — keep logging quiet in release.
    override val workManagerConfiguration: Configuration =
        Configuration.Builder()
            .setMinimumLoggingLevel(if (BuildConfig.DEBUG) android.util.Log.DEBUG else android.util.Log.INFO)
            .build()

    companion object {
        const val CHANNEL_APPROVALS = "approvals"
        const val CHANNEL_RECORDING = "recording"
    }
}
