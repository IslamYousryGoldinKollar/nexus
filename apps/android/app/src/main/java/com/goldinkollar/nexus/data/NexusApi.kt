package com.goldinkollar.nexus.data

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Ktor-based REST client.
 *
 * Per-request `Authorization: Bearer ...` headers are injected from
 * `SessionStore` by every call site (no global state — easier to test).
 */
class NexusApi(
    private val baseUrl: String,
    private val tokenProvider: () -> String?,
) {

    private val client: HttpClient = HttpClient(OkHttp) {
        install(ContentNegotiation) {
            // classDiscriminator = "action" matches the server's z.discriminatedUnion('action', …)
            // schema in apps/web/app/api/approvals/[id]/action/route.ts. Without this the
            // default 'type' discriminator is sent and the server rejects with invalid_payload.
            //
            // encodeDefaults = true so properties with default values (e.g. PairClaimRequest.platform
            // = "android") are written into the JSON. Without this the server got requests
            // missing the `platform` field and Zod returned 400.
            json(Json {
                ignoreUnknownKeys = true
                explicitNulls = false
                encodeDefaults = true
                classDiscriminator = "action"
            })
        }
        install(HttpTimeout) {
            requestTimeoutMillis = 15_000
            connectTimeoutMillis = 5_000
        }
        defaultRequest {
            url(baseUrl.trimEnd('/') + "/")
            tokenProvider()?.let { header(HttpHeaders.Authorization, "Bearer $it") }
        }
    }

    suspend fun pairClaim(req: PairClaimRequest): PairClaimResponse {
        val resp = client.post("api/devices/pair-claim") {
            contentType(ContentType.Application.Json)
            setBody(req)
        }
        if (resp.status.isSuccess()) return resp.body()
        // Surface the actual server error (status + body text) instead
        // of letting Ktor's content-negotiation try to deserialize the
        // error JSON as a PairClaimResponse and throw the cryptic
        // "Fields [deviceId, apiKey, userId] are required" message.
        val body = runCatching { resp.bodyAsText() }.getOrDefault("")
        val short = body.take(300).ifBlank { "(empty body)" }
        throw IllegalStateException("Pairing failed (${resp.status.value}): $short")
    }

    suspend fun updateFcmToken(token: String) {
        client.put("api/devices/me/fcm-token") {
            contentType(ContentType.Application.Json)
            setBody(FcmUpdate(token))
        }
    }

    suspend fun getApprovals(): ApprovalsResponse =
        client.get("api/approvals").body()

    suspend fun act(taskId: String, action: ApprovalAction) {
        client.post("api/approvals/$taskId/action") {
            contentType(ContentType.Application.Json)
            setBody(action)
        }
    }
}

@Serializable
data class PairClaimRequest(
    val code: String,
    val name: String,
    val platform: String = "android",
    val fcmToken: String? = null,
)

@Serializable
data class PairClaimResponse(
    val deviceId: String,
    val apiKey: String,
    val userId: String,
)

@Serializable data class FcmUpdate(val fcmToken: String)

@Serializable
data class ApprovalsResponse(
    val deviceId: String,
    val fetchedAt: String,
    val items: List<SessionCard>,
)

@Serializable
data class SessionCard(
    val sessionId: String,
    val contactName: String?,
    val lastActivityAt: String,
    val tasks: List<TaskCard>,
)

@Serializable
data class TaskCard(
    val id: String,
    val title: String,
    val description: String,
    val priority: String,
    val rationale: String?,
    val evidence: List<Evidence> = emptyList(),
    val state: String,
)

@Serializable data class Evidence(val interactionId: String, val quote: String)

@Serializable
sealed class ApprovalAction {
    @Serializable @kotlinx.serialization.SerialName("approve")
    object Approve : ApprovalAction()

    @Serializable @kotlinx.serialization.SerialName("reject")
    data class Reject(val reason: String? = null) : ApprovalAction()

    @Serializable @kotlinx.serialization.SerialName("edit")
    data class Edit(val title: String, val description: String) : ApprovalAction()
}
