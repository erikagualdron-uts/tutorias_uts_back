import { describe, expect, it } from 'vitest';
import type { MailBrand } from '../brand.js';
import { composeMail, escapeHtml, LOGO_CID, type MailContent } from './layout.js';

const brand: MailBrand = { name: 'Institución Universitaria Tecnológica de Santander – UTS', contactEmail: 'cae@uts.edu.co', footerText: 'Mensaje automático.' };
const content: MailContent = {
  subject: 'Asunto - UTS Tutorías',
  title: 'Título',
  tone: 'info',
  blocks: [
    { kind: 'p', text: 'Primer párrafo.' },
    { kind: 'code', text: '123456' },
  ],
};

describe('escapeHtml', () => {
  it('escapes the five characters that can open markup', () => {
    expect(escapeHtml(`<b a="1" b='2'>&</b>`)).toBe('&lt;b a=&quot;1&quot; b=&#39;2&#39;&gt;&amp;&lt;/b&gt;');
  });
});

describe('composeMail', () => {
  it('has the logo by cid, the brand name, the contact and the footer', () => {
    const { html, text } = composeMail(content, brand);
    expect(html).toContain(`src="cid:${LOGO_CID}"`);
    expect(html).toContain(`alt="${brand.name}"`);
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

  it('keeps the same content in the plain text, with the code on its own line', () => {
    const { text } = composeMail(content, brand);
    expect(text).toContain('Título');
    expect(text).toContain('Primer párrafo.');
    expect(text.split('\n')).toContain('123456');
  });

  it('escapes what a user wrote and leaves it literal in the text', () => {
    const hostile: MailContent = { ...content, title: '<b>x</b>', blocks: [{ kind: 'p', text: 'A & <i>B</i>' }] };
    const { html, text } = composeMail(hostile, brand);
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(text).toContain('<b>x</b>');
  });

  it('uses only the palette of Design.md for the accent of each tone', () => {
    const accents = { info: '#34531F', warning: '#FB8C00', error: '#B3261E', success: '#2BA640' } as const;
    for (const [tone, color] of Object.entries(accents)) {
      expect(composeMail({ ...content, tone: tone as MailContent['tone'] }, brand).html).toContain(color);
    }
  });

  it('stays under 100 KB with a 1000 character body, so Gmail does not clip it', () => {
    const long: MailContent = { ...content, blocks: [{ kind: 'p', text: 'x'.repeat(1000) }] };
    expect(Buffer.byteLength(composeMail(long, brand).html)).toBeLessThan(100_000);
  });
});
