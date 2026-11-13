// pdf-richtext: only what the portal shows is printed (sanitised first); entity lookup is own-property only; struck spaces;
// <pre> leading newline. Draw operations are recorded on a fake page. Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PDFPage } from 'pdf-lib';
import { createRequire } from 'node:module';
import { drawRichHtml } from '../src/lib/pdf-richtext';
import { buildEstimatePdf } from '../src/lib/pdf';
import { sanitizePortalHtml } from '../src/lib/pdf-sanitize';
import { SAMPLE_COMPANY, shortEstimate } from './estimate-pdf-fixtures';

interface Rec { texts: Array<{ t: string; x: number; y: number }>; lines: Array<{ x1: number; x2: number; y: number }> }

async function render(html: string, width = 512): Promise<Rec> {
    const doc = await PDFDocument.create();
    const fonts = {
        regular: await doc.embedFont(StandardFonts.Helvetica),
        bold: await doc.embedFont(StandardFonts.HelveticaBold),
        italic: await doc.embedFont(StandardFonts.HelveticaOblique),
        boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    };
    const rec: Rec = { texts: [], lines: [] };
    const mkPage = () => ({
        drawText: (t: string, o: { x: number; y: number }) => { rec.texts.push({ t, x: o.x, y: o.y }); },
        drawLine: (o: { start: { x: number; y: number }; end: { x: number; y: number } }) => { rec.lines.push({ x1: o.start.x, x2: o.end.x, y: o.start.y }); },
    });
    drawRichHtml(html, {
        doc: { addPage: () => mkPage() } as never, page: mkPage() as never, y: 700, fonts,
        layout: { pageWidth: 612, pageHeight: 792, margin: 50, contentWidth: width },
        color: rgb(0, 0, 0), mutedColor: rgb(0.4, 0.4, 0.4),
    });
    return rec;
}
const joined = (r: Rec) => r.texts.map(x => x.t).join('|');

// Through buildEstimatePdf: the rich fields go through the portal's own sanitiser first, so what is drawn is
// exactly the text content of what a browser would display, nothing hidden printed, nothing visible lost.
// The repo ships jsdom without its declaration package.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string) => { window: { document: { body: { querySelectorAll(s: string): { forEach(f: (el: { remove(): void }) => void): void }; textContent: string | null } } } } };
const sanitiserText = async (html: string): Promise<string> => {
    const clean = (await sanitizePortalHtml(html)) as string;
    const body = new JSDOM('<body>' + clean + '</body>').window.document.body;
    // DOMPurify keeps these, but a browser never displays them (jsdom's textContent would still count style text).
    body.querySelectorAll('style,template,title,datalist,noscript,script,dialog').forEach(el => el.remove());
    return body.textContent ?? '';
};
const nonSpace = (t: string) => t.replace(/\s+/g, '');

async function drawnTerms(html: string): Promise<string> {
    const drawn: string[] = [];
    const orig = PDFPage.prototype.drawText;
    PDFPage.prototype.drawText = function (this: PDFPage, text, options) { drawn.push(String(text)); return orig.call(this, text, options); };
    try {
        await buildEstimatePdf({ ...shortEstimate(), termsAndConditions: html }, SAMPLE_COMPANY);
    } finally {
        PDFPage.prototype.drawText = orig;
    }
    const start = drawn.indexOf('Terms & Conditions');
    const footer = drawn.findIndex((t, i) => i > start && t.startsWith('Sample Remodeling Co.'));
    assert.ok(start >= 0 && footer > start);
    return drawn.slice(start + 1, footer).join(' ');
}

const SANITISED_CASES: Array<[string, string, string[]]> = [
    ['comment between blocks', '<p>Clause 1</p><!-- internal: price not final --><p>Clause 2</p>', ['internal']],
    ['comment inside a paragraph', '<p>a<!-- x -->b</p>', ['x']],
    ['style body', '<p>Keep</p><style>p{color:red}</style><p>Scope</p>', ['color']],
    ['script body', '<p>A</p><script>var x = "hidden";</script><p>B</p>', ['hidden']],
    ['word conditional comment', '<p>A</p><!--[if gte mso 9]><xml>word junk</xml><![endif]--><p>B</p>', ['junk']],
    ['nested template', '<p>A</p><template><p>tpl<template><p>inner</p></template></p></template><p>B</p>', ['tpl', 'inner']],
    ['script close tag with attribute', '<p>A</p><script>hid</script data-x><p>B</p>', ['hid']],
    ['attribute that looks like a comment', '<p title="<!--">Body</p>', ['title']],
    ['attribute value with a closing angle bracket', '<p title="a>b">Body</p>', ['a>b', 'b"']],
    ['head element', '<p>A</p><head><p>Visible</p>', []],
    ['unclosed tags', '<p>One <strong>bold <em>italic', []],
    ['unclosed style', '<p>Before</p><style>p{color:red}', ['color']],
    ['unclosed script', '<p>Keep</p><script>never closed <p>Hidden</p>', ['Hidden', 'never']],
    ['unclosed comment', '<p>Keep</p><!-- never closed <p>Hidden</p>', ['Hidden']],
    ['entities and nbsp', '<p>R&amp;D&nbsp;&#8212; &lt;ok&gt;</p>', []],
];
for (const [name, html, hidden] of SANITISED_CASES) {
    test('rich terms equal the sanitised text content: ' + name, async () => {
        const drawn = await drawnTerms(html);
        assert.equal(nonSpace(drawn), nonSpace(await sanitiserText(html)));
        for (const h of hidden) assert.ok(!drawn.includes(h), 'hidden text printed: ' + h);
    });
}

test('named entities: inherited object properties are not entities', async () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
        assert.equal(joined(await render(`<p>x&${name};y</p>`)), `x&${name};y`, name);
    }
    assert.equal(joined(await render('<p>&sect; 4</p>')), '§|4');
    assert.equal(joined(await render('<p>&unknownthing;</p>')), '&unknownthing;');
});

test('letters the fonts cannot encode print as "?"; so does an emoji (visible, never silently dropped)', async () => {
    assert.equal(joined(await render('<p>Removal excludes 石棉.</p>')), 'Removal|excludes|??.');
    assert.equal(joined(await render('<p>Nice \u{1F600} job</p>')), 'Nice|?|job');
});

test('strike-through: the space before a wrapped word is not struck; same-line spaces are', async () => {
    // Narrow column so "bbb" wraps to line 2.
    const wide = await render('<p><s>aaa bbb</s></p>');
    assert.equal(wide.lines.length, 3, 'two words and the space between them on one line');
    const narrow = await render('<p><s>aaa bbb</s></p>', 22);
    assert.equal(narrow.texts.length, 2);
    assert.equal(narrow.lines.length, 2, 'only the two words, no tail space');
});

test('<pre>: one leading newline right after the tag is dropped', async () => {
    const a = await render('<pre>\nfirst\nsecond</pre>');
    const b = await render('<pre>first\nsecond</pre>');
    assert.deepEqual(a.texts, b.texts);
    const c = await render('<pre>\n\nfirst</pre>'); // second newline is real
    assert.ok(c.texts[0].y < b.texts[0].y);
});

test('underline: <u> and <a> draw a line under the run (wrapped and same-line spaces), strike unchanged', async () => {
    const u = await render('<p><u>aaa bbb</u></p>');
    assert.equal(u.lines.length, 3, 'two words and the space between them');
    const textY = u.texts[0].y;
    for (const l of u.lines) assert.ok(l.y < textY, 'line sits under the baseline');
    const a = await render('<p><a href="https://x.test">aaa bbb</a></p>');
    assert.equal(a.lines.length, 3);
    const wrapped = await render('<p><u>aaa bbb</u></p>', 22);
    assert.equal(wrapped.texts.length, 2);
    assert.equal(wrapped.lines.length, 2, 'only the words, no tail space');
    assert.ok(wrapped.lines[1].y < wrapped.lines[0].y, 'second underline is on the second line');
    const hard = await render('<p><u>abcdefghijklmnop</u></p>', 30);
    assert.ok(hard.texts.length >= 2 && hard.lines.length === hard.texts.length, 'every hard-broken chunk underlined');
    const both = await render('<p><u><s>aaa</s></u></p>');
    assert.equal(both.lines.length, 2, 'strike and underline both drawn');
    assert.equal((await render('<p>plain</p>')).lines.length, 0);
});

test('deep list nesting: a 40-level list keeps every drawn x inside the page', async () => {
    const html = '<ul><li><p>x</p>'.repeat(40) + '</li></ul>'.repeat(40);
    const r = await render(html);
    assert.ok(r.texts.length >= 40);
    for (const t of r.texts) assert.ok(t.x >= 0 && t.x <= 612 - 50 - 100, `x=${t.x}`);
});
