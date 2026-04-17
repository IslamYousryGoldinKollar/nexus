/**
 * Enum constants shared between DB layer and app layer.
 * These MUST stay in sync with pgEnum definitions in packages/db/src/schema/enums.ts.
 */

export const SESSION_STATES = [
  'open',
  'aggregating',
  'reasoning',
  'awaiting_approval',
  'approved',
  'rejected',
  'synced',
  'closed',
  'error',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_TRIGGERS = ['silence_timeout', 'manual', 'cron', 'command'] as const;
export type SessionTrigger = (typeof SESSION_TRIGGERS)[number];

export const PROPOSED_TASK_STATES = [
  'proposed',
  'approved',
  'edited',
  'rejected',
  'synced',
] as const;
export type ProposedTaskState = (typeof PROPOSED_TASK_STATES)[number];

export const PRIORITIES = ['low', 'med', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const SYNC_STATES = ['pending', 'synced', 'drift', 'deleted'] as const;
export type SyncState = (typeof SYNC_STATES)[number];

export const APPROVAL_ACTIONS = ['approved', 'edited', 'rejected', 'commented'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const PENDING_IDENTIFIER_STATES = [
  'pending',
  'linked',
  'new_contact_created',
  'ignored',
] as const;
export type PendingIdentifierState = (typeof PENDING_IDENTIFIER_STATES)[number];

export const TRANSCRIPT_PROVIDERS = ['whisper', 'assemblyai'] as const;
export type TranscriptProvider = (typeof TRANSCRIPT_PROVIDERS)[number];

export const USER_ROLES = ['super_admin', 'approver', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const DEVICE_PLATFORMS = ['android', 'ios', 'web'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

export const NOTIFICATION_KINDS = [
  'proposal',
  'pending_identifier',
  'session_error',
  'cost_warn',
  'cost_exceeded',
  'injaz_sync_fail',
  'digest',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const COST_SERVICES = [
  'anthropic',
  'openai_whisper',
  'assemblyai',
  'r2',
  'other',
] as const;
export type CostService = (typeof COST_SERVICES)[number];
