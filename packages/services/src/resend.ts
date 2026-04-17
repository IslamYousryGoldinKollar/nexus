import { Resend } from 'resend';

/**
 * Resend client for Phase 5 admin magic-link emails.
 *
 * Pricing: 100 / day on free tier; $20/mo for 50 k/month.
 */

export interface SendMagicLinkArgs {
  to: string;
  url: string;
  from?: string;
  subject?: string;
}

let _client: Resend | null = null;

export function getResendClient(apiKey: string): Resend {
  if (_client) return _client;
  _client = new Resend(apiKey);
  return _client;
}

export async function sendMagicLinkEmail(
  apiKey: string,
  args: SendMagicLinkArgs,
): Promise<{ id: string }> {
  const from = args.from ?? 'nexus@goldinkollar.com';
  const subject = args.subject ?? 'Your Nexus sign-in link';
  const html = `
<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:24px auto;">
  <h2 style="color:#B8893A;">Sign in to Nexus</h2>
  <p>Click below to sign in. This link expires in 15 minutes.</p>
  <p>
    <a href="${escapeHtml(args.url)}"
       style="display:inline-block;background:#0F172A;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;">
      Open Nexus
    </a>
  </p>
  <p style="color:#64748B;font-size:12px;margin-top:32px;">
    If you didn't request this, ignore it — nobody can sign in with your
    address without receiving this email.
  </p>
</body></html>`;

  const client = getResendClient(apiKey);
  const { data, error } = await client.emails.send({
    from,
    to: args.to,
    subject,
    html,
  });
  if (error) throw new Error(`resend send failed: ${error.message}`);
  if (!data?.id) throw new Error('resend send returned no id');
  return { id: data.id };
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
