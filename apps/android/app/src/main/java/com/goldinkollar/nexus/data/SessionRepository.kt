package com.goldinkollar.nexus.data

import android.content.Context
import com.goldinkollar.nexus.data.database.DatabaseProvider
import com.goldinkollar.nexus.data.database.SessionDao
import com.goldinkollar.nexus.data.database.SessionEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * Offline cache for the approvals queue. Reads come from Room; writes
 * are populated by `refreshSessions()` after a successful API call.
 *
 * The server's `SessionCard` payload (see NexusApi.kt) currently exposes
 * only sessionId / contactName / lastActivityAt / tasks. Until the API
 * adds richer fields we synthesize the rest with safe defaults so the
 * Room schema stays stable.
 */
class SessionRepository(context: Context) {
    private val sessionDao: SessionDao = DatabaseProvider.getDatabase(context).sessionDao()
    private val store = SessionStore.shared(context)
    private val api = NexusApi(store.baseUrl) { store.apiKey }

    fun getAllSessions(): Flow<List<CachedSession>> {
        return sessionDao.getAllSessions().map { entities ->
            entities.map { it.toCached() }
        }
    }

    fun getSessionById(sessionId: String): Flow<CachedSession?> {
        return sessionDao.getSessionById(sessionId).map { entity -> entity?.toCached() }
    }

    suspend fun refreshSessions() {
        try {
            val response = api.getApprovals()
            val now = response.fetchedAt
            val entities = response.items.map { session ->
                SessionEntity(
                    sessionId = session.sessionId,
                    contactName = session.contactName,
                    state = "awaiting_approval",
                    openedAt = session.lastActivityAt,
                    lastActivityAt = session.lastActivityAt,
                    syncedAt = now,
                    updatedAt = session.lastActivityAt,
                )
            }
            sessionDao.insertSessions(entities)
        } catch (_: Exception) {
            // Network error — UI falls back to cached data.
        }
    }
}

/** UI-facing snapshot of a cached session row. */
data class CachedSession(
    val sessionId: String,
    val contactName: String?,
    val state: String,
    val openedAt: String,
    val lastActivityAt: String,
    val updatedAt: String,
)

private fun SessionEntity.toCached(): CachedSession =
    CachedSession(
        sessionId = sessionId,
        contactName = contactName,
        state = state,
        openedAt = openedAt,
        lastActivityAt = lastActivityAt,
        updatedAt = updatedAt,
    )
