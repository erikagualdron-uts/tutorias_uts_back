import { describe, expect, it } from 'vitest';
import type { MailBrand } from '../brand.js';
import { COLORS, composeMail, escapeHtml, LOGO_CID, TONES, type MailContent } from './layout.js';

const brand: MailBrand = { name: 'Institución Universitaria Tecnológica de Santander – UTS', contactEmail: 'cae@uts.edu.co', footerText: 'Mensaje automático.' };
const content: MailContent = {
  subject: 'Asunto - UTS Tutorías',
  lang: 'es',
  badge: 'Cambio de hora',
  title: 'Título',
  tone: 'info',
  blocks: [
    { kind: 'p', text: 'Primer párrafo.' },
    { kind: 'detail', text: 'Línea uno\nLínea dos' },
    { kind: 'code', text: '123456' },
    { kind: 'note', text: 'Vence pronto.' },
  ],
};

// WCAG 2.x contrast ratio of two #RRGGBB colors.
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('escapeHtml', () => {
  it('escapes the five characters that can open markup', () => {
    expect(escapeHtml(`<b a="1" b='2'>&</b>`)).toBe('&lt;b a=&quot;1&quot; b=&#39;2&#39;&gt;&amp;&lt;/b&gt;');
  });
});

describe('composeMail', () => {
  it('has the logo by cid, the brand name, the contact as a link and the footer', () => {
    const { html, text } = composeMail(content, brand);
    expect(html).toContain(`src="cid:${LOGO_CID}"`);
    expect(html).toContain(`alt="${brand.name}"`);
    expect(html).toContain('href="mailto:cae@uts.edu.co"');
    for (const part of [brand.name, brand.contactEmail, brand.footerText]) {
      expect(html).toContain(part);
      expect(text).toContain(part);
    }
  });

  it('omits the contact and the footer text when they are empty', () => {
    const { html, text } = composeMail(content, { ...brand, contactEmail: '', footerText: '' });
    expect(html).not.toContain('mailto:');
    expect(html).toContain(brand.name);
    expect(text.trimEnd().endsWith(brand.name)).toBe(true);
  });

  it('keeps the same content in the plain text, with the badge, the code on its own line and line breaks', () => {
    const { text } = composeMail(content, brand);
    expect(text.startsWith('[Cambio de hora]\n\nTítulo')).toBe(true);
    expect(text).toContain('Primer párrafo.');
    expect(text).toContain('Línea uno\nLínea dos');
    expect(text.split('\n')).toContain('123456');
  });

  it('escapes what a user wrote and leaves it literal in the text', () => {
    const hostile: MailContent = { ...content, title: '<b>x</b>', blocks: [{ kind: 'detail', text: 'A & <i>B</i>' }] };
    const { html, text } = composeMail(hostile, brand);
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(text).toContain('<b>x</b>');
  });

  it('stays under 100 KB with a 1000 character body, so Gmail does not clip it', () => {
    const long: MailContent = { ...content, blocks: [{ kind: 'detail', text: 'x'.repeat(1000) }] };
    expect(Buffer.byteLength(composeMail(long, brand).html)).toBeLessThan(100_000);
  });

  it('uses the accent of the tone for the detail box', () => {
    for (const tone of ['info', 'warning', 'error', 'success'] as const) {
      expect(composeMail({ ...content, tone }, brand).html).toContain(`border-left:4px solid ${TONES[tone].accent}`);
    }
  });
});

describe('what the mail checker flags and the screen readers need', () => {
  const { html } = composeMail(content, brand);

  it('declares the language, a title, one h1 and the light color scheme', () => {
    expect(html).toContain('<html lang="es"');
    expect(html).toContain('<title>Asunto - UTS Tutorías</title>');
    expect(html.match(/<h1 /g)).toHaveLength(1);
    expect(html).toContain('<meta name="color-scheme" content="light">');
  });

  it('marks every layout table as presentation and gives the logo a size and a text alternative', () => {
    expect(html.match(/<table /g)?.length).toBe(html.match(/<table role="presentation"/g)?.length);
    expect(html).toMatch(/<img [^>]*alt="[^"]+"[^>]*width="160"/);
  });

  it('has a hidden preview text that is the first paragraph', () => {
    expect(html).toMatch(/<div style="display:none[^>]*>Primer párrafo\.<\/div>/);
  });

  it('does not use what clients do not support: overflow, body styles and the background shorthand', () => {
    expect(html).not.toContain('overflow');
    expect(html).toContain('<body>');
    expect(html).not.toMatch(/[;"]background:/);
  });

  it('gives every colored fill a bgcolor attribute for clients that ignore the style', () => {
    expect(html.match(/background-color:/g)!.length).toBeGreaterThan(0);
    for (const fill of html.match(/background-color:(#[0-9A-F]{6})/g)!) expect(html).toContain(`bgcolor="${fill.slice(-7)}"`);
  });

  it('never writes text smaller than 12 px, and body text is at least 16 px', () => {
    const sizes = [...html.matchAll(/font-size:(\d+)px/g)].map((m) => Number(m[1])).filter((size) => size > 1);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
    expect(html).toMatch(/font-size:16px;line-height:24px/);
  });

  it('keeps every text and background pair at AA contrast (4.5:1)', () => {
    const pairs: [string, string][] = [
      [COLORS.deep, COLORS.white],
      [COLORS.deep, COLORS.screen],
      [COLORS.muted, COLORS.white],
      [COLORS.link, COLORS.white],
      [COLORS.white, COLORS.primary],
      [COLORS.white, COLORS.deep],
      ...Object.values(TONES).map((tone): [string, string] => [tone.ink, tone.fill]),
    ];
    for (const [ink, fill] of pairs) expect(contrast(ink, fill), `${ink} on ${fill}`).toBeGreaterThanOrEqual(4.5);
  });
});
