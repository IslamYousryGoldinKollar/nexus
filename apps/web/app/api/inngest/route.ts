import { serve } from 'inngest/next';
import { functions, inngest } from '@nexus/inngest-fns';

/**
 * Inngest serve endpoint. Inngest Cloud pings this URL with signed
 * requests; the SDK verifies signatures using INNGEST_SIGNING_KEY.
 */
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [...functions],
  streaming: 'allow',
});
