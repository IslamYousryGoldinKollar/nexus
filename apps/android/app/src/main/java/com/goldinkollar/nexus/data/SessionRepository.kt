package com.goldinkollar.nexus.data

import android.content.Context
import com.goldinkollar.nexus.data.database.DatabaseProvider
import com.goldinkollar.nexus.data.database.SessionDao
import com.goldinkollar.nexus.data.database.SessionEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

class SessionRepository(context: Context) {
    private val sessionDao: SessionDao = DatabaseProvider.getDatabase(context).sessionDao()
    private val api = NexusApi("https://nexus.theoffsight.com") { SessionStore.shared(context).apiKey }

    fun getAllSessions(): Flow<List<SessionCard>> {
        return sessionDao.getAllSessions().map { entities ->
            entities.map { entity ->
                SessionCard(
                    sessionId = entity.sessionId,
                    contactName = entity.contactName,
                    state = entity.state,
                    openedAt = entity.openedAt,
                    lastActivityAt = entity.lastActivityAt,
                    tasks = emptyList() // Tasks loaded separately
                )
            }
        }
    }

    fun getSessionById(sessionId: String): Flow<SessionCard?> {
        return sessionDao.getSessionById(sessionId).map { entity ->
            entity?.let {
                SessionCard(
                    sessionId = it.sessionId,
                    contactName = it.contactName,
                    state = it.state,
                    openedAt = it.openedAt,
                    lastActivityAt = it.lastActivityAt,
                    tasks = emptyList()
                )
            }
        }
    }

    suspend fun refreshSessions() {
        try {
            val response = api.getApprovals()
            val entities = response.items.map { session ->
                SessionEntity(
                    sessionId = session.sessionId,
                    contactName = session.contactName,
                    state = session.state,
                    openedAt = session.openedAt,
                    lastActivityAt = session.lastActivityAt,
                    syncedAt = null,
                    updatedAt = session.updatedAt
                )
            }
            sessionDao.insertSessions(entities)
        } catch (e: Exception) {
            // Handle network error - offline mode will use cached data
        }
    }

    suspend fun saveSession(session: SessionCard) {
        val entity = SessionEntity(
            sessionId = session.sessionId,
            contactName = session.contactName,
            state = session.state,
            openedAt = session.openedAt,
            lastActivityAt = session.lastActivityAt,
            syncedAt = null,
            updatedAt = session.updatedAt
        )
        sessionDao.insertSession(entity)
    }
}
