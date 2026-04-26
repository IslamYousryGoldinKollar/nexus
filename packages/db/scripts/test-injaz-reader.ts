#!/usr/bin/env tsx
/**
 * Quick smoke-test that the Injaz DB reader returns rows for the
 * clients we care about (Mirna, e&, etc.). Mirrors what
 * runReasoningForSession will see when it fires for a session whose
 * contact has an injaz_party_name set.
 */
import 'dotenv/config';
import { listOpenInjazTasksForClient } from '@nexus/services';

async function main(): Promise<void> {
  const all = await listOpenInjazTasksForClient({});
  console.log(`Total open Injaz tasks: ${all.length}`);
  for (const t of all.slice(0, 5)) {
    console.log(`  - [${t.status}] ${t.title} (client=${t.clientName ?? '—'}, project=${t.projectName ?? '—'})`);
  }

  for (const c of ['e&', 'Mokhtar', 'Saudi Germany Hospital']) {
    const r = await listOpenInjazTasksForClient({ clientName: c });
    console.log(`\nclient="${c}": ${r.length} open tasks`);
    for (const t of r.slice(0, 3)) console.log(`  - ${t.title}`);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
