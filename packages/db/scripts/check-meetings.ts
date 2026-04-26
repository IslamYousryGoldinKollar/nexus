#!/usr/bin/env tsx
/**
 * Diagnostic: list any meeting-channel interactions in the last day,
 * with their session state + transcript / proposed-task counts.
 * Used to confirm whether a Chrome-extension meeting upload reached
 * the server end-to-end.
 */
import 'dotenv/config';
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL must be set');

  const client = postgres(url, { max: 1 });
  try {
    const meetings = await client`
      SELECT
        i.id          as interaction_id,
        i.session_id,
        i.channel,
        i.content_type,
        i.occurred_at,
        i.text IS NOT NULL as has_text,
        s.state       as session_state,
        a.id          as attachment_id,
        a.size_bytes  as bytes,
        t.id          as transcript_id,
        substring(t.text, 1, 80) as transcript_preview
      FROM interactions i
      LEFT JOIN sessions s ON s.id = i.session_id
      LEFT JOIN attachments a ON a.interaction_id = i.id
      LEFT JOIN transcripts t ON t.attachment_id = a.id
      WHERE i.content_type = 'meeting'
      ORDER BY i.occurred_at DESC
      LIMIT 10
    `;
    console.log(`Found ${meetings.length} meeting interactions:`);
    for (const m of meetings) {
      console.log(JSON.stringify(m, null, 2));
    }

    if (meetings.length === 0) {
      console.log('\n--- No meetings. Checking for any teams-channel interactions ---');
      const teams = await client`
        SELECT id, content_type, occurred_at, raw_payload->>'source' as source
        FROM interactions
        WHERE channel = 'teams'
        ORDER BY occurred_at DESC
        LIMIT 5
      `;
      for (const t of teams) console.log(JSON.stringify(t, null, 2));
    }
  } finally {
    await client.end();
  }
}

void main().catch((e) => {
  console.error('check-meetings failed:', e);
  process.exit(1);
});
