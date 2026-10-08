import { describe, expect, it } from 'vitest';
import { RELEASES_URL, RELEASE_NOTES_MAX_CHARS, RELEASE_NOTES_TRUNCATED, formatReleaseNotes, htmlToPlainText } from './releaseNotes';

describe('htmlToPlainText', () => {
  it('turns lists and paragraphs into lines and drops other tags', () => {
    const html = '<h2>What\'s new</h2><ul><li>Fixed <b>flat</b> forces</li><li>Faster &amp; safer</li></ul><p>Thanks</p>';
    expect(htmlToPlainText(html)).toBe("What's new\n\n- Fixed flat forces\n- Faster & safer\nThanks");
  });
  it('keeps the New / Improved / Fixed headings of a categorised release (#137)', () => {
    // What GitHub renders from "### New" ... "### Fixed" release notes (release_plan.py).
    const html = '<h3>New</h3>\n<ul>\n<li>A Move panel button</li>\n</ul>\n<h3>Fixed</h3>\n<ul>\n<li>Blank FFT</li>\n</ul>';
    expect(htmlToPlainText(html)).toBe('New\n\n- A Move panel button\n\nFixed\n\n- Blank FFT');
  });
  it('drops script and style blocks entirely', () => {
    expect(htmlToPlainText('a<script>alert(1)</script>b<style>p{}</style>c')).toBe('abc');
  });
  it('decodes the common entities', () => {
    expect(htmlToPlainText('1 &lt; 2 &gt; 0 &quot;x&quot; &#39;y&#39;&nbsp;z')).toBe('1 < 2 > 0 "x" \'y\' z');
  });
});

describe('htmlToPlainText entities', () => {
  it('decodes decimal and hex numeric entities', () => {
    expect(htmlToPlainText('Don&#8217;t &#x2019;x&#X2019; &#65;&#x41;')).toBe('Don\u2019t \u2019x\u2019 AA');
  });
  it('decodes common named entities, including typographic ones', () => {
    expect(htmlToPlainText('a&hellip; b&mdash;c &ndash; &rsquo;&ldquo;q&rdquo; &copy;')).toBe('a\u2026 b\u2014c \u2013 \u2019\u201cq\u201d \u00a9');
  });
  it('decodes once: &amp;lt; stays &lt;', () => {
    expect(htmlToPlainText('&amp;lt; &amp;#65;')).toBe('&lt; &#65;');
  });
  it('decodes tab, line feed and carriage return entities to the real characters', () => {
    expect(htmlToPlainText('a&#10;b&#x0A;c&#9;d&#13;&#10;e&#xD;f')).toBe('a\nb\nc\td\ne\nf');
  });
  it('leaves unknown, control and out-of-range entities as written', () => {
    expect(htmlToPlainText('&bogus; &#0; &#1114112; &#xD800; &constructor; &valueOf;')).toBe('&bogus; &#0; &#1114112; &#xD800; &constructor; &valueOf;');
  });
  it('does not turn an escaped tag into markup that then gets stripped', () => {
    expect(htmlToPlainText('use &lt;b&gt; for bold')).toBe('use <b> for bold');
  });
});

describe('formatReleaseNotes', () => {
  it('is empty when there are no notes', () => {
    expect(formatReleaseNotes(undefined)).toBe('');
    expect(formatReleaseNotes(null)).toBe('');
    expect(formatReleaseNotes('')).toBe('');
    expect(formatReleaseNotes([])).toBe('');
    expect(formatReleaseNotes([{ version: '1.0.0', note: null }])).toBe('');
  });
  it('flattens an HTML string', () => {
    expect(formatReleaseNotes('<p>Fix <i>one</i></p>')).toBe('Fix one');
  });
  it('uses a single array entry without a heading', () => {
    expect(formatReleaseNotes([{ version: '2.0.0', note: '<p>Only this</p>' }])).toBe('Only this');
  });
  it('labels each version when there are several', () => {
    expect(
      formatReleaseNotes([
        { version: '2.0.0', note: '<p>B</p>' },
        { version: '1.9.0', note: '<p>A</p>' },
      ]),
    ).toBe('2.0.0\nB\n\n1.9.0\nA');
  });
  it('ignores values of the wrong type', () => {
    expect(formatReleaseNotes(42)).toBe('');
    expect(formatReleaseNotes([null, 3, { version: 1, note: 'ok' }])).toBe('ok');
  });
  it('trims long notes and says where the rest is', () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const out = formatReleaseNotes(long);
    expect(out.endsWith(RELEASE_NOTES_TRUNCATED)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(RELEASE_NOTES_MAX_CHARS + RELEASE_NOTES_TRUNCATED.length);
    // cut at a word boundary, not mid-word
    expect(out.replace(RELEASE_NOTES_TRUNCATED, '')).toMatch(/word\d+$/);
  });
  it('points to the release page, not to a Settings screen that has no full notes', () => {
    expect(RELEASE_NOTES_TRUNCATED).toContain(RELEASES_URL);
    expect(RELEASE_NOTES_TRUNCATED).not.toContain('Settings');
  });
  it('leaves notes at the limit untouched', () => {
    const exact = 'a'.repeat(RELEASE_NOTES_MAX_CHARS);
    expect(formatReleaseNotes(exact)).toBe(exact);
  });
});
