/**
 * Re-export the typed Inngest client so server actions and route
 * handlers can call `inngest.send(...)` without depending directly on
 * `@nexus/inngest-fns/client` (and thus avoid importing handler code
 * into the bundle that doesn't need it).
 */
export { inngest } from '@nexus/inngest-fns/client';
