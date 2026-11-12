// The audit verdict ("lossy") must be conservative: whenever the server PDF alters, drops, truncates, renumbers
// or cannot be sure about something the customer sees on the portal page, lossy is true and the phone keeps the
// complete screenshot. Every case asserts the verdict through auditEstimatePdfText, the helper behind the
// canUseServerEstimatePdf server action. Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFPage } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';
import { auditEstimatePdfText, buildEstimatePdf, clampLines, type EstimatePdfData } from '../src/lib/pdf';
import { SAMPLE_COMPANY, longEstimate, shortEstimate } from './estimate-pdf-fixtures';

const withTerms = (html: string): EstimatePdfData => ({ ...shortEstimate(), termsAndConditions: html });
const lossyOf = async (est: EstimatePdfData, signer?: string | null) => (await auditEstimatePdfText(est, SAMPLE_COMPANY, signer)).lossy;
const withItems = (items: EstimatePdfData['items']): EstimatePdfData => ({ ...shortEstimate(), items });

async function drawn(est: EstimatePdfData): Promise<string[]> {
    const out: string[] = [];
    const orig = PDFPage.prototype.drawText;
    PDFPage.prototype.drawText = function (this: PDFPage, text, options) { out.push(String(text)); return orig.call(this, text, options); };
    try { await buildEstimatePdf(est, SAMPLE_COMPANY, {}, { audit: { lossy: false }, dryRun: true }); } finally { PDFPage.prototype.drawText = orig; }
    return out;
}

test('baseline: the short fixture estimate is not lossy', async () => {
    assert.equal(await lossyOf(shortEstimate()), false);
});

// --- K1: only invisible characters vanish silently ---
test('emoji bullets are lossy (both lines print without their marks otherwise)', async () => {
    assert.equal(await lossyOf(withTerms('<ul><li>✅ Demolition</li><li>❌ Permit fees</li></ul>')), true);
    assert.equal(await lossyOf(withItems([{ id: 'a', name: 'Scope', description: '✅ Demolition ❌ Permit fees', quantity: 1, unitCost: 1, total: 1 }])), true);
});

test('a signer name with an emoji is lossy', async () => {
    assert.equal(await lossyOf(shortEstimate(), 'Ann \u{1F642} Lee'), true);
    assert.equal(await lossyOf(shortEstimate(), 'Ann\u200b Lee'), false); // zero-width is invisible
});

// --- K2: plain fields print literally ---
test('"<client selection>" in an item description prints literally and is not lossy', async () => {
    const est = withItems([{ id: 'a', name: 'Tile', description: 'Tile allowance <client selection> per sq ft', quantity: 1, unitCost: 10, total: 10 }]);
    assert.ok((await drawn(est)).some(t => t.includes('Tile allowance <client selection> per sq ft')));
    assert.equal(await lossyOf(est), false);
});

test('"R&amp;D" in a plain field prints literally, as the portal shows it', async () => {
    const est = withItems([{ id: 'a', name: 'R&amp;D <b>fee</b>', description: 'R&amp;D', quantity: 1, unitCost: 10, total: 10 }]);
    const lines = await drawn(est);
    assert.ok(lines.some(t => t.includes('R&amp;D <b>fee</b>')), lines.join('|'));
    assert.ok(lines.includes('R&amp;D'));
    assert.equal(await lossyOf(est), false);
});

test('a typed signer name with markup characters prints literally', async () => {
    const est = shortEstimate();
    const lines: string[] = [];
    const orig = PDFPage.prototype.drawText;
    PDFPage.prototype.drawText = function (this: PDFPage, text, options) { lines.push(String(text)); return orig.call(this, text, options); };
    try { await buildEstimatePdf({ ...est, status: 'Approved', approvedBy: 'Pat <b>Smith</b>', approvedAt: new Date('2026-11-03T12:00:00Z') }, SAMPLE_COMPANY, {}, { audit: { lossy: false }, dryRun: true }); } finally { PDFPage.prototype.drawText = orig; }
    assert.ok(lines.some(t => t.includes('Signed By:  Pat <b>Smith</b>')));
    assert.equal(await lossyOf(est, 'Pat <b>Smith</b>'), false);
});

// --- K3: truncation ---
test('a 98 character project name and a long two-person client name are lossy (clamped with "...")', async () => {
    const longProject = 'Henderson Residence Master Bathroom Remodel, Guest Bath Refresh and Kitchen Backsplash Replacement';
    assert.equal(longProject.length, 98);
    const base = shortEstimate();
    assert.equal(await lossyOf({ ...base, project: { name: longProject, location: '1 Sample Street', client: { name: 'Pat Sample', email: 'pat@example.test' } } }), true);
    assert.equal(await lossyOf({ ...base, project: { name: 'Sample', location: '1 Sample Street', client: { name: 'Alexandria Montgomery-Wellington and Christopher Montgomery-Wellington', email: 'pat@example.test' } } }), true);
    assert.equal(await lossyOf({ ...base, project: { name: 'Sample', location: '1 Sample Street', client: { name: 'Pat Sample', email: 'pat@example.test' } } }), false);
});

test('clampLines marks the audit only when it really truncates', () => {
    const font = { widthOfTextAtSize: (t: string) => t.length * 5 } as never;
    const a = { lossy: false };
    assert.deepEqual(clampLines(['a', 'b'], 2, font, 10, 100, a), ['a', 'b']);
    assert.equal(a.lossy, false);
    assert.equal(clampLines(['a', 'b', 'c'], 2, font, 10, 100, a).length, 2);
    assert.equal(a.lossy, true);
});

// --- K4: strict allowlist on rich text ---
const RICH_LOSSY: Array<[string, string]> = [
    ['ol start', '<ol start="3"><li><p>third</p></li><li><p>fourth</p></li></ol>'],
    ['li value', '<ol><li value="7"><p>seven</p></li></ol>'],
    ['ol reversed', '<ol reversed><li><p>a</p></li><li><p>b</p></li></ol>'],
    ['open dialog', '<p>Visible</p><dialog open>Surprise clause</dialog>'],
    ['closed dialog', '<p>Visible</p><dialog>Hidden clause</dialog>'],
    ['hidden span', '<p>Visible <span hidden>secret</span> end</p>'],
    ['display none', '<p>Visible <span style="display:none">secret</span> end</p>'],
    ['font-size zero', '<p>Visible <span style="font-size:0">secret</span> end</p>'],
    ['transparent colour', '<p>Visible <span style="color:transparent">secret</span> end</p>'],
    ['utility class', '<p class="hidden">secret</p>'],
    ['closed details', '<p>Intro</p><details><summary>Fine print</summary><p>Inside</p></details>'],
    ['div inside li', '<ul><li><div>one</div><div>two</div></li></ul>'],
    ['table inside li', '<ul><li><table><tr><td>A</td><td>B</td></tr></table></li></ul>'],
    ['img', '<p>Logo</p><img src="https://example.test/x.png" alt="x">'],
    ['style element', '<p>Intro</p><style>p{color:red}</style><p>Body</p>'],
    ['dir attribute', '<p dir="rtl">right to left</p>'],
    ['sup', '<p>x<sup>2</sup></p>'],
    ['li p then loose text', '<ul><li><p>one</p>two</li></ul>'],
    ['li p then inline tag', '<ul><li><p>one</p><strong>two</strong></li></ul>'],
    ['tiny font', '<p>Visible <span style="font-size:0.01px">secret</span></p>'],
    ['near-transparent hex colour', '<p>Visible <span style="color:#fff0">secret</span></p>'],
    ['transparent 8-digit hex', '<p>Visible <span style="color:#ffffff00">secret</span></p>'],
    ['near-transparent rgba', '<p>Visible <span style="color:rgba(0,0,0,0.01)">secret</span></p>'],
    ['nowrap outside a merge chip', '<p>Visible <span style="white-space:nowrap">secret</span></p>'],
    ['padding outside a merge chip', '<p style="padding:1px">secret</p>'],
    // Deny by default: the portal prose container adds or hides something the PDF does not draw.
    ['inline code (prose adds backticks)', '<p>Use <code>GFCI</code> outlets.</p>'],
    ['code block', '<p>x</p><pre><code>Tile   40 sf\nGrout   2 bags</code></pre>'],
    ['pre (spaces collapse)', '<p>x</p><pre>a    b</pre>'],
    ['blockquote (prose adds quote marks)', '<p>x</p><blockquote><p>Covered for one year.</p></blockquote>'],
    ['table', '<p>x</p><table><tbody><tr><td><p>A</p></td><td><p>B</p></td></tr></tbody></table>'],
    ['table with tfoot before tbody', '<p>x</p><table><tfoot><tr><td>Total</td></tr></tfoot><tbody><tr><td>Row</td></tr></tbody></table>'],
    ['hr (the PDF draws no rule)', '<p>Above</p><hr><p>Below</p>'],
    ['div', '<div><p>In a div</p></div>'],
    ['white on white', '<p>Visible <span style="color:#ffffff;background-color:#ffffff">secret</span></p>'],
    ['any colour style', '<p>Visible <span style="color:#ff0000">red</span></p>'],
    ['any background style', '<p>Visible <span style="background-color:#ffff00">marked</span></p>'],
    ['line-through by style', '<p>Includes <span style="text-decoration: line-through">haul-away</span></p>'],
    ['bold by style', '<p><span style="font-weight:700">bold</span></p>'],
    ['text-align on a paragraph (no editor produces it)', '<p style="text-align:center">centred</p>'],
    ['class on a link', '<p><a class="x" href="https://x.test">x</a></p>'],
    ['title on a link', '<p><a title="t" href="https://x.test">x</a></p>'],
    ['id on a heading', '<h2 id="a">Head</h2>'],
    ['data attribute on a paragraph', '<p data-x="1">x</p>'],
    ['merge chip with only part of the editor style', '<p><span data-merge-field="client_name" style="background:#eff6ff" contenteditable="false">Pat</span></p>'],
    ['merge chip with an extra declaration', '<p><span data-merge-field="client_name" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:1px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;white-space:nowrap;font-style:normal;display:none" contenteditable="false">Pat</span></p>'],
    ['merge chip with a different colour', '<p><span data-merge-field="client_name" style="background:#ffffff;color:#ffffff;border:1px solid #bfdbfe;padding:1px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;white-space:nowrap;font-style:normal;" contenteditable="false">Pat</span></p>'],
    ['span with a class', '<p><span class="sr-only">x</span></p>'],
    ['unresolved merge chip label (the angle brackets print as "?")', '<p><span data-merge-field="client_name" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:1px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;white-space:nowrap;font-style:normal;" contenteditable="false">\u27e8Client Name\u27e9</span></p>'],
    ['sub', '<p>H<sub>2</sub>O</p>'],
];

for (const [name, html] of RICH_LOSSY) {
    test(`rich text ${name} is lossy`, async () => {
        assert.equal(await lossyOf(withTerms(html)), true);
        // The same check applies to the overview and notes sections.
        assert.equal(await lossyOf({ ...shortEstimate(), overviewEnabled: true, overviewBody: html }), true);
        assert.equal(await lossyOf({ ...shortEstimate(), notesEnabled: true, notesBody: html }), true);
    });
}

// The 13 typical editor outputs (RichTextEditor / MergeFieldEditor / AI plain text). Twelve are NOT lossy; tt-merge
// is lossy: its chip carries only part of the editor style, and the angle brackets of an unresolved placeholder label
// print as "?" (an unresolved placeholder should not be certified).
const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(40);
const MERGE_LABEL = String.fromCharCode(0x27e8) + 'Client Name' + String.fromCharCode(0x27e9);
const TYPICAL: Array<[string, string, boolean]> = [
    ['tt-paras', '<p>First paragraph with <strong>bold</strong> and <em>italic</em> and <a href="https://x.test">a link</a>.</p><p>Second &amp; last &lt;tag&gt; &nbsp;x.</p>', false],
    ['tt-empty-p', '<p>Alpha</p><p></p><p>Bravo</p>', false],
    ['tt-headings', '<h1>One</h1><p>a</p><h2>Two</h2><p>b</p><h3>Three</h3><p>c</p>', false],
    ['tt-lists', '<ul><li><p>One</p></li><li><p>Two</p><ul><li><p>Nested</p></li></ul></li></ul><ol><li><p>First</p></li><li><p>Second</p><p>second para</p></li></ol>', false],
    ['tt-br', '<p>Line one<br>Line two<br><br>Line four</p>', false],
    ['tt-long', `<p>${long}</p><ul><li><p>${long}</p></li></ul>`, false],
    ['tt-bold-italic', '<p><strong><em>both</em></strong> <b>b</b> <i>i</i></p>', false],
    ['tt-merge', '<p>Dear <span data-merge-field="client_name" style="background:#eff6ff" contenteditable="false">'+MERGE_LABEL+'</span>, thanks.</p>', true],
    ['tt-underline', '<p>Some <u>under</u> text</p>', false],
    ['tt-numeric-ent', '<p>It&#39;s &#8212; &#x2019; &quot;q&quot; &apos;a&apos;</p>', false],
    ['ai-plain-noblock', 'Plain overview with no tags at all and <b>bold</b>.', false],
    ['ai-plain-newlines', 'Line A\nLine B\n\nLine C', false],
    ['ws-between-blocks', '<p>A</p>\n  <p>B</p>\n', false],
];

test('the 13 typical editor outputs: 12 are NOT lossy, tt-merge is (partial chip style, unresolved label)', async () => {
    assert.equal(TYPICAL.length, 13);
    assert.equal(TYPICAL.filter(t => !t[2]).length, 12);
    for (const [name, html, expectLossy] of TYPICAL) {
        assert.equal(await lossyOf(withTerms(html)), expectLossy, `terms ${name}`);
        assert.equal(await lossyOf({ ...shortEstimate(), overviewEnabled: true, overviewBody: html }), expectLossy, `overview ${name}`);
        assert.equal(await lossyOf({ ...shortEstimate(), notesEnabled: true, notesBody: html }), expectLossy, `notes ${name}`);
    }
});

const chipStyle = 'background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:1px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;white-space:nowrap;font-style:normal;';
const signingChipStyle = 'background:#fff1f2;color:#be185d;border:1px solid #fecdd3;padding:1px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;white-space:nowrap;font-style:normal;';
const chip = (text: string, style = chipStyle) => `<span data-merge-field="client_name" style="${style}" contenteditable="false">${text}</span>`;
const CHIP = `<p>Dear ${chip('Pat Sample')}.</p>`;

test('a RESOLVED merge chip with exactly the editor attributes and style is not lossy (both editor colours)', async () => {
    assert.equal(await lossyOf(withTerms(CHIP)), false);
    assert.equal(await lossyOf(withTerms(`<p>${chip('Pat Sample', signingChipStyle)}</p>`)), false);
});

test('a plain terms document (headings, paragraphs, bold/italic/underline/strike, bullet and numbered lists incl. one nested list, links, resolved chip) is NOT lossy', async () => {
    const terms = '<h1>Terms</h1><h2>Payment</h2><p>Payment is <strong>due</strong> within <em>14</em> days, <u>no exceptions</u>, and <s>late fees</s> waived once.</p>'
        + '<h3>Scope</h3><ul><li><p>Demo and haul-away</p></li><li><p>New vanity</p><ul><li><p>Quartz top</p></li><li><p>Undermount sink</p></li></ul></li></ul>'
        + '<ol><li><p>Deposit</p></li><li><p>Rough-in</p><ol><li><p>Plumbing</p></li><li><p>Electrical</p></li></ol></li><li><p>Final</p></li></ol>'
        + `<p>Questions? See <a href="https://example.test/terms" target="_blank" rel="noopener noreferrer nofollow">our terms page</a>. Prepared for ${chip('Pat Sample')}.</p>`;
    assert.equal(await lossyOf(withTerms(terms)), false);
    // Nested lists are certified because the renderer prints them like the portal: the bullet for every nested
    // bullet item, numbering restarting at 1 inside a nested list, the parent's numbering continuing after it.
    const pdfText = await pdfTextOf(await buildEstimatePdf(withTerms(terms), SAMPLE_COMPANY, {}, { audit: { lossy: false }, dryRun: true }));
    const flat = pdfText.replace(/[ \t]+/g, ' ');
    assert.ok(/1\. Deposit\s+2\. Rough-in\s+1\. Plumbing\s+2\. Electrical\s+3\. Final/.test(flat), flat);
    assert.ok(/\u2022 New vanity\s+\u2022 Quartz top\s+\u2022 Undermount sink/.test(flat), flat);
});

test('existing rich fixtures (longEstimate overview and notes, the signature-terms terms) are not lossy', async () => {
    assert.equal(await lossyOf(longEstimate()), false);
    const terms = '<h2>Terms &amp; Conditions</h2><p>Payment is due within 14 days of each milestone.</p><ul><li>Change orders need written approval.</li></ul>';
    assert.equal(await lossyOf(withTerms(terms)), false);
    // The app's own overview writer (estimate-overview.ts) emits plain <p> paragraphs.
    assert.equal(await lossyOf({ ...shortEstimate(), overviewEnabled: true, overviewBody: '<p>First paragraph.</p><p>Second paragraph.</p>' }), false);
});

test('a soft hyphen (invisible on screen, a visible hyphen in the PDF fonts) is removed, not printed', async () => {
    const est = withItems([{ id: 'a', name: 'co' + String.fromCharCode(0xad) + 'op', quantity: 1, unitCost: 1, total: 1 }]);
    const lines = await drawn(est);
    assert.ok(lines.includes('coop'), lines.join('|'));
    assert.equal(await lossyOf(est), false);
});

test('markup the editors can produce but the portal shows differently stays lossy: code, quotes, rules, tables', async () => {
    const html = [
        '<p>x</p><pre><code class="language-js">a = 1\nb = 2</code></pre>',
        '<p>x</p><blockquote><p>quoted</p></blockquote><hr><p>after</p>',
        '<p>x</p><table style="min-width: 50px"><colgroup><col style="min-width: 25px"><col></colgroup><tbody><tr><th colspan="1" rowspan="1"><p>H</p></th><td><p>C</p></td></tr></tbody></table>',
        '<p><code>code</code></p>',
    ];
    for (const h of html) assert.equal(await lossyOf(withTerms(h)), true, h);
    // Strike variants the renderer draws (s, del, strike) and links with the editor's attributes stay exact.
    assert.equal(await lossyOf(withTerms('<p><s>struck</s> <del>del</del> <strike>strike</strike> <a href="https://x.test" target="_blank" rel="noopener noreferrer nofollow">link</a></p>')), false);
});

test('an all-Latin normal estimate with accents and a "<=" mapping is not lossy', async () => {
    const est: EstimatePdfData = {
        ...shortEstimate(),
        title: 'Baño principal — renovación',
        items: [{ id: 'a', name: 'Pago único', description: 'Pendiente ≤ 5% (½ pulgada), señal “café” – 12 €', quantity: 1, unitCost: 10, total: 10 }],
        termsAndConditions: '<p>Pago único — ½ ≤ 5</p>',
    };
    assert.equal(await lossyOf(est, 'José García'), false);
});

// --- K5: the dry run never reads storage ---
// embedSignatureImage is the only place the estimate PDF reads a saved signature (data URL, secure ref or storage
// URL) and every route to the image ends in doc.embedPng/embedJpg. A data URL needs no storage at all, so it lets
// the test count embeds: the audit must make none (it never even starts the load), a real render makes one.
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('the dry run never loads the saved signature; a real render does', async () => {
    const orig = PDFDocument.prototype.embedPng;
    let embeds = 0;
    PDFDocument.prototype.embedPng = function (this: PDFDocument, ...args: Parameters<PDFDocument['embedPng']>) { embeds++; return orig.apply(this, args); };
    try {
        const signed: EstimatePdfData = { ...shortEstimate(), status: 'Approved', approvedBy: 'Pat Sample', approvedAt: new Date('2026-11-03T12:00:00Z'), signatureUrl: PNG_1X1 };
        await auditEstimatePdfText(signed, SAMPLE_COMPANY, 'Pat Sample');
        assert.equal(embeds, 0, 'the audit must not load the signature');
        await buildEstimatePdf(signed, SAMPLE_COMPANY, {}, { audit: { lossy: false } });
        assert.equal(embeds, 1, 'control: a real render does embed it');
        // A secure ref (private storage) is never even looked up by the dry run.
        await auditEstimatePdfText({ ...signed, signatureUrl: 'secure:signatures/estimates/sample.png' }, SAMPLE_COMPANY, 'Pat Sample');
        assert.equal(embeds, 1);
    } finally {
        PDFDocument.prototype.embedPng = orig;
    }
});

// --- Reviewer round 9: brackets, wrapped titles and signer, over-wide single lines, empty client name ---
async function pdfTextOf(bytes: Buffer): Promise<string> {
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    const t = (await parser.getText()).text as string;
    await parser.destroy();
    return t;
}
const squash = (t: string) => t.replace(/\s+/g, '');

interface Draw { text: string; x: number; width: number }
async function drawsOf(est: EstimatePdfData): Promise<{ draws: Draw[]; lossy: boolean; bytes: Buffer }> {
    const draws: Draw[] = [];
    const orig = PDFPage.prototype.drawText;
    PDFPage.prototype.drawText = function (this: PDFPage, text, options) {
        const font = options?.font; const size = options?.size ?? 0;
        draws.push({ text: String(text), x: options?.x ?? 0, width: font ? font.widthOfTextAtSize(String(text), size) : 0 });
        return orig.call(this, text, options);
    };
    const audit = { lossy: false };
    let bytes: Buffer;
    try { bytes = await buildEstimatePdf(est, SAMPLE_COMPANY, {}, { audit }); } finally { PDFPage.prototype.drawText = orig; }
    return { draws, lossy: audit.lossy, bytes };
}
const insideMargins = (d: Draw) => d.x >= 50 - 0.01 && d.x + d.width <= 612 - 50 + 0.01;

test('the angle brackets of a merge label print as "?" and are lossy (no mapping to < and >)', async () => {
    const est = withItems([{ id: 'a', name: 'Dear ' + MERGE_LABEL, quantity: 1, unitCost: 1, total: 1 }]);
    const lines = await drawn(est);
    assert.ok(lines.includes('Dear ?Client Name?'), lines.join('|'));
    assert.equal(await lossyOf(est), true);
});

test('a 97 character overview title and a 100 character notes title wrap inside the margins, are fully present, and are not lossy', async () => {
    const overviewTitle = 'Kitchen and Bath Remodel Project Overview and Design Vision for the Sample Residence on Elm Court';
    const notesTitle = 'Estimate Notes and Assumptions Covering Allowances, Hidden Conditions, Permits and Schedule Changes!';
    assert.equal(overviewTitle.length, 97);
    assert.equal(notesTitle.length, 100);
    const est: EstimatePdfData = { ...shortEstimate(), overviewEnabled: true, overviewTitle, overviewBody: '<p>Overview body.</p>', notesEnabled: true, notesTitle, notesBody: '<p>Notes body.</p>', notesPlacement: 'after' };
    const { draws, lossy, bytes } = await drawsOf(est);
    assert.equal(lossy, false);
    const text = squash(await pdfTextOf(bytes));
    assert.ok(text.includes(squash(overviewTitle)), 'overview title fully present');
    assert.ok(text.includes(squash(notesTitle)), 'notes title fully present');
    for (const d of draws) assert.ok(insideMargins(d), `outside the margins: "${d.text}" x=${d.x} w=${d.width}`);
    assert.equal(await lossyOf(est), false);
});

test('a 107 character signer name wraps under the label, is fully present, inside the margins, and is not lossy', async () => {
    const name = 'Alexandria Montgomery Wellington Christopher Fitzgerald Montgomery Wellington Junior Esquire Sample Persons';
    assert.equal(name.length, 107);
    const est: EstimatePdfData = { ...shortEstimate(), status: 'Approved', approvedBy: name, approvedAt: new Date('2026-11-03T12:00:00Z'), approvalIp: '203.0.113.7' };
    const { draws, lossy, bytes } = await drawsOf(est);
    assert.equal(lossy, false);
    const text = squash(await pdfTextOf(bytes));
    assert.ok(text.includes(squash(name)), 'signer name fully present');
    assert.ok(draws.some(d => d.text === 'Signed By:'), 'label on its own line');
    for (const d of draws) assert.ok(insideMargins(d), `outside the margins: "${d.text}" x=${d.x} w=${d.width}`);
    assert.equal(await lossyOf(est, name), false);
    // A normal-length name keeps the original single line.
    const normal = await drawsOf({ ...est, approvedBy: 'Pat Sample' });
    assert.ok(normal.draws.some(d => d.text === 'Signed By:  Pat Sample'));
});

test('a 60 character estimate code is lossy; a normal code is not', async () => {
    const code = 'EST-' + 'X'.repeat(56);
    const sixty = code;
    assert.equal(sixty.length, 60);
    assert.equal(await lossyOf({ ...shortEstimate(), code: sixty }), true);
    assert.equal(await lossyOf({ ...shortEstimate(), code: 'EST-00042' }), false);
});

test('other over-wide single lines are lossy: a huge quantity, a long percentage text, an over-wide IP, a long company name in the footer', async () => {
    assert.equal(await lossyOf(withItems([{ id: 'a', name: 'Tile', quantity: 123456789.123, unitCost: 1, total: 1 }])), true);
    const ipLong = '2001:0db8:85a3:0000:0000:8a2e:0370:7334'.repeat(6);
    assert.equal(await lossyOf({ ...shortEstimate(), status: 'Approved', approvedBy: 'Pat Sample', approvedAt: new Date('2026-11-03T12:00:00Z'), approvalIp: ipLong }), true);
    const longCo = { ...SAMPLE_COMPANY, companyName: 'Sample Remodeling and Construction Services of the Greater Example Metropolitan Region, Incorporated, Doing Business As Sample Home Improvement Specialists LLC' };
    assert.equal((await auditEstimatePdfText(shortEstimate(), longCo)).lossy, true);
    const sched = { ...shortEstimate(), paymentSchedules: [{ name: 'Deposit', percentage: '1234567890123456789', amount: 100, dueDate: new Date('2026-12-01T12:00:00Z') }] };
    assert.equal(await lossyOf(sched), true);
    assert.equal(await lossyOf({ ...shortEstimate(), paymentSchedules: [{ name: 'Deposit', percentage: 50, amount: 287.5, dueDate: new Date('2026-12-01T12:00:00Z') }] }), false);
});

test('an empty client name prints the portal fallback "Unknown Client" under PREPARED FOR (and the audit is not lossy)', async () => {
    const est: EstimatePdfData = { ...shortEstimate(), project: { name: 'Sample Fan Install', location: '1 Sample Street', client: { name: '', email: 'pat@example.test' } } };
    const lines = await drawn(est);
    assert.ok(lines.includes('Unknown Client'), lines.join('|'));
    assert.equal(await lossyOf(est), false);
    const noClient: EstimatePdfData = { ...shortEstimate(), project: { name: 'Sample Fan Install', location: '1 Sample Street', client: null } };
    assert.ok((await drawn(noClient)).includes('Unknown Client'));
    // A real name still wins, and a lead's client is used when the project has none.
    assert.ok((await drawn(shortEstimate())).includes('Pat Sample'));
});

test('an inline element wrapping a block is lossy (the PDF would draw no strike or style on it)', async () => {
    for (const html of [
        '<del><ul><li><p>Remove the wall</p></li></ul></del>',
        '<s><p>Old price</p></s>',
        '<strong><p>Bold block</p></strong>',
        '<span><h2>Heading in span</h2></span>',
        '<h2>Title <p>para</p></h2>',
    ]) assert.equal(await lossyOf(withTerms(`<p>Intro</p>${html}`)), true, html); // a leading block makes the field rich HTML
    assert.equal(await lossyOf(withTerms('<p><s>Old price</s> <u>new</u> <a href="https://x.test">link</a></p>')), false);
});

test('list nesting deeper than 6 levels is lossy; 6 is not', async () => {
    const nest = (n: number) => '<ul><li><p>x</p>'.repeat(n) + '</li></ul>'.repeat(n);
    assert.equal(await lossyOf(withTerms(nest(6))), false);
    assert.equal(await lossyOf(withTerms(nest(7))), true);
    assert.equal(await lossyOf(withTerms(nest(8))), true);
});

test('a 926 character notes title at any height on the page: all text present, nothing in the footer zone', async () => {
    const title = Array.from({ length: 130 }, (_, i) => `Word${i}`).join(' ').slice(0, 926);
    assert.equal(title.length, 926);
    // Sweep the number of line items so the notes title (placed after the totals) starts at every height, including just above the page-break threshold.
    for (let k = 1; k <= 45; k += 1) {
        const items = Array.from({ length: k }, (_, i) => ({ id: `i${i}`, name: `Line ${i}`, quantity: 1, unitCost: 10, total: 10, type: 'Labor' }));
        const est = { ...shortEstimate(), items, notesEnabled: true, notesTitle: title, notesBody: '<p>Body text here.</p>' };
        const drawnText: Array<{ t: string; y: number }> = [];
        const orig = PDFPage.prototype.drawText;
        PDFPage.prototype.drawText = function (this: PDFPage, t, options) { drawnText.push({ t: String(t), y: options?.y ?? 0 }); return orig.call(this, t, options); };
        try { await buildEstimatePdf(est, SAMPLE_COMPANY, {}, { audit: { lossy: false }, dryRun: true }); } finally { PDFPage.prototype.drawText = orig; }
        const flat = drawnText.filter(d => d.y > 40).map(d => d.t).join(' ');
        for (const w of title.split(' ')) assert.ok(flat.includes(w), `k=${k} missing ${w}`);
        assert.ok(drawnText.filter(d => d.y <= 40).every(d => d.y === 30), `k=${k}: only the footer (y=30) below the body area`);
        assert.ok(drawnText.filter(d => d.t.startsWith('Word')).every(d => d.y >= 60), `k=${k}: title lines above the footer zone`);
    }
});
