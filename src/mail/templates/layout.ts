import type { MailBrand } from '../brand.js';

export const LOGO_CID = 'uts-logo';

export type Tone = 'info' | 'warning' | 'error' | 'success';
// `p` is a paragraph; `detail` is the highlighted text of the email (line breaks kept); `code` is a
// one-time code; `note` is small muted metadata (an expiry).
export type Block = { kind: 'p' | 'detail' | 'code' | 'note'; text: string };

// What a template says; the layout turns it into the html and the plain text of the same email.
export interface MailContent {
  subject: string;
  lang: 'es' | 'en';
  // Short text of the badge above the title: the state is never conveyed by color alone.
  badge: string;
  title: string;
  tone: Tone;
  blocks: Block[];
}

export interface ComposedMail {
  subject: string;
  text: string;
  html: string;
}

// Colors of docs/Design.md. Lime, success and warning are fills only, never text on white.
export const COLORS = {
  primary: '#34531F',
  deep: '#132F20',
  lime: '#C3D730',
  link: '#4E7A2F',
  muted: '#575756',
  screen: '#F2F4EF',
  white: '#FFFFFF',
  border: '#E5E5E5',
  inputBorder: '#C9D0C3',
  success: '#2BA640',
  warning: '#FB8C00',
  error: '#B3261E',
} as const;

// `accent` marks the detail box; the badge pairs a fill with the ink that reads on it (>= 4.5:1).
export const TONES: Record<Tone, { accent: string; fill: string; ink: string }> = {
  info: { accent: COLORS.primary, fill: COLORS.lime, ink: COLORS.deep },
  warning: { accent: COLORS.warning, fill: COLORS.warning, ink: COLORS.deep },
  error: { accent: COLORS.error, fill: COLORS.error, ink: COLORS.white },
  success: { accent: COLORS.success, fill: COLORS.success, ink: COLORS.deep },
};

// Email clients ignore web fonts, so these are the only places a font name is written (D-102).
const FONT = 'Arial, Helvetica, sans-serif';
const MONO = "'Courier New', Courier, monospace";

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

const C = COLORS;
const table = (inner: string, attrs = 'width="100%"') => `<table role="presentation" ${attrs} cellpadding="0" cellspacing="0" border="0">${inner}</table>`;
const row = (style: string, inner: string, attrs = '') => `<tr><td ${attrs} style="${style}">${inner}</td></tr>`;
// Text a person wrote or a template holds: escaped, and a line break becomes <br>.
const html = (text: string) => escapeHtml(text).replace(/\n/g, '<br>');
const font = (size: number, line: number, color: string, weight = 'normal') =>
  `font-family:${FONT};font-size:${size}px;line-height:${line}px;font-weight:${weight};color:${color}`;

function blockHtml({ kind, text }: Block, accent: string) {
  if (kind === 'code')
    return row('padding:8px 32px', table(row(`background-color:${C.screen};border:1px solid ${C.inputBorder};border-radius:12px;padding:16px;font-family:${MONO};font-size:32px;line-height:40px;font-weight:bold;letter-spacing:8px;color:${C.deep}`, escapeHtml(text), `align="center" bgcolor="${C.screen}"`)));
  if (kind === 'detail')
    return row('padding:8px 32px', table(row(`background-color:${C.screen};border-left:4px solid ${accent};border-radius:12px;padding:16px;${font(16, 24, C.deep)}`, html(text), `bgcolor="${C.screen}"`)));
  const style = kind === 'note' ? font(14, 20, C.muted) : font(16, 24, C.deep);
  return row('padding:8px 32px', `<p style="margin:0;${style}">${html(text)}</p>`);
}

export function composeMail({ subject, lang, badge, title, tone, blocks }: MailContent, brand: MailBrand): ComposedMail {
  const { accent, fill, ink } = TONES[tone];
  const preheader = blocks.find((block) => block.kind === 'p')?.text ?? title;
  const footerLines = [brand.name, brand.contactEmail, brand.footerText].filter(Boolean);
  const footerHtml = footerLines
    .map((line) => {
      const link = line === brand.contactEmail;
      const style = link ? font(14, 20, C.link) : line === brand.name ? font(14, 20, C.deep, 'bold') : font(13, 18, C.muted);
      return `<p style="margin:4px 0 0;${style}">${link ? `<a href="mailto:${escapeHtml(line)}" style="color:${C.link}">${escapeHtml(line)}</a>` : escapeHtml(line)}</p>`;
    })
    .join('');

  const body =
    `<div style="display:none;mso-hide:all;font-size:1px;line-height:1px;color:${C.screen}">${html(preheader)}</div>` +
    table(
      row(
        'padding:24px 12px',
        table(
          row(`background-color:${C.white};border-radius:16px 16px 0 0;padding:24px 32px`, `<img src="cid:${LOGO_CID}" alt="${escapeHtml(brand.name)}" width="160" style="display:block;border:0;height:auto">`, `bgcolor="${C.white}"`) +
            row(
              `background-color:${C.primary};background-image:linear-gradient(135deg,${C.primary},${C.deep});padding:32px 32px 28px`,
              table(row(`background-color:${fill};border-radius:2px;padding:4px 8px;font-family:${FONT};font-size:12px;line-height:16px;font-weight:bold;letter-spacing:0.02em;color:${ink}`, escapeHtml(badge.toUpperCase()), `bgcolor="${fill}"`), 'width="auto"') +
                `<h1 style="margin:16px 0 12px;${font(26, 32, C.white, 'bold')}">${escapeHtml(title)}</h1>` +
                table(row(`background-color:${C.lime};height:4px;line-height:4px;font-size:0`, '&nbsp;', `width="48" bgcolor="${C.lime}"`), 'width="48"'),
              `bgcolor="${C.primary}"`,
            ) +
            `<tr><td bgcolor="${C.white}" style="background-color:${C.white};padding:16px 0 8px">${table(blocks.map((block) => blockHtml(block, accent)).join(''))}</td></tr>` +
            row(`background-color:${C.white};border-top:1px solid ${C.border};border-radius:0 0 16px 16px;padding:24px 32px`, footerHtml, `bgcolor="${C.white}"`),
          'width="600" style="width:100%;max-width:600px"',
        ),
        'align="center"',
      ),
      `width="100%" bgcolor="${C.screen}" style="background-color:${C.screen}"`,
    );

  const page =
    `<!doctype html><html lang="${lang}" xml:lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${escapeHtml(subject)}</title></head><body>${body}</body></html>`;

  const text = [`[${badge}]`, title, ...blocks.map((block) => block.text), footerLines.join('\n')].join('\n\n');
  return { subject, text, html: page };
}
