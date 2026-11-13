// Text the standard PDF fonts cannot print: the shared cleaner (NFC, plain equivalents, "?" for letters and
// friends, harmless characters dropped) reports whether it was LOSSY, and buildEstimatePdf collects that into
// an audit so the server, not the client, decides whether the server PDF may stand in for the screenshot.
// Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFPage } from 'pdf-lib';
import { cleanPdfText } from '../src/lib/pdf-text-encoding';
import { pdfSafeText, buildEstimatePdf, auditEstimatePdfText, type EstimatePdfData } from '../src/lib/pdf';
import { SAMPLE_COMPANY, shortEstimate } from './estimate-pdf-fixtures';

test('cleaner: NFC composes "cafe\\u0301" to "café" and is not lossy', () => {
    assert.deepEqual(cleanPdfText('café'), { text: 'café', lossy: false });
});

test('cleaner: plain-equivalent mappings are not lossy', () => {
    assert.deepEqual(cleanPdfText('Opening ≤ 5 ft, ≥ 3, ⅓ cup, a‑b'), { text: 'Opening <= 5 ft, >= 3, 1/3 cup, a-b', lossy: false });
});

test('cleaner: CJK, Cyrillic, Vietnamese and Polish letters print "?" per character and are lossy', () => {
    assert.deepEqual(cleanPdfText('石棉'), { text: '??', lossy: true });
    assert.deepEqual(cleanPdfText('Москва'), { text: '??????', lossy: true });
    assert.deepEqual(cleanPdfText('Nguyễn'), { text: 'Nguy?n', lossy: true });
    assert.deepEqual(cleanPdfText('Łukasz'), { text: '?ukasz', lossy: true });
    assert.deepEqual(cleanPdfText('x١y'), { text: 'x?y', lossy: true });
});

test('cleaner: only invisible characters (variation selectors, zero-width, bidi, control) are removed without being lossy', () => {
    assert.deepEqual(cleanPdfText('a\u200bb\u200ec\u200fd\ufe0fe\u0007f'), { text: 'abcdef', lossy: false });
    // Bidi overrides/embeddings/isolates reorder what is shown ("\u202e100" displays as 001): removed, but lossy.
    assert.deepEqual(cleanPdfText('Price \u202e100\u202c USD'), { text: 'Price 100 USD', lossy: true });
    assert.deepEqual(cleanPdfText('x\u2066y\u2069'), { text: 'xy', lossy: true });
    assert.deepEqual(cleanPdfText('café “q” €5 •\tn\n'), { text: 'café “q” €5 •\tn\n', lossy: false });
});

test('cleaner: emoji, pictographs, dingbats and box symbols are visible: "?" and lossy; a skin tone after one joins its "?"', () => {
    assert.deepEqual(cleanPdfText('ok \u{1F600} fine'), { text: 'ok ? fine', lossy: true });
    assert.deepEqual(cleanPdfText('\u{2705} Demolition'), { text: '? Demolition', lossy: true });
    assert.deepEqual(cleanPdfText('\u{2714} a \u{2713} b'), { text: '? a ? b', lossy: true });
    assert.deepEqual(cleanPdfText('\u{1F44D}\u{1F3FD}'), { text: '?', lossy: true });
    assert.deepEqual(cleanPdfText('\u{1F3FD}'), { text: '?', lossy: true });
    assert.deepEqual(cleanPdfText('\u{2192}'), { text: '->', lossy: false }); // mapped to a plain equivalent
    assert.deepEqual(cleanPdfText('\u{2502}\u{25A0}'), { text: '??', lossy: true });
});

test('cleaner: currency and math symbols the fonts lack are "?" and lossy', () => {
    assert.deepEqual(cleanPdfText('₹5'), { text: '?5', lossy: true });
    assert.deepEqual(cleanPdfText('a ∑ b'), { text: 'a ? b', lossy: true });
});

test('pdfSafeText: mappings, NFC and "?" apply on the plain path', () => {
    assert.equal(pdfSafeText('≤ 5 ≥ 3 ≠ ≈ → ⅓ ⅞ ′ ″'), '<= 5 >= 3 != ~ -> 1/3 7/8 \' "');
    assert.equal(pdfSafeText('a‑b−c d'), 'a-b-c d');
    assert.equal(pdfSafeText('Pat 石 Sample'), 'Pat ? Sample');
    assert.equal(pdfSafeText('café'), 'café');
    assert.equal(pdfSafeText('a\tb'), 'a b');
    assert.equal(pdfSafeText('<p>R&amp;D Ж</p>'), '<p>R&amp;D ?</p>');
    const audit = { lossy: false };
    pdfSafeText('plain', audit);
    assert.equal(audit.lossy, false);
    pdfSafeText('Ж', audit);
    assert.equal(audit.lossy, true);
});

async function drawnText(est: EstimatePdfData, company: Record<string, unknown> = SAMPLE_COMPANY): Promise<{ drawn: string[]; lossy: boolean }> {
    const drawn: string[] = [];
    const orig = PDFPage.prototype.drawText;
    PDFPage.prototype.drawText = function (this: PDFPage, text, options) { drawn.push(String(text)); return orig.call(this, text, options); };
    const audit = { lossy: false };
    try {
        await buildEstimatePdf(est, company, {}, { audit });
    } finally {
        PDFPage.prototype.drawText = orig;
    }
    return { drawn, lossy: audit.lossy };
}

const full = (over: Partial<EstimatePdfData> = {}): EstimatePdfData => ({
    ...shortEstimate(),
    overviewEnabled: true, overviewTitle: 'Overview', overviewBody: '<p>Overview text</p>',
    notesEnabled: true, notesBody: '<p>Notes text</p>', notesPlacement: 'after',
    termsAndConditions: '<p>Terms text</p>',
    paymentSchedules: [{ name: 'Deposit', percentage: 30, amount: 100 }, { name: 'Final', percentage: 70, amount: 300 }],
    status: 'Approved', approvedBy: 'Pat Sample', approvedAt: new Date('2026-11-03T12:00:00Z'), approvalIp: '203.0.113.9',
    ...over,
});

test('audit: an all-Latin estimate (every field filled) is not lossy', async () => {
    const r = await drawnText(full({ title: 'Baño principal', termsAndConditions: '<p>Pago único — ½ ≤ 5</p>' }));
    assert.equal(r.lossy, false);
    assert.ok(r.drawn.some(t => t.includes('Signed By:')));
});

test('audit: lossy when the unencodable text is in any printed field', async () => {
    const nested = shortEstimate().items.map(i => ({ ...i }));
    const cases: Array<[string, Partial<EstimatePdfData>, Record<string, unknown>?]> = [
        ['title', { title: '厨房改造' }],
        ['nested item description', { items: [{ id: 's', name: 'Section', type: 'Section' }, { id: 'c', parentId: 's', name: 'Child', description: 'Ремонт ванной', quantity: 1, unitCost: 10, total: 10 }, ...nested] }],
        ['terms (rich)', { termsAndConditions: '<p>Clause 石</p>' }],
        ['terms (plain)', { termsAndConditions: 'Clause 石 plain' }],
        ['overview', { overviewBody: '<p>Przegląd Łukasz</p>' }],
        ['notes', { notesBody: '<p>Ghi chú Nguyễn</p>' }],
        ['schedule name', { paymentSchedules: [{ name: '首付', percentage: 100, amount: 400 }, { name: 'Final', percentage: 0, amount: 0 }] }],
        ['client name', { project: { name: 'Sample', client: { name: 'Łukasz Sample', email: 'a@example.test' } } }],
        ['tax label', { taxRateName: '税' }],
        ['signer name', { approvedBy: 'Nguyễn Văn An' }],
        ['estimate code', { code: 'EST-Ж' }],
        ['IP line', { approvalIp: '石' }],
        ['company name', {}, { ...SAMPLE_COMPANY, companyName: 'Złota Firma' }],
    ];
    for (const [name, over, company] of cases) {
        const r = await drawnText(full(over), company);
        assert.equal(r.lossy, true, name);
    }
});

test('dry run used by the portal action: a typed signer name with diacritics the fonts lack is lossy', async () => {
    const pending = { ...shortEstimate(), status: 'Sent', approvedBy: null, approvedAt: null } as EstimatePdfData;
    assert.deepEqual(await auditEstimatePdfText(pending, SAMPLE_COMPANY), { lossy: false });
    assert.deepEqual(await auditEstimatePdfText(pending, SAMPLE_COMPANY, 'Pat Sample'), { lossy: false });
    assert.deepEqual(await auditEstimatePdfText(pending, SAMPLE_COMPANY, 'Nguyễn Văn An'), { lossy: true });
    // The signed-by line is part of the audit even though nothing was saved: the estimate itself is untouched.
    assert.equal(pending.approvedBy, null);
});

test('the angle brackets U+27E8 / U+27E9 are not mapped to "<" and ">": they print "?" and are lossy (all PDFs)', () => {
    const open = String.fromCharCode(0x27e8), close = String.fromCharCode(0x27e9);
    assert.deepEqual(cleanPdfText(`${open}Client Name${close}`), { text: '?Client Name?', lossy: true });
    assert.equal(pdfSafeText(`${open}x${close}`), '?x?');
});
