import { type NextRequest, NextResponse } from 'next/server';
import {
  getDb,
  interactions as interactionsTable,
  contacts,
  contactIdentifiers,
  sessions,
  attachments,
  transcripts,
  eq,
  and,
} from '@nexus/db';
import { supabaseStorageCredsFromEnv, signSupabaseGetUrl } from '@nexus/services';
import { transcribe } from '@nexus/services';
import { checkRateLimit, strictRateLimiter } from '@/lib/rate-limit';
import { log } from '@/lib/logger';
import { withRequestId } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * @deprecated TEMPORARY workaround for an Inngest pipeline issue
 * (suspected env-var newline corruption — fixed in commit `d420e9a`).
 * Slated for removal once `nexus/interaction.ingested` events deliver
 * end-to-end in prod. See `docs/runbook.md` § "Debug endpoints (temporary)".
 *
 * Direct process endpoint - runs the FULL pipeline logic directly without Inngest.
 * This completely bypasses the Inngest webhook transform issue.
 *
 * GET /api/admin/direct-process?interactionId=<uuid>&dryRun=true
 *
 * Phases executed:
 * 1. Identity resolution (extract phone from Baileys payload)
 * 2. Contact creation (if new phone)
 * 3. Session creation/attachment
 * 4. Audio transcription (if voice note)
 *
 * NOTE: Phase 4 (reasoning) and Phase 6 (Injaz sync) still require Inngest
 * but this gets messages through the critical Phases 2-3.
 */
export async function GET(req: NextRequest) {
  return withRequestId(req, async () => {
    // Rate limiting for admin endpoints
    const rateLimit = checkRateLimit(req, strictRateLimiter);
    if (!rateLimit.allowed) {
      log.warn('admin.direct-process.rate_limited');
      return NextResponse.json(
        { error: 'Rate limited' },
        { status: 429, headers: { 'X-RateLimit-Remaining': rateLimit.remaining.toString() } },
      );
    }

    const adminKey = process.env.ADMIN_API_KEY?.trim();
    const providedKey = (req.headers.get('x-admin-key') || req.nextUrl.searchParams.get('key') || '').trim();

    if (!adminKey || providedKey !== adminKey) {
      log.warn('admin.direct-process.unauthorized');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const interactionId = req.nextUrl.searchParams.get('interactionId');
    const dryRun = req.nextUrl.searchParams.get('dryRun') !== 'false';

    if (!interactionId) {
      return NextResponse.json({ error: 'Missing interactionId' }, { status: 400 });
    }

    const db = getDb();
    const results: {
      interactionId: string;
      dryRun: boolean;
      phases: Record<string, unknown>;
      interaction?: Record<string, unknown>;
      error?: string;
    } = {
      interactionId,
      dryRun,
      phases: {},
    };

    try {
      // === PHASE 1: Load interaction ===
      const [interaction] = await db
        .select()
        .from(interactionsTable)
        .where(eq(interactionsTable.id, interactionId))
        .limit(1);

      if (!interaction) {
        return NextResponse.json({ error: 'Interaction not found' }, { status: 404 });
      }

      results.interaction = {
        id: interaction.id,
        channel: interaction.channel,
        contentType: interaction.contentType,
        sourceMessageId: interaction.sourceMessageId,
        hasContact: !!interaction.contactId,
        hasSession: !!interaction.sessionId,
      };

      // === PHASE 2: Extract identifier ===
      const raw = interaction.rawPayload as Record<string, unknown>;
      const rawInner = raw?.raw as Record<string, unknown> | undefined;
      const key = rawInner?.key as Record<string, unknown> | undefined;

      const senderPn = typeof key?.senderPn === 'string' ? key.senderPn : null;
      const participantPn = typeof key?.participantPn === 'string' ? key.participantPn : null;
      const participant = typeof key?.participant === 'string' ? key.participant : null;
      const remoteJid = typeof key?.remoteJid === 'string' ? key.remoteJid : null;
      const pushName = typeof rawInner?.pushName === 'string' ? rawInner.pushName : null;
      const fromField = typeof raw.from === 'string' ? raw.from : null;

      const stripJid = (s: string | null): string | null => {
        if (!s) return null;
        const at = s.split('@')[0] ?? '';
        return (at.split(':')[0] ?? '') || null;
      };

      const isPhoneAddr = (s: string | null): s is string =>
        !!s && !s.includes('@lid') && !s.includes('@g.us') && !s.includes('@broadcast');

      // Mirror the order in extract-identifier.ts:
      // senderPn > participantPn > participant > remoteJid > from
      const candidates = [senderPn, participantPn, participant, remoteJid, fromField].filter(
        isPhoneAddr,
      );

      let phoneNumber: string | null = null;
      for (const cand of candidates) {
        const digits = stripJid(cand);
        if (digits && digits.length >= 7 && digits.length <= 15) {
          phoneNumber = digits.startsWith('+') ? digits : '+' + digits;
          break;
        }
      }

      results.phases['extractIdentifier'] = {
        success: !!phoneNumber,
        phoneNumber,
        candidates,
        pushName,
      };

      if (!phoneNumber) {
        return NextResponse.json(
          {
            error: 'Could not extract phone number from payload',
            results,
          },
          { status: 400 },
        );
      }

      // === PHASE 3: Find or create contact ===
      let contactId = interaction.contactId;

      if (!contactId) {
        // Check for existing contact by identifier
        const [existingId] = await db
          .select({ contactId: contactIdentifiers.contactId })
          .from(contactIdentifiers)
          .where(
            and(
              eq(contactIdentifiers.kind, 'whatsapp_wa_id'),
              eq(contactIdentifiers.value, phoneNumber),
            ),
          )
          .limit(1);

        if (existingId) {
          contactId = existingId.contactId;
          results.phases['contactResolution'] = {
            action: 'found_existing',
            contactId,
          };
        } else if (!dryRun) {
          // Create new contact
          const newContacts = await db
            .insert(contacts)
            .values({
              displayName: pushName || phoneNumber,
            })
            .returning({ id: contacts.id });

          if (!newContacts[0]) throw new Error('Failed to create contact');
          contactId = newContacts[0].id;

          // Create contact identifier
          await db.insert(contactIdentifiers).values({
            contactId,
            kind: 'whatsapp_wa_id',
            value: phoneNumber,
            verified: true,
            source: 'whatsapp_bridge',
          });

          results.phases['contactResolution'] = {
            action: 'created_new',
            contactId: contactId!,
          };
          log.info('admin.direct-process.contact_created', { contactId, phoneNumber });
        } else {
          results.phases['contactResolution'] = {
            action: 'would_create',
            phoneNumber,
            displayName: pushName || phoneNumber,
          };
        }
      }

      // === PHASE 4: Find or create session ===
      let sessionId = interaction.sessionId;

      if (!sessionId && contactId && !dryRun) {
        // Look for recent open session from this contact
        const [existingSession] = await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.contactId, contactId), eq(sessions.state, 'open')))
          .orderBy(sessions.lastActivityAt)
          .limit(1);

        if (existingSession) {
          sessionId = existingSession.id;
          results.phases.sessionResolution = {
            action: 'found_existing',
            sessionId,
          };

          // Update last activity
          await db
            .update(sessions)
            .set({ lastActivityAt: new Date() })
            .where(eq(sessions.id, sessionId));
        } else {
          // Create new session
          const newSessions = await db
            .insert(sessions)
            .values({
              contactId,
              state: 'open',
              openedAt: new Date(),
              lastActivityAt: new Date(),
            })
            .returning({ id: sessions.id });

          if (!newSessions[0]) throw new Error('Failed to create session');
          sessionId = newSessions[0].id;
          results.phases.sessionResolution = {
            action: 'created_new',
            sessionId,
          };
          log.info('admin.direct-process.session_created', { sessionId, contactId });
        }
      } else if (!sessionId && contactId && dryRun) {
        results.phases.sessionResolution = {
          action: 'would_create_or_find',
          contactId,
        };
      }

      // === PHASE 5: Update interaction ===
      if (!dryRun && (contactId || sessionId)) {
        await db
          .update(interactionsTable)
          .set({
            contactId: contactId || interaction.contactId,
            sessionId: sessionId || interaction.sessionId,
          })
          .where(eq(interactionsTable.id, interactionId));

        results.phases.updateInteraction = { success: true };
        log.info('admin.direct-process.interaction_updated', {
          interactionId,
          contactId,
          sessionId,
        });
      }

      // === PHASE 6: Transcribe audio attachments ===
      if (interaction.contentType === 'audio' || interaction.contentType === 'video') {
        results.phases.transcription = {
          needed: true,
          contentType: interaction.contentType,
        };

        if (!dryRun && sessionId) {
          // Get attachment
          const [attachment] = await db
            .select()
            .from(attachments)
            .where(eq(attachments.interactionId, interactionId))
            .limit(1);

          if (attachment) {
            // Check if already transcribed by looking up transcript
            const [existingTranscript] = await db
              .select({ id: transcripts.id })
              .from(transcripts)
              .where(eq(transcripts.attachmentId, attachment.id))
              .limit(1);

            if (!existingTranscript) {
              try {
                // Generate signed URL
                const storageCreds = supabaseStorageCredsFromEnv();
                if (!storageCreds) {
                  throw new Error('No Supabase Storage credentials');
                }

                const audioUrl = await signSupabaseGetUrl(storageCreds, attachment.r2Key, 15 * 60);

                // Transcribe
                const transcriptResult = await transcribe({
                  audioUrl,
                  mimeType: attachment.mimeType,
                });

                // Save transcript
                const newTranscripts = await db
                  .insert(transcripts)
                  .values({
                    attachmentId: attachment.id,
                    text: transcriptResult.text,
                    provider: transcriptResult.provider,
                    language: transcriptResult.language,
                    costUsd: transcriptResult.costUsdMillis
                      ? Math.round(transcriptResult.costUsdMillis / 1000)
                      : 0,
                  })
                  .returning({ id: transcripts.id });

                if (!newTranscripts[0]) throw new Error('Failed to create transcript');

                results.phases['transcription'] = {
                  success: true,
                  transcriptId: newTranscripts[0].id,
                  text: transcriptResult.text?.substring(0, 100) + '...',
                  provider: transcriptResult.provider,
                };
                log.info('admin.direct-process.transcription_completed', {
                  transcriptId: newTranscripts[0].id,
                  attachmentId: attachment.id,
                });
              } catch (transErr) {
                results.phases['transcription'] = {
                  success: false,
                  error: (transErr as Error).message,
                };
                log.error('admin.direct-process.transcription_failed', {
                  attachmentId: attachment.id,
                  error: (transErr as Error).message,
                });
              }
            } else {
              results.phases['transcription'] = {
                skipped: true,
                reason: 'Already transcribed',
                existingTranscriptId: existingTranscript.id,
              };
            }
          } else {
            results.phases['transcription'] = {
              skipped: true,
              reason: 'No attachment found',
            };
          }
        }
      }

      log.info('admin.direct-process.completed', {
        interactionId,
        dryRun,
        contactId,
        sessionId,
      });

      return NextResponse.json(
        {
          success: true,
          ...results,
          nextSteps: dryRun
            ? 'Set dryRun=false to execute'
            : 'Contact and session created. For Phase 4 (reasoning), manually trigger via Inngest or wait for session cooldown.',
        },
        { status: 200 },
      );
    } catch (err) {
      log.error('admin.direct-process.error', {
        error: (err as Error).message,
        stack: (err as Error).stack,
        interactionId,
      });
      return NextResponse.json({ error: (err as Error).message, results }, { status: 500 });
    }
  });
}
