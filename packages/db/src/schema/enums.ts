import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * All DB-level enums. Keep in sync with packages/shared/src/enums.ts.
 * We define them here (single source of truth for the DB) and
 * re-export string-literal types from @nexus/shared for app code.
 */

// --- Channels / content ---
export const channelEnum = pgEnum('channel', [
  'whatsapp',
  'gmail',
  'telegram',
  'phone',
  'teams',
]);

export const directionEnum = pgEnum('direction', ['inbound', 'outbound', 'internal']);

export const contentTypeEnum = pgEnum('content_type', [
  'text',
  'audio',
  'image',
  'video',
  'file',
  'email_body',
  'call',
  'meeting',
]);

export const identifierKindEnum = pgEnum('identifier_kind', [
  'phone',
  'email',
  'whatsapp_wa_id',
  'telegram_user_id',
  'teams_user_id',
]);

// --- Sessions ---
export const sessionStateEnum = pgEnum('session_state', [
  'open',
  'aggregating',
  'reasoning',
  'awaiting_approval',
  'approved',
  'rejected',
  'synced',
  'closed',
  'error',
]);

export const sessionTriggerEnum = pgEnum('session_trigger', [
  'silence_timeout',
  'manual',
  'cron',
  'command',
]);

// --- Tasks / reasoning ---
export const priorityEnum = pgEnum('priority', ['low', 'med', 'high', 'urgent']);

export const proposedTaskStateEnum = pgEnum('proposed_task_state', [
  'proposed',
  'approved',
  'edited',
  'rejected',
  'synced',
]);

export const syncStateEnum = pgEnum('sync_state', ['pending', 'synced', 'drift', 'deleted']);

export const approvalActionEnum = pgEnum('approval_action', [
  'approved',
  'edited',
  'rejected',
  'commented',
]);

// --- Identity ---
export const pendingIdentifierStateEnum = pgEnum('pending_identifier_state', [
  'pending',
  'linked',
  'new_contact_created',
  'ignored',
]);

// --- Transcription ---
export const transcriptProviderEnum = pgEnum('transcript_provider', [
  'whisper',
  'assemblyai',
]);

// --- Users / devices / notifications ---
export const userRoleEnum = pgEnum('user_role', ['super_admin', 'approver', 'viewer']);

export const devicePlatformEnum = pgEnum('device_platform', ['android', 'ios', 'web']);

export const notificationKindEnum = pgEnum('notification_kind', [
  'proposal',
  'pending_identifier',
  'session_error',
  'cost_warn',
  'cost_exceeded',
  'injaz_sync_fail',
  'digest',
]);

// --- Costs ---
export const costServiceEnum = pgEnum('cost_service', [
  'anthropic',
  'openai',
  'openai_whisper',
  'assemblyai',
  'r2',
  'other',
]);
