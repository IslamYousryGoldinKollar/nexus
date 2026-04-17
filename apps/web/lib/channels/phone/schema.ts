import { z } from 'zod';

/**
 * Metadata field on the multipart upload from the phone recorder.
 *
 * The Android app (Phase 7+) sends call-recording metadata as a JSON
 * string in the `meta` form field alongside the audio file.
 */
export const phoneUploadMetaSchema = z.object({
  /** E.164 phone number of the counterparty. */
  counterparty: z
    .string()
    .regex(/^\+?[1-9]\d{6,15}$/, { message: 'counterparty must be E.164' }),
  direction: z.enum(['inbound', 'outbound']),
  startedAt: z.string().datetime(),
  durationSec: z.coerce.number().int().positive().max(24 * 60 * 60),
  /** Stable per-call id generated on-device (UUID v4). */
  callId: z.string().min(8).max(128),
  /** Optional: name of the recording app / mechanism. Free-form. */
  recorder: z.string().optional(),
  /** Optional: transcription requested? Always true for now; future phases may defer. */
  transcribe: z.boolean().optional().default(true),
});
export type PhoneUploadMeta = z.infer<typeof phoneUploadMetaSchema>;
