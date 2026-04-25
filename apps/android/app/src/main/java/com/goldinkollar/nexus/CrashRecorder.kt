package com.goldinkollar.nexus

import android.content.Context
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

/**
 * Persists the most recent uncaught throwable to a file under the
 * app's no-backup files dir. The next launch reads that file and
 * surfaces the report on screen instead of the generic OS crash
 * dialog (which we can't screenshot useful info from).
 *
 * Designed to be safe to call at any lifecycle phase — no Compose,
 * no coroutines, no Android UI deps. File I/O is wrapped in
 * try/catch because if crash reporting itself crashes we'd be
 * useless.
 *
 * Tested in `CrashRecorderTest` (JVM-only, uses a temp dir).
 */
object CrashRecorder {
    private const val CRASH_FILE_NAME = "last-crash.txt"
    private const val MAX_BYTES = 64 * 1024

    /**
     * Persist a throwable + a contextual `where` tag (e.g. "Application.onCreate")
     * to disk under [baseDir]. Truncates over [MAX_BYTES] so a runaway
     * stack-trace doesn't fill the disk.
     *
     * Returns true on success, false if I/O failed.
     */
    fun record(baseDir: File, where: String, throwable: Throwable): Boolean {
        return try {
            val sw = StringWriter()
            PrintWriter(sw).use { pw ->
                pw.println("at: ${System.currentTimeMillis()}")
                pw.println("where: $where")
                pw.println("type: ${throwable.javaClass.name}")
                pw.println("message: ${throwable.message ?: "(none)"}")
                pw.println("---stack---")
                throwable.printStackTrace(pw)
            }
            val text = sw.toString()
            val payload = if (text.length > MAX_BYTES) text.substring(0, MAX_BYTES) else text
            crashFile(baseDir).writeText(payload)
            true
        } catch (_: Throwable) {
            false
        }
    }

    /** Read and DELETE the crash report. Returns null if no report exists. */
    fun consume(baseDir: File): String? {
        val f = crashFile(baseDir)
        if (!f.exists()) return null
        return try {
            val text = f.readText()
            f.delete()
            text
        } catch (_: Throwable) {
            null
        }
    }

    /** Peek at the report without deleting it. Used by tests. */
    fun peek(baseDir: File): String? {
        val f = crashFile(baseDir)
        if (!f.exists()) return null
        return try {
            f.readText()
        } catch (_: Throwable) {
            null
        }
    }

    private fun crashFile(baseDir: File): File = File(baseDir, CRASH_FILE_NAME)

    /**
     * Install a default uncaught-exception handler that records the
     * throwable then re-delegates to whatever handler was previously
     * installed (so Sentry / Android default still gets a chance to
     * log it). Idempotent — calling twice is safe.
     */
    fun installGlobalHandler(context: Context) {
        val baseDir = context.filesDir
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            record(baseDir, "Thread:${thread.name}", throwable)
            previous?.uncaughtException(thread, throwable)
        }
    }
}
