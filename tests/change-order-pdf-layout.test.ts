// Content and layout checks for the server-made change order PDF. Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFPage } from 'pdf-lib';
import { PDFParse } from 'pdf-parse';
import { buildChangeOrderPdf, type ChangeOrderPdfData } from '../src/lib/pdf';
import {
    SAMPLE_COMPANY, SAMPLE_COMPANY_WITH_LOGO, FIXED_NOW, LA, sampleSignatureDataUrl, sampleLogoBytes,
    fixedSignedCo, costPlusCo, creditCo, offlineCo, longCo, driftCo, lineDriftCo, emptyCo, qtyCo,
} from './invoice-co-pdf-fixtures';

const squash = (s: string) => s.replace(/\s+/g, ' ');

async function extract(buf: Buffer): Promise<{ text: string; pages: number; perPage: string[] }> {
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const res = await parser.getText();
    await parser.destroy();
    return { text: squash(res.text), pages: res.total, perPage: res.pages.map((p: { text: string }) => squash(p.text)) };
}

// The page always shows a logo, so the default company here has one configured (its bytes are passed in, never fetched).
async function build(co: ChangeOrderPdfData, extra: { company?: Record<string, unknown>; logoBytes?: Uint8Array | null } = {}) {
    const audit = { lossy: false };
    let images = 0;
    const orig = PDFPage.prototype.drawImage;
    PDFPage.prototype.drawImage = function (this: PDFPage, image, options) { images++; return orig.call(this, image, options); };
    try {
        const buf = await buildChangeOrderPdf(co, extra.company ?? SAMPLE_COMPANY_WITH_LOGO, {
            timeZone: LA, now: FIXED_NOW, audit, logoBytes: 'logoBytes' in extra ? extra.logoBytes : sampleLogoBytes(),
        });
        return { buf, audit, images, ...(await extract(buf)) };
    } finally {
        PDFPage.prototype.drawImage = orig;
    }
}

const signed = (): ChangeOrderPdfData => ({ ...fixedSignedCo(), clientSignatureUrl: sampleSignatureDataUrl(1500, 600), companySignatureUrl: sampleSignatureDataUrl() });

test('status labels map exactly as the page does', async () => {
    const base = fixedSignedCo();
    const cases: Array<[string, string]> = [['Approved', 'Approved'], ['Sent', 'Sent - Awaiting Approval'], ['Declined', 'Declined'], ['Draft', 'Under Revision']];
    for (const [status, label] of cases) {
        const r = await build({ ...base, status, approvedBy: null, companySignedBy: null });
        assert.ok(r.text.includes(`Status ${label}`), `${status} -> ${label}`);
    }
});

test('header facts: Original Est., job site, Reason for Change, complete long title, company-zone date', async () => {
    const r = await build(signed());
    assert.ok(r.text.includes('Original Est. EST-00042'));
    assert.ok(r.text.includes('JOB SITE') && r.text.includes('1 Sample Street'));
    assert.ok(r.text.includes('Reason for Change'));
    assert.ok(r.text.includes('to the new wall layout as discussed on site'));
    assert.ok(/Date Nov 2, 2026/.test(r.text));
});

test('fixed price money regression: Subtotal, tax and Revised Amount are the old formula; not lossy', async () => {
    const co = { ...fixedSignedCo(), clientSignatureUrl: null, companySignatureUrl: null };
    co.estimate = { code: 'EST-00042', taxExempt: false, taxRatePercent: 8.5, taxRateName: 'Sample City' };
    const r = await build(co);
    // 600.00 subtotal, 8.5% = 51.00, total 651.00
    assert.ok(r.text.includes('Subtotal $600.00'));
    assert.ok(r.text.includes('Sample City (8.5%) $51.00'));
    assert.ok(r.text.includes('Revised Amount $651.00'));
    assert.equal(r.audit.lossy, false);
});

test('drift: the stored subtotal is still printed and the audit is lossy; line drift is lossy too', async () => {
    const d = await build(driftCo());
    assert.ok(d.text.includes('Subtotal $650.00'));
    assert.equal(d.audit.lossy, true);
    assert.equal((await build(lineDriftCo())).audit.lossy, true);
});

test('credit: Credit label and the balance sentence', async () => {
    const r = await build(creditCo());
    assert.ok(/Credit -\$271\.25/.test(r.text));
    assert.ok(r.text.includes('This credit will be taken off your remaining balance.'));
    assert.ok(!r.text.includes('Revised Amount'));
});

test('cost-plus: the page sentence, Approved terms, no Subtotal and no schedule', async () => {
    const r = await build(costPlusCo());
    assert.ok(r.text.includes('COST + 12% + TAX'));
    assert.ok(r.text.includes('This approval covers the scope and markup terms. Work is billed from actual time and materials; scope-line prices are non-binding estimates.'));
    assert.ok(r.text.includes('Approved terms') && r.text.includes('Cost + 12% + tax'));
    assert.ok(!r.text.includes('Subtotal'));
    assert.ok(!r.text.includes('PAYMENT SCHEDULE') && !r.text.includes('Should not print'));
});

test('schedule for fixed price: calendar day keeps its stored day; long tax label wraps without lossy', async () => {
    const r = await build({ ...fixedSignedCo(), clientSignatureUrl: null, companySignatureUrl: null });
    assert.ok(r.text.includes('PAYMENT SCHEDULE'));
    assert.ok(r.text.includes('Deposit · Dec 1, 2026'));
    assert.ok(r.text.includes('Transportation District Levy (8.5%)'));
    assert.equal(r.audit.lossy, false);
});

test('signatures: signed block with image, countersign with image, company-zone date', async () => {
    const r = await build(signed());
    assert.ok(r.text.includes('Electronically Signed and Approved'));
    assert.ok(r.text.includes('Signed by: Pat Sample'));
    assert.ok(r.text.includes('Date: Nov 5, 2026, 9:30 PM PST'));
    assert.ok(r.text.includes('Company Countersignature'));
    assert.ok(r.text.includes('Signed by: Sam Contractor'));
    assert.equal(r.images, 3); // the logo and the two signatures
    assert.equal(r.audit.lossy, false);
});

test('an undecodable saved signature makes the audit lossy', async () => {
    const co = signed();
    co.clientSignatureUrl = 'data:image/png;base64,AAAA';
    assert.equal((await build(co)).audit.lossy, true);
});

test('offline approval: summary and honest wording print without a signer; the staff note never does', async () => {
    const r = await build(offlineCo());
    assert.ok(r.text.includes('Client Approval'));
    assert.ok(r.text.includes('Approved by the office on Nov 8, 2026 (phone)') || /Approved by .* on Nov 8, 2026/.test(r.text));
    assert.ok(r.text.includes('Recorded by the office. Not signed electronically.'));
    assert.ok(!r.text.includes('SECRET-NOTE-XYZ'));
});

test('long change order: several pages, every schedule row, footer on every page, not lossy', async () => {
    const r = await build(longCo());
    assert.ok(r.pages > 2);
    assert.equal(r.audit.lossy, false);
    r.perPage.forEach((t, i) => assert.ok(t.includes(`Page ${i + 1} of ${r.pages}`), `footer on page ${i + 1}`));
    for (let i = 1; i <= 50; i++) assert.ok(r.text.includes(`Schedule row ${i} `), `schedule row ${i}`);
});

test('empty change order prints the page message', async () => {
    const r = await build(emptyCo());
    assert.ok(r.text.includes('No items specified for this Change Order.'));
});

test('F1: a line taller than an empty page makes the audit lossy; a schedule row too', async () => {
    const tall = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
    const co = { ...qtyCo(1), items: [{ type: 'Material', name: tall, quantity: 1, unitCost: 10, total: 10 }] };
    assert.equal((await build(co)).audit.lossy, true);
    const sched = { ...fixedSignedCo(), clientSignatureUrl: null, companySignatureUrl: null, paymentSchedules: [{ name: tall, amount: 100, dueDate: null }] };
    assert.equal((await build(sched)).audit.lossy, true);
    assert.equal((await build({ ...fixedSignedCo(), clientSignatureUrl: null, companySignatureUrl: null })).audit.lossy, false);
});

test('F2: a blank zero-price row the page shows but the PDF drops makes the audit lossy', async () => {
    const co = qtyCo(1);
    co.items = [...co.items, { type: 'Material', name: '', quantity: 7, unitCost: 0, total: 0 }];
    assert.equal((await build(co)).audit.lossy, true);
    // Section headers are not rendered by the page, so dropping them is not a difference.
    const withSection = qtyCo(1);
    withSection.items = [{ type: 'Section', name: 'Kitchen', quantity: 0, unitCost: 0, total: 0 }, ...withSection.items];
    assert.equal((await build(withSection)).audit.lossy, false);
});

test('F4: a header that leaves out the phone or email the page shows is lossy', async () => {
    assert.equal((await build(qtyCo(1), { company: { ...SAMPLE_COMPANY_WITH_LOGO, letterheadFields: JSON.stringify(['name', 'address']) } })).audit.lossy, true);
    assert.equal((await build(qtyCo(1), { company: { ...SAMPLE_COMPANY_WITH_LOGO, letterheadFields: JSON.stringify(['name', 'address', 'phone', 'email']) } })).audit.lossy, false);
    // Nothing to leave out when the company has no phone or email.
    assert.equal((await build(qtyCo(1), { company: { ...SAMPLE_COMPANY_WITH_LOGO, phone: '', email: '', letterheadFields: JSON.stringify(['name']) } })).audit.lossy, false);
});

test('F5: quantities 4, 999, 1000, 1250 and 12.75 print without overflow', async () => {
    for (const q of [4, 999, 1000, 1250, 12.75]) {
        const r = await build(qtyCo(q));
        assert.equal(r.audit.lossy, false, `quantity ${q}`);
        assert.ok(r.text.includes(String(q)), `quantity ${q} prints`);
    }
});

test('F6: the logo is drawn from the supplied bytes; every way it cannot be is lossy; no network', async () => {
    const withLogo = await build(qtyCo(1));
    assert.equal(withLogo.images, 1);
    assert.equal(withLogo.audit.lossy, false);
    // Configured but not fetched, or fetched but not an image.
    assert.equal((await build(qtyCo(1), { logoBytes: null })).audit.lossy, true);
    assert.equal((await build(qtyCo(1), { logoBytes: new Uint8Array([1, 2, 3]) })).audit.lossy, true);
    // No logo configured: the page shows the bundled /logo.png, which the PDF cannot draw.
    const none = await build(qtyCo(1), { company: SAMPLE_COMPANY });
    assert.equal(none.images, 0);
    assert.equal(none.audit.lossy, true);
});

test('F8: the footer date is the company-zone instant, not the UTC calendar day', async () => {
    const audit = { lossy: false };
    // 2026-11-12 00:00 UTC is still Nov 11 in Los Angeles; the calendar-day formatter would print the UTC day.
    const buf = await buildChangeOrderPdf(qtyCo(1), SAMPLE_COMPANY_WITH_LOGO, { timeZone: LA, now: new Date('2026-11-12T00:00:00Z'), audit, logoBytes: sampleLogoBytes() });
    const r = await extract(buf);
    assert.ok(r.text.includes('Generated Nov 11, 2026'), r.text.slice(-120));
});
