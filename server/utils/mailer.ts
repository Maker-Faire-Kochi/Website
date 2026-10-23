/**
 * Transactional mail over Brevo's HTTP API.
 *
 * HTTP, not SMTP: Cloudflare Workers cannot open SMTP sockets, so the SMTP
 * host/port from the Brevo dashboard is unused here. Same API key; send via
 * https://api.brevo.com/v3/smtp/email.
 *
 * Unconfigured (no key or no from address) means "skip", never "throw":
 * a missing mail setup must not fail a form submission.
 */

interface MailInput {
  to: string
  subject: string
  text: string
  html: string
}

function parseFrom(raw: string): { name?: string, email: string } | null {
  const s = raw.trim()
  if (!s) return null
  const m = s.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  if (m) {
    const email = m[2]!.trim()
    const name = m[1]!.replace(/^["']|["']$/g, '').trim()
    return email ? { name: name || undefined, email } : null
  }
  return s.includes('@') ? { email: s } : null
}

export async function sendMail(input: MailInput): Promise<boolean> {
  const config = useRuntimeConfig()
  const key = (config.brevoApiKey as string) || ''
  const from = parseFrom((config.mailFrom as string) || '')
  if (!key || !from) return false

  const reply = parseFrom((config.mailReplyTo as string) || '')

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': key,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { name: from.name, email: from.email },
        to: [{ email: input.to }],
        replyTo: reply ? { name: reply.name, email: reply.email } : undefined,
        subject: input.subject,
        textContent: input.text,
        htmlContent: input.html,
      }),
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) {
      console.error('[mail] Brevo rejected', res.status, await res.text().catch(() => ''))
      return false
    }
    return true
  } catch (err) {
    console.error('[mail] send failed', err)
    return false
  }
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** First word, capitalised for the greeting. */
function greetingName(full: string): string {
  const first = (full.trim().split(/\s+/)[0] || 'there').toLowerCase()
  return first.charAt(0).toUpperCase() + first.slice(1)
}

const LOGO_URL = 'https://makerfaire.in/img/logo/mf-kochi-long.png'
const SITE_URL = 'https://makerfaire.in'

export function volunteerReceivedMail(name: string) {
  const first = greetingName(name)
  const subject = 'Your Maker Faire Kochi Media Team application has been received'
  const text = [
    `Dear ${first},`,
    '',
    'Thank you for your interest in joining the Maker Faire Kochi 2027 Media Team.',
    '',
    'This email confirms that we have received your application.',
    '',
    'Our team will go through the responses and reach out to you via email or WhatsApp with the next steps.',
    '',
    'We look forward to the possibility of creating something amazing together!',
    '',
    'Kind regards,',
    'The Maker Faire Kochi Team',
    SITE_URL,
  ].join('\n')

  // Drawing-sheet panel: ink border, cyan rule, mono labels, red CTA link.
  // Content strings above must stay byte-identical.
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#F6F6F3;background-image:radial-gradient(#CFCFCA 1px,transparent 1px);background-size:16px 16px;-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    Your application has been received and is under review.
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FBFBF9;border:1px solid #222222;box-shadow:3px 3px 0 rgba(34,34,34,0.08);">
          <tr>
            <td style="height:4px;line-height:4px;font-size:0;background:#00AEEF;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:24px 28px 20px;border-bottom:1px solid #222222;">
              <a href="${SITE_URL}" style="text-decoration:none;display:inline-block;">
                <img
                  src="${LOGO_URL}"
                  width="216"
                  height="36"
                  alt="Maker Faire Kochi"
                  style="display:block;border:0;outline:none;width:216px;max-width:100%;height:auto;"
                />
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 28px 8px;font-family:'IBM Plex Mono',Menlo,Consolas,'Courier New',monospace;font-size:15px;line-height:1.65;color:#222222;">
              <p style="margin:0 0 16px;">Dear ${escapeHtml(first)},</p>
              <p style="margin:0 0 16px;">
                Thank you for your interest in joining the
                <strong>Maker Faire Kochi 2027 Media Team</strong>.
              </p>
              <p style="margin:0 0 20px;">
                This email confirms that we have received your application.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 28px 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #222222;background:#FBFBF9;box-shadow:2px 2px 0 rgba(34,34,34,0.06);">
                <tr>
                  <td style="padding:14px 16px;font-family:'IBM Plex Mono',Menlo,Consolas,'Courier New',monospace;">
                    <p style="margin:0 0 6px;font-size:11px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:#5A6169;">
                      Application Status
                    </p>
                    <p style="margin:0;font-size:15px;line-height:1.4;color:#222222;font-weight:700;">
                      Received &mdash; Under Review
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 28px;font-family:'IBM Plex Mono',Menlo,Consolas,'Courier New',monospace;font-size:15px;line-height:1.65;color:#222222;">
              <p style="margin:0 0 16px;">
                Our team will go through the responses and reach out to you via email
                or WhatsApp with the next steps.
              </p>
              <p style="margin:0 0 28px;">
                We look forward to the possibility of creating something amazing together!
              </p>
              <p style="margin:0 0 4px;">Kind regards,</p>
              <p style="margin:0 0 4px;font-weight:700;">The Maker Faire Kochi Team</p>
              <p style="margin:0;font-size:14px;">
                <a href="${SITE_URL}" style="color:#C4121A;text-decoration:underline;text-underline-offset:2px;">makerfaire.in</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 28px;border-top:1px solid #222222;background:#222222;font-family:'IBM Plex Mono',Menlo,Consolas,'Courier New',monospace;font-size:11px;line-height:1.55;letter-spacing:0.04em;color:#A8AEB5;">
              Kerala&rsquo;s first licensed Maker Faire<br />
              5&ndash;6 February 2027 &middot; Kochi
            </td>
          </tr>
        </table>
        <p style="margin:20px 0 0;max-width:560px;font-family:'IBM Plex Mono',Menlo,Consolas,'Courier New',monospace;font-size:11px;line-height:1.5;color:#5A6169;">
          This message was sent because you applied through
          <a href="${SITE_URL}/volunteer" style="color:#5A6169;text-decoration:underline;">makerfaire.in/volunteer</a>.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`

  return { subject, text, html }
}
