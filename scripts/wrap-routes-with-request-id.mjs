#!/usr/bin/env node
/**
 * One-shot codemod: wrap every Next.js route handler with withRequestId so
 * `log.*()` calls inside route bodies auto-tag request_id.
 *
 * Skips:
 *   - inngest/route.ts (uses serve() — the inngest SDK manages its own context)
 *   - any file already containing `withRequestId(` or `runWithRequestId(`
 *
 * Idempotent. Run once after the request-id plumbing lands; can be deleted
 * after a successful run + commit.
 *
 * Usage: node scripts/wrap-routes-with-request-id.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..') + '/';

const files = execFileSync('find', [
  `${repoRoot}apps/web/app/api`,
  '-name', 'route.ts',
  '-not', '-path', '*/node_modules/*',
  '-not', '-path', '*/inngest/route.ts',
])
  .toString()
  .split('\n')
  .filter(Boolean);

const HANDLER_RE = /^(export\s+(?:async\s+)?function\s+(GET|POST|PATCH|PUT|DELETE|OPTIONS|HEAD)\s*\([^)]*\)\s*(?::[^{]*)?{)$/m;

let modified = 0;
let skipped = 0;

for (const file of files) {
  let src = readFileSync(file, 'utf8');

  if (src.includes('withRequestId(') || src.includes('runWithRequestId(')) {
    skipped++;
    continue;
  }

  // Find every handler definition
  const handlers = [];
  let m;
  const re = /(^|\n)(export\s+(?:async\s+)?function\s+(GET|POST|PATCH|PUT|DELETE|OPTIONS|HEAD)\s*\(\s*([a-zA-Z_$][\w$]*)\s*(?::\s*[^,)]+)?(?:\s*,\s*\{[^}]*\})?\s*\)\s*(?::\s*[^{]+)?\s*\{)/g;
  while ((m = re.exec(src)) !== null) {
    handlers.push({
      sigStart: m.index + m[1].length,
      sigEnd: m.index + m[0].length,
      method: m[3],
      reqIdent: m[4],
    });
  }

  if (handlers.length === 0) {
    skipped++;
    continue;
  }

  // Walk in reverse so insertions don't invalidate later offsets.
  for (const h of [...handlers].reverse()) {
    // Find the matching closing `}` for this handler.
    let depth = 1;
    let i = h.sigEnd;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      // Skip strings and template literals
      if ((ch === "'" || ch === '"' || ch === '`') && depth > 0) {
        const quote = ch;
        i++;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '\\') i += 2;
          else i++;
        }
      }
      i++;
    }
    if (depth !== 0) continue; // broken; skip this handler

    const bodyEnd = i - 1; // position of the closing `}`
    const bodyStart = h.sigEnd;

    const before = src.slice(0, bodyStart);
    const body = src.slice(bodyStart, bodyEnd);
    const after = src.slice(bodyEnd);

    const wrapped =
      before +
      `\n  return withRequestId(${h.reqIdent}, async () => {` +
      body.replace(/^\n/, '\n') +
      `  });\n` +
      after;

    src = wrapped;
  }

  // Add the import next to the existing `@/lib/logger` import if present,
  // else after the last `from 'next/server'` import.
  const importLine = `import { withRequestId } from '@/lib/request-id';\n`;
  if (src.includes("from '@/lib/logger'")) {
    src = src.replace(
      /(import\s+\{[^}]*\}\s+from\s+'@\/lib\/logger';\n)/,
      `$1${importLine}`,
    );
  } else if (src.includes("from 'next/server'")) {
    // Insert after the last next/server import block.
    src = src.replace(
      /(import\s+[^;]+from\s+'next\/server';\n)(?![\s\S]*from\s+'next\/server')/,
      `$1${importLine}`,
    );
  } else {
    // Prepend
    src = importLine + src;
  }

  writeFileSync(file, src);
  modified++;
  console.log(`wrapped: ${file.replace(repoRoot, '')}`);
}

console.log(`\nmodified ${modified} file(s); skipped ${skipped}`);
