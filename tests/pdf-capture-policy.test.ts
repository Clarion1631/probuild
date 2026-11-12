import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseServerPdf, PDF_CAPTURE_MIN_WIDTH_PX } from '../src/lib/pdf-capture-policy';

test('shouldUseServerPdf: narrow (phone) widths use the server PDF, wide and unknown widths keep the screenshot', () => {
    assert.equal(PDF_CAPTURE_MIN_WIDTH_PX, 794);
    assert.equal(shouldUseServerPdf(0), false);
    assert.equal(shouldUseServerPdf(1), true);
    assert.equal(shouldUseServerPdf(360), true);
    assert.equal(shouldUseServerPdf(793), true);
    assert.equal(shouldUseServerPdf(794), false);
    assert.equal(shouldUseServerPdf(960), false);
    assert.equal(shouldUseServerPdf(NaN), false);
    assert.equal(shouldUseServerPdf(-5), false);
    assert.equal(shouldUseServerPdf(Infinity), false);
});
