import { type NextRequest, NextResponse } from 'next/server';
import { getDb, interactions as interactionsTable, eq } from '@nexus/db';
import { inngest } from '@nexus/inngest-fns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Admin debug endpoint to replay an interaction through the pipeline.
 * 
 * GET /api/admin/replay-interaction?interactionId=<uuid>
 * 
 * This manually:
 * 1. Loads the interaction from DB
 * 2. Extracts the identifier
 * 3. Shows what would happen
 * 4. Optionally emits the Inngest event
 */
export async function GET(req: NextRequest) {
  // Simple auth check - require ADMIN_API_KEY
  const adminKey = process.env.ADMIN_API_KEY;
  const providedKey = req.headers.get('x-admin-key') || req.nextUrl.searchParams.get('key');
  
  if (!adminKey || providedKey !== adminKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const interactionId = req.nextUrl.searchParams.get('interactionId');
  if (!interactionId) {
    return NextResponse.json({ error: 'Missing interactionId' }, { status: 400 });
  }

  try {
    // Load interaction
    const db = getDb();
    const [interaction] = await db
      .select()
      .from(interactionsTable)
      .where(eq(interactionsTable.id, interactionId))
      .limit(1);

    if (!interaction) {
      return NextResponse.json({ error: 'Interaction not found' }, { status: 404 });
    }

    const raw = interaction.rawPayload as Record<string, unknown>;
    const rawKey = (raw?.raw as Record<string, unknown> | undefined)?.key as Record<string, unknown> | undefined;
    
    const result: Record<string, unknown> = {
      interactionId,
      channel: interaction.channel,
      sourceMessageId: interaction.sourceMessageId,
      contentType: interaction.contentType,
      rawPayloadPreview: {
        id: raw?.id,
        from: raw?.from,
        'raw.key.senderPn': rawKey?.senderPn,
        'raw.key.remoteJid': rawKey?.remoteJid,
        'raw.pushName': (raw?.raw as Record<string, unknown> | undefined)?.pushName,
        type: raw?.type,
      },
      contactId: interaction.contactId,
      sessionId: interaction.sessionId,
    };

    // If emit=true, also fire the Inngest event
    const shouldEmit = req.nextUrl.searchParams.get('emit') === 'true';
    if (shouldEmit) {
      const event = await inngest.send({
        name: 'nexus/interaction.ingested',
        data: {
          interactionId: interaction.id,
          channel: interaction.channel,
          sourceMessageId: interaction.sourceMessageId,
          occurredAt: interaction.occurredAt.toISOString(),
        },
      });
      result.eventEmitted = event;
    }

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, stack: (err as Error).stack },
      { status: 500 }
    );
  }
}
