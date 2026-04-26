#!/usr/bin/env tsx
/**
 * Diagnostic: dump everything ingested in the last 2 hours so we can
 * see what reached the server and what state it's in.
 */
import 'dotenv/config';
import postgres from 'postgres';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL must be set');

  const c = postgres(url, { max: 1 });
  try {
    const recent = await c`
      SELECT
        i.id,
        i.channel,
        i.content_type,
        i.direction,
        i.occurred_at,
        i.session_id IS NULL as orphan,
        i.text IS NOT NULL as has_text,
        substring(i.text, 1, 60) as text_preview,
        i.source_message_id
      FROM interactions i
      WHERE i.occurred_at > now() - interval '2 hours'
      ORDER BY i.occurred_at DESC
      LIMIT 30
    `;
    console.log(`=== Interactions in last 2h: ${recent.length} ===`);
    for (const r of recent) console.log(JSON.stringify(r));

    const sessions = await c`
      SELECT state, count(*)::int as n
      FROM sessions
      WHERE last_activity_at > now() - interval '2 hours'
      GROUP BY state
      ORDER BY n DESC
    `;
    console.log(`\n=== Sessions touched in last 2h ===`);
    for (const s of sessions) console.log(JSON.stringify(s));

    const meetings = await c`
      SELECT id, occurred_at, session_id, text IS NOT NULL as has_text,
             substring(text, 1, 60) as preview
      FROM interactions
      WHERE content_type = 'meeting'
      ORDER BY occurred_at DESC
      LIMIT 5
    `;
    console.log(`\n=== Recent meeting interactions ===`);
    for (const m of meetings) console.log(JSON.stringify(m));
  } finally {
    await c.end();
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
