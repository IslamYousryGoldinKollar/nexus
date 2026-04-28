package com.goldinkollar.nexus.recording

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.goldinkollar.nexus.data.ContactsRepository
import com.goldinkollar.nexus.data.SessionStore
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentDisposition
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import java.io.File
import java.io.InputStream

/**
 * WorkManager job that uploads one recording to /api/ingest/phone.
 *
 * Two input modes (use exactly one):
 *   - KEY_DOC_URI + KEY_TREE_URI: SAF-picked file (preferred path).
 *     Bytes read via ContentResolver; metadata pulled from the
 *     DocumentsContract row.
 *   - KEY_FILE_PATH: legacy raw filesystem path. Kept for the old
 *     FileObserver flow on devices where the user pinned a public
 *     folder before SAF migration.
 *
 * Backoff: WorkManager applies exponential backoff (default
 * 30s/1m/2m/...) on Result.retry(). We retry on network errors and
 * 5xx; permanent failures (4xx) → Result.failure() so the queue clears.
 *
 * Idempotency on success: the document id is added to
 * [SessionStore.markRecordingSeen] so the polling observer skips it
 * forever after, even across service restarts.
 */
class UploadRecordingWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val store = SessionStore.shared(applicationContext)
        val apiKey = store.apiKey ?: return Result.retry()

        val docUriStr = inputData.getString(KEY_DOC_URI)
        return if (docUriStr != null) {
            uploadFromContentUri(store, apiKey, Uri.parse(docUriStr))
        } else {
            val path = inputData.getString(KEY_FILE_PATH) ?: return Result.failure()
            uploadFromFile(store, apiKey, File(path))
        }
    }

    /**
     * Privacy gate. Returns true when the recording's counterparty is
     * one the user has explicitly opted in to upload. Returns true
     * unconditionally when the master filter is OFF.
     *
     * Two recognition paths:
     *
     *   1. Contact NAME (Android 14+ native recorder writes
     *      "<Display Name>_YYMMDD_HHMMSS.m4a"). We lowercase the
     *      filename and check whether any opted-in normalised name
     *      appears as a substring.
     *
     *   2. Phone NUMBER (third-party recorders + unknown callers).
     *      Parse a +CC… or local Egyptian number out of the filename
     *      and check the phone allowlist.
     *
     * If neither matches, we DROP. Better to miss a recording than to
     * leak a personal call.
     */
    private fun shouldUpload(store: SessionStore, filename: String): Boolean {
        if (!store.recordingFilterEnabled) return true

        // Path 1 — name match. Do this FIRST since the OS recorder
        // produces these by default and they're cheap to check.
        val optedNames = store.optedInRecordingNames()
        if (optedNames.isNotEmpty()) {
            val haystack = filename
                .substringBeforeLast('.')              // strip extension
                .replace(Regex("[_\\-]+"), " ")        // _ and - → space
                .lowercase()
                .replace(Regex("\\s+"), " ")
                .trim()
            for (name in optedNames) {
                if (name.isNotEmpty() && haystack.contains(name)) {
                    Log.i(TAG, "name-match: '$name' in '$filename'")
                    return true
                }
            }
        }

        // Path 2 — phone match.
        val phone = extractPhone(filename)
        if (phone != null && phone in store.optedInRecordingPhones()) {
            Log.i(TAG, "phone-match: $phone in '$filename'")
            return true
        }

        Log.i(TAG, "skipping (no opted-in name or phone): $filename")
        return false
    }

    private fun extractPhone(filename: String): String? {
        // Common patterns we've seen across recorder apps:
        //   +201234567890_2026-04-28.m4a            ← +CC inline
        //   Call_+201234567890_outgoing.m4a         ← +CC with prefix
        //   201234567890_2026-04-28.m4a             ← bare CC
        //   01234567890_2026-04-28.m4a              ← Egypt local
        //
        // Try +CC first (most reliable), then fall back to local.
        val plus = Regex("\\+\\d{8,15}").find(filename)?.value
        if (plus != null) return plus
        val bare = Regex("\\b\\d{8,15}\\b").find(filename)?.value ?: return null
        return ContactsRepository.normalizeE164(bare)
    }

    private suspend fun uploadFromContentUri(
        store: SessionStore,
        apiKey: String,
        docUri: Uri,
    ): Result {
        val resolver = applicationContext.contentResolver
        val meta = queryDocumentMeta(docUri) ?: run {
            Log.w(TAG, "could not read doc meta for $docUri")
            return Result.failure()
        }
        if (meta.size < 1024L) return Result.failure()

        // Privacy filter: skip recordings from contacts not on the
        // opt-in list. We mark the document as 'seen' so the polling
        // observer doesn't re-evaluate it on every tick.
        if (!shouldUpload(store, meta.displayName)) {
            store.markRecordingSeen(meta.documentId)
            return Result.success()
        }

        val bytes = try {
            resolver.openInputStream(docUri)?.use(InputStream::readBytes)
        } catch (t: Throwable) {
            Log.w(TAG, "openInputStream failed for $docUri", t)
            null
        } ?: return Result.retry()

        return doUpload(
            store = store,
            apiKey = apiKey,
            audioBytes = bytes,
            filename = meta.displayName,
            mime = meta.mimeType,
            occurredEpochMs = meta.lastModified,
            onSuccess = { store.markRecordingSeen(meta.documentId) },
        )
    }

    private suspend fun uploadFromFile(
        store: SessionStore,
        apiKey: String,
        file: File,
    ): Result {
        if (!file.exists() || file.length() == 0L) return Result.failure()
        if (!shouldUpload(store, file.name)) return Result.success()
        return doUpload(
            store = store,
            apiKey = apiKey,
            audioBytes = file.readBytes(),
            filename = file.name,
            mime = file.guessMime(),
            occurredEpochMs = file.lastModified(),
            onSuccess = { /* no idempotency tag — legacy path */ },
        )
    }

    private suspend fun doUpload(
        store: SessionStore,
        apiKey: String,
        audioBytes: ByteArray,
        filename: String,
        mime: ContentType,
        occurredEpochMs: Long,
        onSuccess: () -> Unit,
    ): Result {
        val client = HttpClient(OkHttp) {
            install(HttpTimeout) {
                requestTimeoutMillis = 120_000
                connectTimeoutMillis = 10_000
            }
        }
        return runCatching {
            val resp: HttpResponse = client.post(
                store.baseUrl.trimEnd('/') + "/api/ingest/phone",
            ) {
                header(HttpHeaders.Authorization, "Bearer $apiKey")
                setBody(
                    MultiPartFormDataContent(
                        formData {
                            append(
                                key = "audio",
                                value = audioBytes,
                                headers = headersOf(
                                    HttpHeaders.ContentType to listOf(mime.toString()),
                                    HttpHeaders.ContentDisposition to listOf(
                                        ContentDisposition.File
                                            .withParameter("name", "audio")
                                            .withParameter("filename", filename)
                                            .toString(),
                                    ),
                                ),
                            )
                            append("metadata", buildMetadata(filename, occurredEpochMs))
                        },
                    ),
                )
            }
            when {
                resp.status.value in 200..299 -> {
                    onSuccess()
                    Result.success()
                }
                resp.status.value >= 500 || resp.status == HttpStatusCode.RequestTimeout -> Result.retry()
                else -> Result.failure()
            }
        }.getOrElse {
            Log.w(TAG, "upload failed; will retry", it)
            Result.retry()
        }
    }

    private data class DocMeta(
        val documentId: String,
        val displayName: String,
        val mimeType: ContentType,
        val size: Long,
        val lastModified: Long,
    )

    private fun queryDocumentMeta(docUri: Uri): DocMeta? {
        val resolver = applicationContext.contentResolver
        val cursor = resolver.query(
            docUri,
            arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            ),
            null, null, null,
        ) ?: return null
        return cursor.use { c ->
            if (!c.moveToFirst()) return null
            val name = c.getString(1) ?: return null
            DocMeta(
                documentId = c.getString(0) ?: return null,
                displayName = name,
                mimeType = mimeFromString(c.getString(2), name),
                size = if (c.isNull(3)) 0L else c.getLong(3),
                lastModified = if (c.isNull(4)) System.currentTimeMillis() else c.getLong(4),
            )
        }
    }

    private fun mimeFromString(declared: String?, filename: String): ContentType {
        if (declared != null && declared != "application/octet-stream") {
            return runCatching { ContentType.parse(declared) }.getOrNull()
                ?: extensionMime(filename)
        }
        return extensionMime(filename)
    }

    private fun extensionMime(filename: String): ContentType =
        when (filename.substringAfterLast('.', "").lowercase()) {
            "m4a", "mp4" -> ContentType.parse("audio/mp4")
            "mp3" -> ContentType.parse("audio/mpeg")
            "wav" -> ContentType.parse("audio/wav")
            "ogg", "opus" -> ContentType.parse("audio/ogg")
            "amr" -> ContentType.parse("audio/amr")
            "aac" -> ContentType.parse("audio/aac")
            "3gp" -> ContentType.parse("audio/3gpp")
            "flac" -> ContentType.parse("audio/flac")
            else -> ContentType.parse("application/octet-stream")
        }

    private fun File.guessMime(): ContentType = extensionMime(name)

    private fun buildMetadata(filename: String, occurredMs: Long): String {
        // Most recorder apps embed the counterparty number in the
        // filename ("+201234567890_call_2026-04-26.m4a"). Fall back to
        // null when no number is present — server validation requires
        // counterparty + direction + occurredAt + durationSec + callId,
        // so we generate a deterministic callId from the filename so
        // re-uploads dedupe server-side via UNIQUE(channel, source_message_id).
        val counterparty = Regex("\\+?\\d{7,15}").find(filename)?.value?.let {
            if (it.startsWith("+")) it else "+$it"
        }
        val callId = java.util.UUID.nameUUIDFromBytes(
            filename.toByteArray(Charsets.UTF_8),
        ).toString()
        val occurredIso = java.time.Instant.ofEpochMilli(occurredMs).toString()
        return buildString {
            append('{')
            append("\"counterparty\":")
            append(counterparty?.let { "\"$it\"" } ?: "null")
            append(",\"direction\":\"unknown\"")
            append(",\"occurredAt\":\"")
            append(occurredIso)
            append('"')
            append(",\"durationSec\":0")
            append(",\"callId\":\"")
            append(callId)
            append('"')
            append(",\"recorder\":\"saf-picker\"")
            append('}')
        }
    }

    companion object {
        private const val TAG = "RecUpload"
        const val KEY_FILE_PATH = "file_path"
        const val KEY_DOC_URI = "doc_uri"
        const val KEY_TREE_URI = "tree_uri"
    }
}
