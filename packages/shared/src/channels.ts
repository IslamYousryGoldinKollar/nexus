/**
 * Channel constants — the five surfaces Nexus ingests from.
 * Kept separate from the Drizzle enum so app code can reference
 * channel identifiers without importing the DB package.
 */
export const CHANNELS = ['whatsapp', 'gmail', 'telegram', 'phone', 'teams'] as const;
export type Channel = (typeof CHANNELS)[number];

export const DIRECTIONS = ['inbound', 'outbound', 'internal'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const CONTENT_TYPES = [
  'text',
  'audio',
  'image',
  'video',
  'file',
  'email_body',
  'call',
  'meeting',
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

export const IDENTIFIER_KINDS = [
  'phone',
  'email',
  'whatsapp_wa_id',
  'telegram_user_id',
  'teams_user_id',
] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];
