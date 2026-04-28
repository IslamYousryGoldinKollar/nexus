import { NextResponse, type NextRequest } from 'next/server';
import { getDb, attachments, eq } from '@nexus/db';
import { signSupabaseGetUrl, supabaseStorageCredsFromEnv } from '@nexus/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * @deprecated TEMPORARY diagnostic — fetches an attachment from
 * storage, dumps its first 32 bytes as hex/ascii, and runs the same
 * sniff function the Whisper service uses. Lets us answer "what
 * format is this file actually" without modifying the prod path.
 *
 * GET /api/admin/sniff-attachment?key=<ADMIN_API_KEY>&id=<attachment_id>
 */
export async function GET(req: NextRequest) {
  const adminKey = process.env.ADMIN_API_KEY?.trim();
  const provided = (
    req.headers.get('x-admin-key') ||
    req.nextUrl.searchParams.get('key') ||
    ''
  ).trim();
  if (!adminKey || provided !== adminKey) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 });

  const db = getDb();
  const [att] = await db
    .select({ id: attachments.id, r2Key: attachments.r2Key, mimeType: attachments.mimeType })
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1);
  if (!att) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const creds = supabaseStorageCredsFromEnv();
  if (!creds) return NextResponse.json({ error: 'no_storage_creds' }, { status: 500 });

  const url = await signSupabaseGetUrl(creds, att.r2Key, 60);
  const res = await fetch(url);
  if (!res.ok) {
    return NextResponse.json({ error: `download failed: ${res.status}` }, { status: 502 });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.subarray(0, 32);

  // Reproduce sniffAudioExtension inline so we can see what it returns
  // for THIS specific file without poking through service exports.
  const sniff = (b: Buffer): string | null => {
    if (b.length < 12) return null;
    if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'm4a';
    if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'ogg';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
        && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return 'wav';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
    if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return 'flac';
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3';
    if (b[0] === 0xff && b[1] !== undefined && (b[1] & 0xe0) === 0xe0) return 'mp3';
    return null;
  };

  return NextResponse.json({
    attachmentId: att.id,
    r2Key: att.r2Key,
    declaredMime: att.mimeType,
    size: buf.length,
    firstHex: head.toString('hex'),
    firstAscii: head.toString('ascii').replace(/[^\x20-\x7E]/g, '.'),
    sniffed: sniff(buf),
  });
}
