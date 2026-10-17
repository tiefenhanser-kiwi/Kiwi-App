// LIFE-1 — ONE TEMPLATE FOR ALL SIX LIFECYCLE EMAILS: an HTML part and a
// plain-text part, built from copy.ts. This file carries layout, never words.
//
// EMAIL-SAFE BY CONSTRUCTION, because mail clients are not browsers:
//   • table layout, every style inline (Gmail strips <style> in some views);
//     the one <style> block only ADDS — narrow-screen padding and dark mode —
//     so a client that drops it still gets the full light design;
//   • no web font is loaded: Fraunces / DM Sans are named first and render
//     where installed, Georgia / the system sans everywhere else;
//   • 560 px max width, fluid below it, tested at 375 and 600;
//   • the logo is a PNG already on kitchenwizard.ai, with alt text, and the
//     wordmark beside it is live text, so an email with images off still
//     says "Kiwi";
//   • color-scheme meta + a prefers-color-scheme block for the clients that
//     honour it, built from the same token scales (brand.ts).
//
// Everything interpolated is escaped: copy.ts is ours, but {firstName} is the
// user's own text.

import { EMAIL_COLORS as C, EMAIL_FONTS as F, EMAIL_LOGO_URL, EMAIL_RADIUS_PX } from "./brand";
import { APPS_NOTE, APP_URL, FOOTER, LIFECYCLE_COPY, type EmailCopy } from "./copy";
import type { LifecycleKind } from "./schedule";

export interface RenderInput {
  kind: LifecycleKind;
  /** The account's first name; blank → "there". */
  firstName: string | null;
  /** Already formatted ("Monday, November 2"). Required by the two free-time emails. */
  endDate?: string | null;
  /** The visible unsubscribe link. Null on the welcome email (it has none). */
  unsubscribeUrl: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function varsFor(input: RenderInput): Record<string, string> {
  const name = (input.firstName ?? "").trim();
  return {
    firstName: name || "there",
    endDate: input.endDate ?? "",
  };
}

/** {name} → value. An unknown {name} is left alone so a test can find it. */
function fill(template: string, vars: Record<string, string>, escape: boolean): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const v = vars[key];
    if (v === undefined) return whole;
    return escape ? escapeHtml(v) : v;
  });
}

/** Copy markup → HTML: escape, then **bold**, then the (escaped) variables. */
function inlineHtml(template: string, vars: Record<string, string>): string {
  const bolded = escapeHtml(template).replace(
    /\*\*(.+?)\*\*/g,
    `<strong class="kiwi-ink" style="color:${C.ink};font-weight:700;">$1</strong>`,
  );
  return fill(bolded, vars, true);
}

function inlineText(template: string, vars: Record<string, string>): string {
  return fill(template.replace(/\*\*(.+?)\*\*/g, "$1"), vars, false);
}

const P_STYLE = `margin:0 0 16px 0;font-family:${F.sans};font-size:16px;line-height:1.6;color:${C.body};`;

function paragraph(html: string): string {
  return `<p class="kiwi-body" style="${P_STYLE}">${html}</p>`;
}

function button(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 12px 0;">
<tr><td class="kiwi-btn" bgcolor="${C.button}" style="border-radius:${EMAIL_RADIUS_PX}px;background-color:${C.button};">
<a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${F.sans};font-size:16px;font-weight:700;line-height:1.2;color:${C.buttonText};text-decoration:none;border-radius:${EMAIL_RADIUS_PX}px;">${escapeHtml(label)}</a>
</td></tr>
</table>`;
}

const STYLE = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  @media only screen and (max-width: 480px) {
    .kiwi-card { padding: 28px 22px !important; }
    .kiwi-outer { padding: 24px 12px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .kiwi-page { background-color: ${C.darkPage} !important; }
    .kiwi-card { background-color: ${C.darkCard} !important; border-color: ${C.darkCardBorder} !important; }
    .kiwi-ink { color: ${C.darkInk} !important; }
    .kiwi-body { color: ${C.darkBody} !important; }
    .kiwi-muted, .kiwi-muted a { color: ${C.darkMuted} !important; }
  }
  [data-ogsc] .kiwi-ink { color: ${C.darkInk} !important; }
  [data-ogsc] .kiwi-body { color: ${C.darkBody} !important; }
  [data-ogsc] .kiwi-muted, [data-ogsc] .kiwi-muted a { color: ${C.darkMuted} !important; }
`;

export function renderLifecycleEmail(input: RenderInput): RenderedEmail {
  const copy: EmailCopy = LIFECYCLE_COPY[input.kind];
  const vars = varsFor(input);

  const subject = inlineText(copy.subject, vars);
  const preheader = inlineText(copy.body[0] ?? "", vars);

  const bodyHtml = copy.body.map((p) => paragraph(inlineHtml(p, vars))).join("\n");
  const afterHtml = copy.after.map((p) => paragraph(inlineHtml(p, vars))).join("\n");
  const mutedStyle = `font-family:${F.sans};font-size:13px;line-height:1.6;color:${C.muted};`;

  const footerLines = [
    escapeHtml(FOOTER.reason),
    input.unsubscribeUrl
      ? `<a href="${escapeHtml(input.unsubscribeUrl)}" target="_blank" style="color:${C.muted};text-decoration:underline;">${escapeHtml(FOOTER.unsubscribeLabel)}</a>`
      : null,
    `${escapeHtml(FOOTER.company)} · ${escapeHtml(FOOTER.mailingAddress)}`,
  ].filter((l): l is string => l !== null);

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<style>${STYLE}</style>
</head>
<body class="kiwi-page" style="margin:0;padding:0;background-color:${C.page};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(preheader)}</div>
<table role="presentation" class="kiwi-page" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background-color:${C.page};">
<tr><td class="kiwi-outer" align="center" style="padding:32px 16px;">
<!--[if mso]><table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td align="center" style="padding:0 0 20px 0;">
<a href="${escapeHtml(APP_URL)}" target="_blank" style="text-decoration:none;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding:0 10px 0 0;vertical-align:middle;"><img src="${EMAIL_LOGO_URL}" width="40" height="40" alt="Kiwi" style="display:block;width:40px;height:40px;border:0;outline:none;text-decoration:none;"></td>
<td class="kiwi-ink" style="vertical-align:middle;font-family:${F.serif};font-size:28px;line-height:1;font-weight:600;color:${C.ink};">Kiwi</td>
</tr></table>
</a>
</td></tr>
<tr><td class="kiwi-card" bgcolor="${C.card}" style="background-color:${C.card};border:1px solid ${C.cardBorder};border-radius:${EMAIL_RADIUS_PX + 4}px;padding:36px 40px;">
<h1 class="kiwi-ink" style="margin:0 0 18px 0;font-family:${F.serif};font-size:26px;line-height:1.25;font-weight:600;color:${C.ink};">${inlineHtml(copy.greeting, vars)}</h1>
${bodyHtml}
${button(copy.button.label, copy.button.url)}
<p class="kiwi-muted" style="margin:0 0 ${copy.after.length > 0 ? "24px" : "0"} 0;${mutedStyle}">${escapeHtml(APPS_NOTE)}</p>
${afterHtml}
</td></tr>
<tr><td class="kiwi-muted" align="center" style="padding:24px 12px 0 12px;font-family:${F.sans};font-size:12px;line-height:1.7;color:${C.muted};">
${footerLines.join("<br>\n")}
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>
`;

  const textParts = [
    inlineText(copy.greeting, vars),
    ...copy.body.map((p) => inlineText(p, vars)),
    `${copy.button.label}: ${copy.button.url}`,
    APPS_NOTE,
    ...copy.after.map((p) => inlineText(p, vars)),
    "--",
    [
      FOOTER.reason,
      input.unsubscribeUrl ? `${FOOTER.unsubscribeLabel}: ${input.unsubscribeUrl}` : null,
      `${FOOTER.company} · ${FOOTER.mailingAddress}`,
    ]
      .filter((l): l is string => l !== null)
      .join("\n"),
  ];

  return { subject, html, text: textParts.join("\n\n") + "\n" };
}
