package com.goldinkollar.nexus.recording

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
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
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.http.ContentDisposition
import io.ktor.http.ContentType
import java.io.File

/**
 * WorkManager job that uploads one recording file to /api/ingest/phone.
 *
 * Backoff: WorkManager applies exponential backoff (default 30s/1m/2m/...)
 * on Result.retry(). We retry on network errors and 5xx; permanent
 * failures (4xx) → Result.failure() so the queue clears.
 *
 * On success the file is left in place (the recorder app manages
 * retention). Future iteration: tag uploaded files via xattr or a
 * shadow-tracker DB so we never re-upload after a service restart.
 */
class UploadRecordingWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val path = inputData.getString(KEY_FILE_PATH) ?: return Result.failure()
        val file = File(path)
        if (!file.exists() || file.length() == 0L) return Result.failure()

        val store = SessionStore.shared(applicationContext)
        val apiKey = store.apiKey ?: return Result.retry()

        val client = HttpClient(OkHttp) {
            install(HttpTimeout) {
                requestTimeoutMillis = 60_000
                connectTimeoutMillis = 10_000
            }
        }
        return runCatching {
            val resp: HttpResponse = client.post(store.baseUrl.trimEnd('/') + "/api/ingest/phone") {
                header(HttpHeaders.Authorization, "Bearer $apiKey")
                setBody(
                    MultiPartFormDataContent(
                        formData {
                            append(
                                key = "audio",
                                value = file.readBytes(),
                                headers = headersOf(
                                    HttpHeaders.ContentType to listOf(file.mimeType().toString()),
                                    HttpHeaders.ContentDisposition to listOf(
                                        ContentDisposition.File
                                            .withParameter("name", "audio")
                                            .withParameter("filename", file.name)
                                            .toString(),
                                    ),
                                ),
                            )
                            append("metadata", buildMetadata(file))
                        },
                    ),
                )
            }
            if (resp.status.value in 200..299) Result.success()
            else if (resp.status.value >= 500 || resp.status == HttpStatusCode.RequestTimeout) Result.retry()
            else Result.failure()
        }.getOrElse { Result.retry() }
    }

    private fun buildMetadata(file: File): String {
        val occurredMs = file.lastModified()
        // Minimal MVP — counterparty parsed from filename when possible
        // (most recorders embed +countryCodeNumber in the filename).
        val counterparty = Regex("\\+?\\d{7,15}").find(file.name)?.value?.let {
            if (it.startsWith("+")) it else "+$it"
        }
        return """{"counterparty":${counterparty?.let { "\"$it\"" } ?: "null"},"direction":"unknown","occurredAt":"${java.time.Instant.ofEpochMilli(occurredMs)}"}"""
    }

    private fun File.mimeType(): ContentType {
        return when (extension.lowercase()) {
            "m4a", "mp4" -> ContentType.parse("audio/mp4")
            "mp3" -> ContentType.parse("audio/mpeg")
            "wav" -> ContentType.parse("audio/wav")
            "ogg" -> ContentType.parse("audio/ogg")
            "amr" -> ContentType.parse("audio/amr")
            else -> ContentType.parse("application/octet-stream")
        }
    }

    companion object {
        const val KEY_FILE_PATH = "file_path"
    }
}
