// Layout and content checks for the server-made estimate PDF: signature fit, accepted terms,
// info-row bounds, company-zone dates and lead names. Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFPage } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';
import { buildEstimatePdf } from '../src/lib/pdf';
import { SAMPLE_COMPANY, LONG_TITLE, shortEstimate, sampleSignatureDataUrl } from './estimate-pdf-fixtures';

const squash = (s: string) => s.replace(/\s+/g, ' ');
const PAGE_H = 792, MARGIN = 50, BOTTOM = 60;

async function extract(buf: Buffer): Promise<{ text: string; pages: number }> {
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const res = await parser.getText();
    await parser.destroy();
    return { text: res.text, pages: res.total };
}

interface Item { page: number; str: string; x: number; y: number }
async function textItems(buf: Buffer): Promise<Item[]> {
    // pdf-parse installs its own pdfjs worker (an older nested copy) on globalThis; use that same copy.
    const pdfjs = await import(pathToFileURL(path.resolve('node_modules/pdf-parse/node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
    const out: Item[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const content = await (await doc.getPage(p)).getTextContent();
        for (const it of content.items as Array<{ str: string; transform: number[] }>) {
            if (it.str.trim()) out.push({ page: p, str: it.str.trim(), x: it.transform[4], y: it.transform[5] });
        }
    }
    await doc.destroy();
    return out;
}

interface ImageBox { page: number; x: number; y: number; width: number; height: number }
/** Build a PDF while recording every drawImage call (page number is 1-based). */
async function buildCapturingImages(est: Parameters<typeof buildEstimatePdf>[0], opts?: Parameters<typeof buildEstimatePdf>[3]) {
    const boxes: ImageBox[] = [];
    const orig = PDFPage.prototype.drawImage;
    PDFPage.prototype.drawImage = function (this: PDFPage, image, options) {
        boxes.push({ page: this.doc.getPages().indexOf(this) + 1, x: options?.x ?? 0, y: options?.y ?? 0, width: options?.width ?? image.width, height: options?.height ?? image.height });
        return orig.call(this, image, options);
    };
    try {
        const buf = await buildEstimatePdf(est, SAMPLE_COMPANY, {}, opts);
        return { buf, boxes };
    } finally {
        PDFPage.prototype.drawImage = orig;
    }
}

function fillItems(n: number) {
    return Array.from({ length: n }, (_, i) => ({ id: `i${i}`, name: `Sample line ${i + 1}`, quantity: 1, unitCost: 10, total: 10, type: 'Labor' }));
}

// ---- B1: signature fits its block ----
test('signature image sits inside its block at every fill level, for phone-sized and small signatures', async () => {
    let sawNewPageStart = false;
    for (const [w, h] of [[1500, 600], [1000, 400], [300, 100]]) {
        const sig = sampleSignatureDataUrl(w, h);
        const levels = w === 1500 ? Array.from({ length: 41 }, (_, i) => i) : [1, 12, 22, 26, 30];
        for (const n of levels) {
            // "Invoiced" with approvedAt set is the real status once a signed estimate is invoiced.
            const est = { ...shortEstimate(), status: 'Invoiced', approvedBy: 'Pat Sample', approvedAt: new Date('2026-11-05T17:30:00Z'), approvalIp: '203.0.113.9', signatureUrl: sig, items: fillItems(Math.max(n, 1)) };
            const { buf, boxes } = await buildCapturingImages(est);
            const label = `${w}x${h} n=${n}`;
            assert.equal(boxes.length, 1, `one image drawn (${label})`);
            const box = boxes[0];
            const items = await textItems(buf);
            const heading = items.find(i => i.str === 'Electronic Signature / Approval');
            const ip = items.find(i => i.str.startsWith('IP Address'));
            assert.ok(heading && ip, `block text drawn (${label})`);
            assert.equal(box.page, heading!.page, `image on the heading's page (${label})`);
            assert.ok(box.width <= 180 + 1e-6 && box.height <= 60 + 1e-6, `fits the 180x60 box (${label}): ${box.width}x${box.height}`);
            assert.ok(box.width <= w && box.height <= h, `never upscaled (${label})`);
            assert.ok(box.x >= MARGIN && box.x + box.width <= 612 - MARGIN, `inside the side margins (${label})`);
            assert.ok(box.y + box.height < ip!.y, `below the metadata lines (${label})`);
            assert.ok(box.y + box.height < heading!.y, `below the heading (${label})`);
            assert.ok(box.y >= BOTTOM, `above the footer zone (${label}): y=${box.y}`);
            assert.ok(box.y + box.height <= PAGE_H - MARGIN, `never above the top margin (${label})`);
            if (heading!.page > 1 && heading!.y > 700) sawNewPageStart = true;
        }
    }
    assert.ok(sawNewPageStart, 'at least one fill level starts the block on a fresh page');
});

test('signature box keeps the aspect ratio and the totals stay clear of it', async () => {
    const est = { ...shortEstimate(), status: 'Invoiced', approvedBy: 'Pat Sample', approvedAt: new Date('2026-11-05T17:30:00Z'), signatureUrl: sampleSignatureDataUrl(1500, 600) };
    const { buf, boxes } = await buildCapturingImages(est);
    assert.ok(Math.abs(boxes[0].width / boxes[0].height - 2.5) < 1e-6);
    const total = (await textItems(buf)).find(i => i.str === 'Total');
    assert.ok(total && total.y > boxes[0].y + boxes[0].height, 'Total is above the signature box');
});

// ---- B2: terms and conditions ----
const RICH_TERMS = '<h2>Terms &amp; Conditions</h2><p>Payment is due within 14 days of each milestone.</p><ul><li>Change orders need written approval.</li></ul>';

test('terms print after the payment schedule and before the signature, once, with the duplicate heading dropped', async () => {
    const est = {
        ...shortEstimate(), status: 'Invoiced', approvedBy: 'Pat Sample', approvedAt: new Date('2026-11-05T17:30:00Z'),
        paymentSchedules: [{ name: 'Deposit', percentage: 30, amount: 187 }], termsAndConditions: RICH_TERMS,
    };
    const { text } = await extract(await buildEstimatePdf(est, SAMPLE_COMPANY));
    const flat = squash(text);
    assert.equal(flat.split('Terms & Conditions').length - 1, 1, 'heading printed once');
    assert.ok(flat.includes('Payment is due within 14 days of each milestone.'));
    assert.ok(flat.includes('Change orders need written approval.'));
    assert.ok(flat.indexOf('Payment Schedule') < flat.indexOf('Terms & Conditions'));
    assert.ok(flat.indexOf('Terms & Conditions') < flat.indexOf('Electronic Signature / Approval'));
});

test('legacy plain-text terms print literally, line breaks kept', async () => {
    const est = { ...shortEstimate(), termsAndConditions: 'Net 30 terms.\nClearance < 5 ft & access > 3 ft.' };
    const buf = await buildEstimatePdf(est, SAMPLE_COMPANY);
    const flat = squash((await extract(buf)).text);
    assert.ok(flat.includes('Net 30 terms.'));
    assert.ok(flat.includes('Clearance < 5 ft & access > 3 ft.'));
    const items = await textItems(buf);
    const first = items.find(i => i.str === 'terms.')!;
    const second = items.find(i => i.str === 'Clearance')!;
    assert.ok(first && second && second.y < first.y, 'typed line break kept');
});

test('no terms on the estimate: no Terms heading (same condition as the portal)', async () => {
    for (const termsAndConditions of [null, undefined, '']) {
        const { text } = await extract(await buildEstimatePdf({ ...shortEstimate(), termsAndConditions }, SAMPLE_COMPANY));
        assert.ok(!text.includes('Terms & Conditions'));
    }
});

test('a very long terms text paginates and never draws in the footer zone', async () => {
    const paragraphs = Array.from({ length: 160 }, (_, i) => `<p>Clause ${i + 1}. The contractor and the client agree that this sample clause is long enough to wrap onto a couple of lines in the page.</p>`);
    const est = { ...shortEstimate(), status: 'Invoiced', approvedBy: 'Pat Sample', approvedAt: new Date('2026-11-05T17:30:00Z'), termsAndConditions: paragraphs.join('') };
    const buf = await buildEstimatePdf(est, SAMPLE_COMPANY);
    const { text, pages } = await extract(buf);
    assert.ok(pages >= 4, `pages=${pages}`);
    assert.ok(squash(text).includes('Clause 160.'));
    assert.ok(squash(text).includes('Electronic Signature / Approval'));
    for (const it of await textItems(buf)) {
        const isFooter = Math.abs(it.y - 30) < 1;
        assert.ok(isFooter || it.y >= 45, `"${it.str}" drawn in the footer zone at y=${it.y} on page ${it.page}`);
    }
});

// ---- B4: the info row is bounded ----
test('a 12-line address after a long title is clamped to 4 lines with an ellipsis and stays above the footer', async () => {
    for (let reps = 1; reps <= 14; reps++) {
        const base = shortEstimate();
        const est = {
            ...base,
            title: Array.from({ length: reps }, () => LONG_TITLE).join(' '),
            project: { ...base.project!, location: Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of the jobsite address`).join('\n') },
        };
        const items = await textItems(await buildEstimatePdf(est, SAMPLE_COMPANY));
        const addr = items.filter(i => /^Line \d+ of the jobsite/.test(i.str));
        assert.ok(addr.length >= 1 && addr.length <= 4, `reps=${reps}: ${addr.length} address lines`);
        assert.ok(addr.some(i => i.str.endsWith('...')), `reps=${reps}: ellipsis on the last kept line`);
        for (const a of addr) assert.ok(a.y >= BOTTOM, `reps=${reps}: address line at y=${a.y}`);
        const label = items.find(i => i.str === 'JOBSITE ADDRESS');
        assert.ok(label && addr.every(a => a.page === label!.page), `reps=${reps}: address stays with its label`);
    }
});

test('long client name, email and project name are clamped to 2, 2 and 3 lines', async () => {
    const base = shortEstimate();
    const est = {
        ...base,
        project: { name: 'Project '.repeat(60), location: '1 Sample Street', client: { name: 'Client Name '.repeat(40), email: `${'a'.repeat(30)}@${'b'.repeat(200)}.example.test` } },
    };
    const items = await textItems(await buildEstimatePdf(est, SAMPLE_COMPANY));
    const ellipses = items.filter(i => i.str.endsWith('...'));
    assert.ok(ellipses.length >= 3, `ellipses=${ellipses.length}`);
    for (const it of items) assert.ok(it.y >= 30 - 1, 'nothing off the page');
});

// ---- P3: dates in the company zone ----
test('created date and signed time use the company zone, with the zone abbreviation (P3)', async () => {
    // 2026-11-06 05:30 UTC is 9:30 PM on Nov 5 in Pacific time.
    const instant = new Date('2026-11-06T05:30:00Z');
    const est = { ...shortEstimate(), createdAt: instant, status: 'Invoiced', approvedBy: 'Pat Sample', approvedAt: instant };
    for (const opts of [{ timeZone: 'America/Los_Angeles' }, undefined]) {
        const flat = squash((await extract(await buildEstimatePdf(est, SAMPLE_COMPANY, {}, opts))).text);
        assert.ok(flat.includes('Nov 5, 2026, 9:30 PM PST'), flat.slice(0, 400));
        assert.ok(flat.includes('Nov 5, 2026'));
        assert.ok(!flat.includes('Nov 6'), 'no UTC next-day date');
    }
    const nz = squash((await extract(await buildEstimatePdf(est, SAMPLE_COMPANY, {}, { timeZone: 'Pacific/Auckland' }))).text);
    assert.ok(nz.includes('Nov 6, 2026, 6:30 PM'));
});

// ---- P5: lead name in the PROJECT column ----
test('an estimate that belongs to a lead shows the lead name under PROJECT (P5)', async () => {
    const est = { ...shortEstimate(), project: null, lead: { name: 'Sample Lead Name', location: '9 Lead Road', client: { email: 'lead@example.test' } } };
    const items = await textItems(await buildEstimatePdf(est, SAMPLE_COMPANY));
    const label = items.find(i => i.str === 'PROJECT')!;
    const under = items.filter(i => i.page === label.page && Math.abs(i.x - label.x) < 2 && i.y < label.y && i.y > label.y - 40);
    assert.ok(under.some(i => i.str === 'Sample Lead Name'), `under PROJECT: ${under.map(i => i.str).join(' | ')}`);
});

// Signed terms must be complete: nothing the browser shows as text may be dropped from the signed record.
test('terms: every kind of content survives into the PDF text', async () => {
    const terms =
        '<h2>Terms</h2><p>Para ALPHA.</p><h4>H4-BRAVO</h4><h5>H5-CHARLIE</h5><h6>H6-DELTA</h6>' +
        '<div>DIV-ECHO<div>NESTED-FOXTROT</div></div>' +
        '<table><tbody><tr><td>CELL-GOLF</td><td><p>CELL-HOTEL</p></td></tr></tbody></table>' +
        '<pre>PRE-INDIA line1\nPRE-JULIET line2</pre><pre><code>CODE-KILO</code></pre>' +
        '<p><s>STRUCK-LIMA</s> <del>DEL-MIKE</del> <strike>STRIKE-NOVEMBER</strike></p>' +
        '<p>ENT-OSCAR &sect; &rsquo; &lsquo; &rdquo; &ldquo; &hellip; &copy; &reg; &trade; &mdash; &ndash; &bull; &middot; &deg; &frac12; &frac14; &frac34; &times; &nbsp;&amp;&lt;&gt;&quot;&apos; &#65; &#x42; &#8364; &#x1F600; &#0; &unknownthing;</p>' +
        '<custom-x>KEEP-PAPA</custom-x>' +
        'LOOSE-QUEBEC';
    const buf = await buildEstimatePdf({ ...shortEstimate(), termsAndConditions: terms }, SAMPLE_COMPANY);
    const { text } = await extract(buf);
    const t = squash(text);
    for (const w of ['ALPHA', 'H4-BRAVO', 'H5-CHARLIE', 'H6-DELTA', 'DIV-ECHO', 'NESTED-FOXTROT', 'CELL-GOLF', 'CELL-HOTEL', 'PRE-INDIA', 'PRE-JULIET', 'CODE-KILO',
        'STRUCK-LIMA', 'DEL-MIKE', 'STRIKE-NOVEMBER', 'ENT-OSCAR', 'KEEP-PAPA', 'LOOSE-QUEBEC']) {
        assert.ok(t.includes(w), `missing ${w}`);
    }
    assert.ok(t.includes('\u00a7') && t.includes('\u2019') && t.includes('\u2026') && t.includes('\u00a9') && t.includes('\u00bd') && t.includes('\u00d7'));
    assert.ok(t.includes('&<>"\''), 'amp/lt/gt/quot/apos decode');
    assert.ok(t.includes('A B \u20ac'), 'numeric decimal, hex, euro');
    assert.ok(t.includes('&unknownthing;'), 'unknown entity stays as typed');
    const items = await textItems(buf);
    const a = items.find((i) => i.str.includes('PRE-INDIA'))!;
    const b = items.find((i) => i.str.includes('PRE-JULIET'))!;
    assert.ok(a && b && a.y > b.y, 'pre line breaks kept');
});

test('terms: struck text is drawn with a line through it', async () => {
    const plain = await buildEstimatePdf({ ...shortEstimate(), termsAndConditions: '<p>Clause WORD here</p>' }, SAMPLE_COMPANY);
    const struck = await buildEstimatePdf({ ...shortEstimate(), termsAndConditions: '<p><s>Clause WORD here</s></p>' }, SAMPLE_COMPANY);
    const paths = async (b: Buffer) => {
        const pdfjs = await import(pathToFileURL(path.resolve('node_modules/pdf-parse/node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
        const doc = await pdfjs.getDocument({ data: new Uint8Array(b), useSystemFonts: true }).promise;
        let n = 0;
        for (let p = 1; p <= doc.numPages; p++) {
            const ops = await (await doc.getPage(p)).getOperatorList();
            n += ops.fnArray.filter((f: number) => f === pdfjs.OPS.constructPath).length;
        }
        await doc.destroy();
        return n;
    };
    assert.ok((await paths(struck)) > (await paths(plain)), 'extra drawn line for the struck run');
});
