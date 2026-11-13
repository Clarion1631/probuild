import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFParse } from 'pdf-parse';
import { computeEstimateDisplayTotals, parseSalesTaxes } from '../src/lib/estimate-display-totals';
import { buildEstimatePdf } from '../src/lib/pdf';
import { SAMPLE_COMPANY, shortEstimate } from './estimate-pdf-fixtures';

const TAXES = JSON.stringify([
    { name: 'Other City', rate: 7, isDefault: false },
    { name: 'Default City', rate: 9.25, isDefault: true },
]);
const base = { subtotal: 1000, taxExempt: false, savedRate: null, savedName: null, salesTaxes: [] };

// Hand-computed from the portal's original expressions, so a change to the shared function shows up here.
test('saved rate and name win over the company default', () => {
    const r = computeEstimateDisplayTotals({ ...base, savedRate: 8.5, savedName: 'Sample City', salesTaxes: parseSalesTaxes(TAXES) });
    assert.equal(r.tax, 85);
    assert.equal(r.taxLabel, 'Sample City (8.5%)');
    assert.equal(r.total, 1085);
});

test('no saved rate: the default-flagged company tax, else the first, else 8.8 "Tax"', () => {
    const a = computeEstimateDisplayTotals({ ...base, salesTaxes: parseSalesTaxes(TAXES) });
    assert.equal(a.taxLabel, 'Default City (9.25%)');
    assert.equal(a.tax, 92.5);
    assert.equal(a.total, 1092.5);
    const first = computeEstimateDisplayTotals({ ...base, salesTaxes: [{ name: 'First', rate: 6 }, { name: 'Second', rate: 7 }] });
    assert.equal(first.taxLabel, 'First (6%)');
    const none = computeEstimateDisplayTotals(base);
    assert.equal(none.taxLabel, 'Tax (8.8%)');
    assert.equal(none.tax, 88);
});

test('a saved rate of 0 is a rate, not "missing"', () => {
    const r = computeEstimateDisplayTotals({ ...base, savedRate: 0, salesTaxes: parseSalesTaxes(TAXES) });
    assert.equal(r.tax, 0);
    assert.equal(r.taxLabel, 'Default City (0%)', 'name still falls back to the company default, as the portal does');
});

test('tax exempt: no label, no tax', () => {
    const r = computeEstimateDisplayTotals({ ...base, taxExempt: true, savedRate: 8.5, salesTaxes: parseSalesTaxes(TAXES) });
    assert.equal(r.taxLabel, null);
    assert.equal(r.tax, 0);
    assert.equal(r.total, 1000);
});

test('tax rounds to the cent like the portal', () => {
    const r = computeEstimateDisplayTotals({ ...base, subtotal: 333.33, savedRate: 8.5 });
    assert.equal(r.tax, 28.33);
});

test('the shared function has no fee concept: total is subtotal + tax', () => {
    const r = computeEstimateDisplayTotals({ ...base, savedRate: 10 });
    assert.equal(r.total, 1100);
    assert.ok(!('processingFee' in r));
});

test('parseSalesTaxes tolerates empty and bad input', () => {
    assert.deepEqual(parseSalesTaxes(null), []);
    assert.deepEqual(parseSalesTaxes('not json'), []);
    assert.deepEqual(parseSalesTaxes('{"a":1}'), []);
    assert.deepEqual(parseSalesTaxes('{}'), []);
    assert.deepEqual(parseSalesTaxes('null'), []);
});

test('parseSalesTaxes drops unusable entries and keeps string rates', () => {
    assert.deepEqual(parseSalesTaxes('[null]'), []);
    assert.deepEqual(parseSalesTaxes('[{}]'), []);
    assert.deepEqual(parseSalesTaxes('[{"name":"X"}]'), []);
    assert.deepEqual(parseSalesTaxes('[{"name":"X","rate":null}]'), []);
    assert.deepEqual(parseSalesTaxes('[{"name":"X","rate":"abc"}]'), []);
    assert.deepEqual(parseSalesTaxes('[{"name":"X","rate":"9.1"}]'), [{ name: 'X', rate: '9.1' }]);
    assert.equal(parseSalesTaxes('[null,{"name":"A","rate":5}]').length, 1);
    const r = computeEstimateDisplayTotals({ ...base, salesTaxes: parseSalesTaxes('[{"name":"X","rate":"9.1"}]') });
    assert.equal(r.tax, 91, 'a string rate behaves as the portal accepts it today');
});

const squash = (s: string) => s.replace(/\s+/g, ' ');
async function text(buf: Buffer): Promise<string> {
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const res = await parser.getText();
    await parser.destroy();
    return res.text;
}

// shortEstimate: items 450 + 125 = 575 subtotal.
test('PDF with no saved tax rate uses the company default rate, like the portal (P1)', async () => {
    const est = { ...shortEstimate(), taxRatePercent: null, taxRateName: null };
    const t = await text(await buildEstimatePdf(est, { ...SAMPLE_COMPANY, salesTaxes: TAXES }));
    assert.ok(t.includes('Default City (9.25%)'));
    assert.ok(t.includes('$53.19'), 'tax = 575 * 9.25%');
    assert.ok(t.includes('$628.19'), 'total');
});

// Reviewer repro: subtotal 575, tax 8.5% = 48.88, fee 3% = 17.25, so Total 641.13 (the same figure the milestones sum to).
const feeEstimate = (hide: boolean) => ({
    ...shortEstimate(), processingFeeMarkup: 3, hideProcessingFee: hide,
    paymentSchedules: [{ name: 'Deposit', percentage: 50, amount: 320.57 }, { name: 'Final', percentage: 50, amount: 320.56 }],
});

test('PDF with a hidden processing fee: no fee row, but Total still includes the fee (matches the schedule)', async () => {
    const t = squash(await text(await buildEstimatePdf(feeEstimate(true), SAMPLE_COMPANY)));
    assert.ok(!/Processing/.test(t));
    assert.ok(t.includes('$575.00') && t.includes('$48.88'));
    assert.ok(t.includes('Total $641.13'), 'total = subtotal + tax + fee, fee row hidden');
    assert.ok(!t.includes('$623.88'));
});

test('PDF with the fee row shown: prints the fee and the same Total', async () => {
    const t = squash(await text(await buildEstimatePdf(feeEstimate(false), SAMPLE_COMPANY)));
    assert.ok(t.includes('Processing Fee (3%)'));
    assert.ok(t.includes('$17.25'));
    assert.ok(t.includes('Total $641.13'));
});

test("PREPARED FOR on a lead estimate uses the lead's client name, like the portal, not the lead name", async () => {
    const est = { ...shortEstimate(), project: null, lead: { name: 'LEADNAME-ZZ', location: '2 Sample Road', client: { name: 'Casey Clientperson', email: 'c@example.test' } } };
    const t = squash(await text(await buildEstimatePdf(est, SAMPLE_COMPANY)));
    const idx = t.indexOf('PREPARED FOR');
    assert.ok(idx >= 0 && t.slice(idx, idx + 80).includes('Casey Clientperson'));
});

test('PDF hides the automatic "Payment in Full" row, and the whole section when it is the only one (P4)', async () => {
    const only = { ...shortEstimate(), paymentSchedules: [{ name: 'Payment in Full', percentage: 100, amount: 623.88 }] };
    const t1 = await text(await buildEstimatePdf(only, SAMPLE_COMPANY));
    assert.ok(!t1.includes('Payment in Full'));
    assert.ok(!t1.includes('Payment Schedule'));
    const mixed = { ...shortEstimate(), paymentSchedules: [{ name: 'Payment in Full', amount: 1 }, { name: 'Deposit', percentage: 30, amount: 187 }] };
    const t2 = await text(await buildEstimatePdf(mixed, SAMPLE_COMPANY));
    assert.ok(!t2.includes('Payment in Full'));
    assert.ok(t2.includes('Payment Schedule') && t2.includes('Deposit'));
});

test('PDF and portal rule agree on flat, one-level and nested sections (sections are never double counted)', async () => {
    const mk = (items: Array<Record<string, unknown>>) => ({ ...shortEstimate(), taxRatePercent: 10, taxRateName: 'T', items: items as never });
    const flat = [{ id: 'a', name: 'A', quantity: 1, unitCost: 100, total: 100 }, { id: 'b', name: 'B', quantity: 1, unitCost: 50, total: 50 }];
    const oneLevel = [
        { id: 's', name: 'Sec', type: 'Section', total: 150 },
        { id: 'a', parentId: 's', name: 'A', quantity: 1, unitCost: 100, total: 100 },
        { id: 'b', parentId: 's', name: 'B', quantity: 1, unitCost: 50, total: 50 },
    ];
    const nested = [
        { id: 's', name: 'Sec', type: 'Section', total: 150 },
        { id: 'n', parentId: 's', name: 'Nested', type: 'Section', total: 150 },
        { id: 'a', parentId: 'n', name: 'A', quantity: 1, unitCost: 100, total: 100 },
        { id: 'b', parentId: 'n', name: 'B', quantity: 1, unitCost: 50, total: 50 },
    ];
    for (const items of [flat, oneLevel, nested]) {
        const t = await text(await buildEstimatePdf(mk(items), SAMPLE_COMPANY));
        assert.ok(t.includes('$150.00') && t.includes('$15.00') && t.includes('$165.00'), 'subtotal 150, tax 15, total 165');
    }
});
