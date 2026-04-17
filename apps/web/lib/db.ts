import { getDb, getDbUnpooled, type Database } from '@nexus/db';

/**
 * Re-export typed DB accessors so route handlers don't need to pull from
 * `@nexus/db` directly. Keeps the blast radius small when we eventually
 * wrap these (telemetry, tenant scoping, etc.).
 */
export { getDb, getDbUnpooled };
export type { Database };
