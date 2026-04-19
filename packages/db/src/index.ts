export * from './schema/index.js';
export { getDb, getDbUnpooled } from './client.js';
export type { Database } from './client.js';
export * from './queries/interactions.js';
export * from './queries/attachments.js';
export * from './queries/identity.js';
export * from './queries/sessions.js';
export * from './queries/costs.js';
export * from './queries/transcripts.js';
export * from './queries/reasoning.js';
export * from './queries/injaz.js';
export * from './queries/devices.js';

// Re-export common Drizzle operators so downstream packages don't need
// their own drizzle-orm dep. This keeps the dependency graph tidy and
// lets us swap ORM implementations without a fan-out migration.
export { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
