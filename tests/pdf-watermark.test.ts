import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PDFParse } from "pdf-parse";

import {
    applyGoldenTouchWatermark,
    applyGoldenTouchWatermarkToPdfBytes,
} from "../src/lib/pdf";

async function extractText(pdfBytes: Buffer): Promise<string> {
    const parser = new PDFParse({ data: pdfBytes });
    try {
        return (await parser.getText()).text;
    } finally {
        await parser.destroy();
    }
}

test("applies the Golden Touch Remodeling watermark to every PDF page", async () => {
    const document = await PDFDocument.create();
    document.addPage([612, 792]);
    document.addPage([612, 792]);

    const stampedPages = await applyGoldenTouchWatermark(document);
    const extractedText = await extractText(Buffer.from(await document.save()));
    const watermarkCount = extractedText.split("GOLDEN TOUCH REMODELING").length - 1;

    assert.equal(stampedPages, 2);
    assert.equal(watermarkCount, 2, "each page must contain the Golden Touch Remodeling watermark");
});

test("stamps a pre-captured PDF without dropping its existing contents", async () => {
    const original = await PDFDocument.create();
    const page = original.addPage([612, 792]);
    const font = await original.embedFont(StandardFonts.Helvetica);
    page.drawText("SIGNED ESTIMATE #1001", { x: 72, y: 700, size: 18, font });

    const stampedPdf = await applyGoldenTouchWatermarkToPdfBytes(Buffer.from(await original.save()));
    const extractedText = await extractText(stampedPdf);

    assert.match(extractedText, /SIGNED ESTIMATE #1001/);
    assert.match(extractedText, /GOLDEN TOUCH REMODELING/);
});
