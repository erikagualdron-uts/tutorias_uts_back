import type { MailBrand } from '../brand.js';

export const LOGO_CID = 'uts-logo';

export type Tone = 'info' | 'warning' | 'error' | 'success';
export type Block = { kind: 'p'; text: string } | { kind: 'code'; text: string };

// What a template says; the layout turns it into the html and the plain text of the same email.
export interface MailContent {
  subject: string;
  title: string;
  tone: Tone;
  blocks: Block[];
}

export interface ComposedMail {
  subject: string;
  text: string;
  html: string;
}

// Colors of docs/Design.md. Warning and success are fills only, never text on white.
const ACCENT: Record<Tone, string> = { info: '#34531F', warning: '#FB8C00', error: '#B3261E', success: '#2BA640' };
const INK = '#132F20';
const MUTED = '#575756';
const SCREEN = '#F2F4EF';
const BORDER = '#C9D0C3';
// Email clients ignore web fonts, so this is the one place a font name is written (D-102).
const FONT = 'Arial, Helvetica, sans-serif';

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

const row = (padding: string, inner: string) => `<tr><td style="padding:${padding}">${inner}</td></tr>`;

function blockHtml(block: Block) {
  const text = escapeHtml(block.text);
  return block.kind === 'code'
    ? row(
        '8px 32px',
        `<div style="font-family:'Courier New',monospace;font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;color:${INK};background:${SCREEN};border:1px solid ${BORDER};border-radius:12px;padding:16px">${text}</div>`,
      )
    : row('8px 32px', `<p style="margin:0;font-size:16px;line-height:24px;color:${INK}">${text}</p>`);
}

export function composeMail({ subject, title, tone, blocks }: MailContent, brand: MailBrand): ComposedMail {
  const footerLines = [brand.name, brand.contactEmail, brand.footerText].filter(Boolean);
  const footerHtml = footerLines
    .map((line, index) => `<p style="margin:${index === 0 ? '0' : '4px 0 0'};font-size:13px;line-height:20px;color:${MUTED}">${escapeHtml(line)}</p>`)
    .join('');
  const name = escapeHtml(brand.name);

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;background:${SCREEN};font-family:${FONT};color:${INK}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SCREEN}"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:16px;overflow:hidden">` +
    row('24px 32px 16px', `<img src="cid:${LOGO_CID}" alt="${name}" width="160" style="display:block;border:0;height:auto">`) +
    `<tr><td style="height:6px;line-height:6px;font-size:0;background:${ACCENT[tone]}">&nbsp;</td></tr>` +
    row('24px 32px 8px', `<h1 style="margin:0;font-size:22px;line-height:28px;color:${INK}">${escapeHtml(title)}</h1>`) +
    blocks.map(blockHtml).join('') +
    row('24px 32px', footerHtml) +
    `</table></td></tr></table></body></html>`;

  const text = [title, ...blocks.map((block) => block.text), footerLines.join('\n')].join('\n\n');
  return { subject, text, html };
}

// Temporary bridge (T009): lets a template that still returns plain text go through the layout.
// Each story replaces its template with a MailContent and T029 deletes this.
export const withLayout = ({ subject, text }: { subject: string; text: string }): MailContent => ({
  subject,
  title: subject,
  tone: 'info',
  blocks: text.split(/\n{2,}/).map((paragraph) => ({ kind: 'p' as const, text: paragraph })),
});
