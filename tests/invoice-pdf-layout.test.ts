// Content and layout checks for the server-made invoice PDF. Made-up data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { buildInvoicePdf, type InvoicePdfData } from '../src/lib/pdf';
import { PDFPage } from 'pdf-lib';
import { SAMPLE_COMPANY, SAMPLE_COMPANY_WITH_LOGO, FIXED_NOW, LA, sampleLogoBytes, shortInvoice, dueInvoice, allPaidInvoice, longInvoice } from './invoice-co-pdf-fixtures';

const squash = (s: string) => s.replace(/\s+/g, ' ');

async function extract(buf: Buffer): Promise<{ text: string; pages: number; perPage: string[] }> {
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const res = await parser.getText();
    await parser.destroy();
    return { text: squash(res.text), pages: res.total, perPage: res.pages.map((p: { text: string }) => squash(p.text)) };
}

async function build(inv: InvoicePdfData, extra: { requestedMilestoneIds?: string[]; company?: Record<string, unknown>; omitFocusedTotal?: boolean; logoBytes?: Uint8Array | null } = {}) {
    const audit = { lossy: false };
    let images = 0;
    const orig = PDFPage.prototype.drawImage;
    PDFPage.prototype.drawImage = function (this: PDFPage, image, options) { images++; return orig.call(this, image, options); };
    try {
        const buf = await buildInvoicePdf(inv, extra.company ?? SAMPLE_COMPANY, {
            timeZone: LA, now: FIXED_NOW, audit, requestedMilestoneIds: extra.requestedMilestoneIds,
            omitFocusedTotal: extra.omitFocusedTotal, logoBytes: extra.logoBytes,
        });
        return { buf, audit, images, ...(await extract(buf)) };
    } finally {
        PDFPage.prototype.drawImage = orig;
    }
}

test('header: valid PDF, code, bill-to falls back to the project client, PROJECT and JOB SITE print', async () => {
    const r = await build(shortInvoice());
    assert.equal(r.buf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(r.text.includes('INVOICE'));
    assert.ok(r.text.includes('INV-00042'));
    assert.ok(r.text.includes('Pat Sample'));
    assert.ok(r.text.includes('pat@example.test'));
    assert.ok(r.text.includes('PROJECT') && r.text.includes('Sample Fan Install'));
    assert.ok(r.text.includes('JOB SITE') && r.text.includes('1 Sample Street'));
    assert.equal(r.audit.lossy, false);
});

test('status badge follows the page: No Payment Due, Payment Due (sent or focused), Paid; never the raw status', async () => {
    const none = await build(shortInvoice());
    assert.ok(none.text.includes('No Payment Due'));
    assert.ok(!none.text.includes('Partially Paid'));
    const sent = await build(dueInvoice());
    assert.ok(sent.text.includes('Payment Due') && !sent.text.includes('No Payment Due'));
    const focusedOnly = await build(shortInvoice(), { requestedMilestoneIds: ['p2'] });
    assert.ok(focusedOnly.text.includes('Payment Due') && !focusedOnly.text.includes('No Payment Due'));
    const paid = await build(allPaidInvoice());
    assert.ok(/Status Paid/.test(paid.text));
});

test('money: Total Amount, Paid, Due Now and Remaining Balance print the page figures; Balance Due headline is gone', async () => {
    const r = await build(dueInvoice());
    assert.ok(r.text.includes('Total Amount $1,500.00'));
    assert.ok(r.text.includes('Paid $500.00'));
    assert.ok(r.text.includes('Due Now $850.00'));
    assert.ok(r.text.includes('Remaining Balance $1,000.00'));
    assert.ok(!r.text.includes('Balance Due'));
    const none = await build(shortInvoice());
    assert.ok(none.text.includes('Due Now $0.00'));
    assert.ok(none.text.includes('Remaining Balance $1,000.00'));
});

test('focus: Amount Requested is the exact focused sum, rows say Requested, foreign and Paid ids are ignored', async () => {
    const r = await build(dueInvoice(), { requestedMilestoneIds: ['p2', 'p3', 'p1', 'not-this-invoice'] });
    assert.ok(r.text.includes('Amount Requested $850.00'));
    assert.ok(r.text.includes('Total Amount $1,500.00'));
    assert.ok(!r.text.includes('Due Now') && !r.text.includes('Remaining Balance'));
    assert.ok(r.text.includes('Requested, Overdue'));
    assert.ok(/Cabinets Requested/.test(r.text));
    const none = await build(dueInvoice(), { requestedMilestoneIds: ['p1', 'zzz'] });
    assert.ok(!none.text.includes('Amount Requested'));
    assert.ok(none.text.includes('Due Now $850.00'));
});

test('row labels, due-upon-receipt and the Paid sub-line', async () => {
    const r = await build(dueInvoice());
    assert.ok(r.text.includes('Paid Nov 5, 2026'));
    assert.ok(r.text.includes('Overdue'));
    assert.ok(/Cabinets Due /.test(r.text));
    assert.ok(r.text.includes('Not yet due'));
    assert.ok(r.text.includes('Due upon receipt'));
});

test('dates: issue date wins, instants use the company zone, calendar days keep their stored day', async () => {
    const created = await build(shortInvoice());
    assert.ok(/Date Nov 2, 2026/.test(created.text), 'createdAt 2026-11-03T06:30Z is Nov 2 in Los Angeles');
    const issued = await build(dueInvoice());
    assert.ok(/Date Nov 4, 2026/.test(issued.text));
    assert.ok(created.text.includes('Dec 1, 2026'), 'midnight-UTC due date keeps its day');
    assert.ok(issued.text.includes('Paid Nov 5, 2026'), 'a Stripe-style instant (2026-11-05T19:30Z) prints in the company zone');
    const late = shortInvoice();
    late.payments[0].paymentDate = new Date('2026-11-06T03:00:00Z');
    assert.ok((await build(late)).text.includes('Paid Nov 5, 2026'));
    assert.ok(created.text.includes('Generated Nov 12, 2026'));
});

test('long invoice: several pages, header repeats, footer on every page, nothing lost, not lossy', async () => {
    const inv = longInvoice();
    const r = await build(inv);
    assert.ok(r.pages > 1);
    assert.equal(r.audit.lossy, false);
    r.perPage.forEach((t, i) => assert.ok(t.includes(`Page ${i + 1} of ${r.pages}`), `footer on page ${i + 1}`));
    assert.ok((r.text.match(/PAYMENT STATUS DUE DATE AMOUNT/g) ?? []).length >= 2, 'table header repeats');
    for (const p of inv.payments) assert.ok(r.text.includes(String(p.name).split(' ').slice(0, 2).join(' ')));
    assert.ok(r.text.includes('Milestone 60'));
    assert.ok(r.text.includes('LAST-NOTES-PARAGRAPH'));
});

test('lossy: unprintable letters, emoji and overflow flag the audit; printable accents do not', async () => {
    const viet = shortInvoice();
    viet.client = { name: 'Nguyễn Sample', email: 'n@example.test' };
    const v = await build(viet);
    assert.equal(v.audit.lossy, true);
    assert.ok(v.text.includes('?'));

    const emoji = shortInvoice();
    emoji.notes = 'All done \u{1F600}';
    assert.equal((await build(emoji)).audit.lossy, true);

    const jose = shortInvoice();
    jose.client = { name: 'José Sample', email: 'j@example.test' };
    assert.equal((await build(jose)).audit.lossy, false);

    const code = shortInvoice();
    code.code = 'INV-' + 'X'.repeat(80);
    assert.equal((await build(code)).audit.lossy, true);
});

test('F3: the exact (portal) path omits the focused Total Amount; the email path keeps it', async () => {
    const portal = await build(dueInvoice(), { requestedMilestoneIds: ['p2', 'p3'], omitFocusedTotal: true });
    assert.ok(!portal.text.includes('Total Amount'));
    assert.ok(portal.text.includes('Amount Requested $850.00'));
    const email = await build(dueInvoice(), { requestedMilestoneIds: ['p2', 'p3'] });
    assert.ok(email.text.includes('Total Amount $1,500.00'));
    // Without a focus the option changes nothing: the page shows the full summary.
    const unfocused = await build(dueInvoice(), { omitFocusedTotal: true });
    assert.ok(unfocused.text.includes('Total Amount $1,500.00'));
});

test('F1: a payment row taller than an empty page is lossy', async () => {
    const inv = shortInvoice();
    inv.payments[1] = { ...inv.payments[1], name: Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n') };
    assert.equal((await build(inv)).audit.lossy, true);
});

test('F4: the page footer shows phone, email and license; a header that leaves one out is lossy', async () => {
    const fields = (f: string[]) => ({ company: { ...SAMPLE_COMPANY, letterheadFields: JSON.stringify(f) } });
    assert.equal((await build(shortInvoice(), fields(['name', 'address', 'phone', 'email']))).audit.lossy, true);
    assert.equal((await build(shortInvoice(), fields(['name', 'address', 'phone', 'email', 'license']))).audit.lossy, false);
});

test('F4: a custom letterhead image that loads still leaves out the phone, email and license the page shows', async () => {
    const realFetch = globalThis.fetch;
    let fetched = 0;
    // No network: the letterhead image is served from fixture bytes.
    globalThis.fetch = (async () => {
        fetched++;
        return new Response(Buffer.from(sampleLogoBytes()), { status: 200, headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
    try {
        const r = await build(shortInvoice(), { company: { ...SAMPLE_COMPANY, letterheadMode: 'custom_image', letterheadImageUrl: 'https://img.example.test/x.png' } });
        assert.equal(fetched, 1);
        assert.equal(r.images, 1, 'the custom letterhead image was embedded and drawn');
        assert.equal(r.audit.lossy, true);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('F6: a configured logo is drawn from the supplied bytes; not fetched or not an image is lossy; none configured is fine', async () => {
    const ok = await build(shortInvoice(), { company: SAMPLE_COMPANY_WITH_LOGO, logoBytes: sampleLogoBytes() });
    assert.equal(ok.images, 1);
    assert.equal(ok.audit.lossy, false);
    assert.equal((await build(shortInvoice(), { company: SAMPLE_COMPANY_WITH_LOGO, logoBytes: null })).audit.lossy, true);
    assert.equal((await build(shortInvoice(), { company: SAMPLE_COMPANY_WITH_LOGO, logoBytes: new Uint8Array([1, 2, 3]) })).audit.lossy, true);
    const none = await build(shortInvoice());
    assert.equal(none.images, 0);
    assert.equal(none.audit.lossy, false);
});

test('F8: the footer date is the company-zone instant', async () => {
    const audit = { lossy: false };
    const buf = await buildInvoicePdf(shortInvoice(), SAMPLE_COMPANY, { timeZone: LA, now: new Date('2026-11-12T00:00:00Z'), audit });
    assert.ok((await extract(buf)).text.includes('Generated Nov 11, 2026'));
});
