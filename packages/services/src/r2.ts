import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * R2 client factory for server-side code (Inngest fns, admin actions).
 *
 * Why not share `apps/web/lib/r2.ts`? That module reads `serverEnv`,
 * which is Next.js-scoped. Inngest functions live in @nexus/inngest-fns
 * and need plain `process.env` access without importing Next.
 *
 * Callers pass credentials explicitly; no module-level singleton.
 */

export interface R2Creds {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function createR2Client(creds: R2Creds): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${creds.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
    },
  });
}

export function r2CredsFromEnv(): R2Creds | null {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET ?? 'nexus-attachments';
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

/**
 * Short-lived signed GET URL for an R2 object.
 * Default TTL 15 min — long enough for Whisper's longest upload poll
 * but short enough to minimize leak impact.
 */
export async function signR2GetUrl(
  creds: R2Creds,
  key: string,
  ttlSeconds = 15 * 60,
): Promise<string> {
  const client = createR2Client(creds);
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: creds.bucket, Key: key }),
    { expiresIn: ttlSeconds },
  );
}
