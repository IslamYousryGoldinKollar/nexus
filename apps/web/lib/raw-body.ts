/**
 * Helpers for reading a webhook request's raw body.
 *
 * Signature verification REQUIRES the exact bytes the sender signed —
 * parsing to JSON first and re-serializing is unsafe because JSON
 * serializers normalize whitespace, key order, etc. Always call
 * `readRawBody(req)` before `JSON.parse` when a signature is involved.
 */

/** Read the raw request body as a `Uint8Array`. */
export async function readRawBody(req: Request): Promise<Uint8Array> {
  const buf = await req.arrayBuffer();
  return new Uint8Array(buf);
}

/** Read the raw body as a UTF-8 string (lossless because webhooks are UTF-8). */
export async function readRawBodyText(req: Request): Promise<string> {
  const bytes = await readRawBody(req);
  return new TextDecoder('utf-8').decode(bytes);
}

/** Parse JSON from raw bytes. Throws on invalid JSON. */
export function parseJsonFromBytes(bytes: Uint8Array): unknown {
  const text = new TextDecoder('utf-8').decode(bytes);
  return JSON.parse(text);
}
