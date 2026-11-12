import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';
import { buildEstimatePdf, wrapPlainText, pdfSafeText, clampLines } from '../src/lib/pdf';
import { SAMPLE_COMPANY, LONG_TITLE, shortEstimate, longEstimate, signedEstimate } from './estimate-pdf-fixtures';

async function extract(buf: Buffer): Promise<{ text: string; pages: number }> {
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const res = await parser.getText();
    await parser.destroy();
    return { text: res.text, pages: res.total };
}
const squash = (s: string) => s.replace(/\s+/g, ' ');

test('wrap helper keeps every word of a long title within the width', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const lines = wrapPlainText(LONG_TITLE, font, 18, 512);
    assert.ok(lines.length >= 2);
    for (const l of lines) assert.ok(font.widthOfTextAtSize(l, 18) <= 512);
    assert.equal(lines.join(' '), LONG_TITLE);
});

test('short estimate with a 90+ char title: valid PDF, full title, no Draft, no clipping', async () => {
    assert.ok(LONG_TITLE.length > 90);
    const buf = await buildEstimatePdf(shortEstimate(), SAMPLE_COMPANY);
    assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
    const { text, pages } = await extract(buf);
    assert.equal(pages, 1);
    assert.ok(squash(text).includes(LONG_TITLE), 'full title text present');
    assert.ok(!/draft/i.test(text), 'no Draft status');
    assert.ok(!/Status/.test(text), 'no status label on an unapproved copy');
    assert.ok(text.includes('Estimate # EST-00042'));
    assert.ok(text.includes('Page 1 of 1'));
    assert.ok(squash(text).includes('Estimate EST-00042'));
});

test('long estimate: sane page count, repeated table header, every item and footer present', async () => {
    const est = longEstimate();
    const buf = await buildEstimatePdf(est, SAMPLE_COMPANY);
    const { text, pages } = await extract(buf);
    assert.ok(pages >= 3 && pages <= 14, `pages=${pages}`);
    assert.ok(!/draft/i.test(text));
    const flat = squash(text);
    for (const it of est.items) assert.ok(flat.includes(squash(it.name!)), `missing item: ${it.name}`);
    assert.ok(flat.includes('Paragraph 14.'));
    assert.ok((text.match(/ITEM DESCRIPTION/g) || []).length >= 2, 'table header repeats on later pages');
    assert.ok(flat.includes(`Page ${pages} of ${pages}`));
    assert.ok(flat.includes('Payment Schedule'));
});

test('approved estimates print Approved; others print no status', async () => {
    const approved = { ...shortEstimate(), status: 'Approved', approvedBy: 'Pat Sample' };
    const { text } = await extract(await buildEstimatePdf(approved, SAMPLE_COMPANY));
    assert.ok(text.includes('Approved'));
});

test('an Invoiced estimate (after approval) still prints Approved and the signature block', async () => {
    const invoiced = { ...shortEstimate(), status: 'Invoiced', approvedBy: 'Pat Sample', approvedAt: new Date('2026-01-05T12:00:00Z') };
    const { text } = await extract(await buildEstimatePdf(invoiced, SAMPLE_COMPANY));
    assert.ok(text.includes('Approved'));
    assert.ok(text.includes('Signed By'));
});

test('a description taller than a page flows across pages without losing text', async () => {
    const base = shortEstimate();
    const sentences = Array.from({ length: 120 }, (_, i) => `Sentence number ${i + 1} describes sample work in detail.`);
    const est = { ...base, items: [{ ...base.items[0], description: sentences.join(' ') }] };
    const { text, pages } = await extract(await buildEstimatePdf(est, SAMPLE_COMPANY));
    assert.ok(pages >= 2);
    assert.ok(squash(text).includes('Sentence number 120 describes'));
});

test('pdfSafeText prints a plain field literally: no tag stripping, no entity decoding', () => {
    assert.equal(pdfSafeText('Clearance < 5 ft; opening > 3 ft'), 'Clearance < 5 ft; opening > 3 ft');
    assert.equal(pdfSafeText('<p>Hello <b>there</b></p>'), '<p>Hello <b>there</b></p>');
    assert.equal(pdfSafeText('Tile <client selection> per sq ft'), 'Tile <client selection> per sq ft');
    assert.equal(pdfSafeText('R&amp;D &lt;x&gt;'), 'R&amp;D &lt;x&gt;');
    assert.equal(pdfSafeText('a\r\nb\tc'), 'a\nb c');
});

test('pdfSafeText maps common un-encodable characters to plain equivalents', () => {
    assert.equal(pdfSafeText('Slope ≤ 5%'), 'Slope <= 5%');
    assert.equal(pdfSafeText('≥ ≠ ≈ →'), '>= != ~ ->');
    assert.equal(pdfSafeText('a−b ‑ ‒'), 'a-b - -');
    assert.equal(pdfSafeText('6′ 2″'), '6\' 2"');
    assert.equal(pdfSafeText('⅓ ⅔ ⅛ ⅜ ⅝ ⅞'), '1/3 2/3 1/8 3/8 5/8 7/8');
    assert.equal(pdfSafeText('a b c'), 'a b c');
    assert.equal(pdfSafeText('ok ✓ done'), 'ok ? done'); // a visible unencodable character: printed as "?" (and lossy)
});

test('an oversized SECTION row does not print quantity or unit price', async () => {
    const base = shortEstimate();
    const sentences = Array.from({ length: 160 }, (_, i) => `Section sentence ${i + 1} names a large scope of sample work.`);
    const est = {
        ...base,
        items: [{ id: 's1', type: 'Section', name: sentences.join(' '), quantity: 7777, unitCost: 1234.56, total: 5000 }],
    };
    const { text, pages } = await extract(await buildEstimatePdf(est, SAMPLE_COMPANY));
    assert.ok(pages >= 2, 'row really is oversized');
    assert.ok(!text.includes('7777'), 'no quantity on a section row');
    assert.ok(!text.includes('1,234.56'), 'no unit price on a section row');
});

async function lowestYOf(buf: Buffer, str: string): Promise<{ page: number; y: number } | null> {
    // pdf-parse installs its own pdfjs worker (an older nested copy) on globalThis; use that same copy.
    const pdfjs = await import(pathToFileURL(path.resolve('node_modules/pdf-parse/node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
    let found: { page: number; y: number } | null = null;
    for (let p = 1; p <= doc.numPages; p++) {
        const content = await (await doc.getPage(p)).getTextContent();
        for (const it of content.items as Array<{ str: string; transform: number[] }>) {
            if (it.str.trim() === str) found = { page: p, y: it.transform[5] };
        }
    }
    await doc.destroy();
    return found;
}

test('totals block with a very long tax label keeps Total above the footer zone at every fill level', async () => {
    const taxRateName = 'Very Long Sample Taxing District Name '.repeat(14);
    for (let n = 1; n <= 36; n++) {
        const base = shortEstimate();
        const items = Array.from({ length: n }, (_, i) => ({
            id: `i${i}`, name: `Sample line ${i + 1}`, quantity: 1, unitCost: 10, total: 10, type: 'Labor',
        }));
        const est = { ...base, items, taxRateName, processingFeeMarkup: 3, hideProcessingFee: false };
        const buf = await buildEstimatePdf(est, SAMPLE_COMPANY);
        const total = await lowestYOf(buf, 'Total');
        assert.ok(total, `Total drawn (n=${n})`);
        assert.ok(total!.y >= 60, `Total y=${total!.y} must be above the footer zone (n=${n})`);
    }
});

test('a payment schedule name longer than a page flows across pages and every row stays above the footer', async () => {
    const base = shortEstimate();
    const longName = Array.from({ length: 140 }, (_, i) => `Milestone word group ${i + 1} for the sample schedule.`).join(' ');
    const est = {
        ...base,
        paymentSchedules: [
            { name: 'Deposit', percentage: 10, amount: 100 },
            { name: longName, percentage: 50, amount: 500 },
            { name: 'Final', percentage: 40, amount: 400 },
        ],
    };
    const buf = await buildEstimatePdf(est, SAMPLE_COMPANY);
    const { text, pages } = await extract(buf);
    assert.ok(pages >= 2);
    assert.ok(squash(text).includes('Milestone word group 140 for the sample schedule.'));
    const finalRow = await lowestYOf(buf, 'Final');
    assert.ok(finalRow && finalRow.y >= 60, 'last schedule row above the footer zone');
});

test('a 2,000-character tax label is clamped to 3 lines ending in "..." and Total stays above the footer zone', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const long = 'Tax ' + 'x'.repeat(1996);
    assert.equal(long.length, 2000);
    const clamped = clampLines(wrapPlainText(long, font, 10, 150), 3, font, 10, 150);
    assert.equal(clamped.length, 3);
    assert.ok(clamped[2].endsWith('...'));
    for (const l of clamped) assert.ok(font.widthOfTextAtSize(l, 10) <= 150);
    assert.equal(clampLines(['a', 'b'], 3, font, 10, 150).length, 2, 'short labels untouched');

    for (const n of [1, 12, 20, 30]) {
        const base = shortEstimate();
        const items = Array.from({ length: n }, (_, i) => ({
            id: `i${i}`, name: `Sample line ${i + 1}`, quantity: 1, unitCost: 10, total: 10, type: 'Labor',
        }));
        const est = { ...base, items, taxRateName: long, processingFeeMarkup: 3, hideProcessingFee: false };
        const buf = await buildEstimatePdf(est, SAMPLE_COMPANY);
        const total = await lowestYOf(buf, 'Total');
        assert.ok(total, `Total drawn (n=${n})`);
        assert.ok(total!.y >= 60, `Total y=${total!.y} above footer zone (n=${n})`);
        const { text } = await extract(buf);
        assert.ok(text.includes('...'), 'clamp marker present');
        assert.ok(!text.includes('x'.repeat(400)), 'label not drawn in full');
    }
});

test('a signed estimate prints Approved, the signer name and embeds the drawn signature image', async () => {
    const buf = await buildEstimatePdf(signedEstimate(), SAMPLE_COMPANY);
    const { text } = await extract(buf);
    assert.ok(text.includes('Approved'));
    assert.ok(text.includes('Signed By:'));
    assert.ok(text.includes('Pat Sample'));
    const doc = await PDFDocument.load(buf);
    const hasImage = doc.context.enumerateIndirectObjects().some(([, o]) => (o as { dict?: { get?: (k: unknown) => unknown } }).dict?.get?.(PDFName.of('Subtype')) === PDFName.of('Image'));
    assert.ok(hasImage, 'signature image embedded');
});
