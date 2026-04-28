import { z } from 'zod';

/**
 * Metadata field on the multipart upload from the phone recorder.
 *
 * The Android app (Phase 7+) sends call-recording metadata as a JSON
 * string in the `meta` form field alongside the audio file. This
 * schema is intentionally permissive — the on-device recorder
 * doesn't always know all five things we'd love to have:
 *
 *   - counterparty: only present when the filename contains a phone
 *     number. With Android-14+'s native recorder the filename is the
 *     contact's display name, so phone extraction returns null. We
 *     accept that and let downstream identifier resolution try to
 *     resolve via name later.
 *   - direction: extracted heuristically from filename keywords
 *     ("_in_"/"_outgoing_"/etc). Defaults to `internal` when unclear
 *     so the DB enum is happy.
 *   - durationSec: pulled from MediaMetadataRetriever when available;
 *     otherwise 0. The reasoner doesn't actually use this for anything
 *     critical.
 *
 * `callId` + `startedAt` are the only truly required bits.
 */
export const phoneUploadMetaSchema = z.object({
  /** E.164 phone number of the counterparty, when extractable. */
  counterparty: z
    .string()
    .regex(/^\+?[1-9]\d{6,15}$/, { message: 'counterparty must be E.164' })
    .nullable()
    .optional(),
  direction: z
    .enum(['inbound', 'outbound', 'internal'])
    .optional()
    .default('internal'),
  startedAt: z.string().datetime(),
  durationSec: z.coerce.number().int().nonnegative().max(24 * 60 * 60).optional().default(0),
  /** Stable per-call id generated on-device (UUID v4). */
  callId: z.string().min(8).max(128),
  /** Optional: name of the recording app / mechanism. Free-form. */
  recorder: z.string().optional(),
  /** Optional: transcription requested? Always true for now; future phases may defer. */
  transcribe: z.boolean().optional().default(true),
});
export type PhoneUploadMeta = z.infer<typeof phoneUploadMetaSchema>;
