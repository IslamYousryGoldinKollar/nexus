#!/usr/bin/env tsx
import 'dotenv/config';
import postgres from 'postgres';

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!;
const c = postgres(url, { max: 1 });
try {
  const byChannel = await c`
    SELECT channel, count(*)::int as n,
           max(occurred_at) as last_seen
    FROM interactions
    WHERE occurred_at > now() - interval '24 hours'
    GROUP BY channel
    ORDER BY last_seen DESC
  `;
  console.log('=== Channels seen last 24h ===');
  for (const r of byChannel) console.log(JSON.stringify(r));

  const lastWA = await c`
    SELECT id, occurred_at, source_message_id, content_type
    FROM interactions
    WHERE channel = 'whatsapp'
    ORDER BY occurred_at DESC
    LIMIT 5
  `;
  console.log('\n=== Last 5 WhatsApp interactions ever ===');
  for (const r of lastWA) console.log(JSON.stringify(r));
} finally {
  await c.end();
}
