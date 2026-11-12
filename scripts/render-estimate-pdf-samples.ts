// Writes sample fallback estimate PDFs (and page-1 PNGs when a renderer is available) to .pdf-samples/.
// Run: npx tsx scripts/render-estimate-pdf-samples.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEstimatePdf } from '../src/lib/pdf';
import { SAMPLE_COMPANY, shortEstimate, longEstimate, signedEstimate, sampleSignatureDataUrl } from '../tests/estimate-pdf-fixtures';

async function main() {
    const dir = join(process.cwd(), '.pdf-samples');
    mkdirSync(dir, { recursive: true });
    const outputs: Array<[string, Buffer]> = [
        ['fallback-short', await buildEstimatePdf(shortEstimate(), SAMPLE_COMPANY)],
        ['fallback-long', await buildEstimatePdf(longEstimate(), SAMPLE_COMPANY)],
        ['fallback-signed', await buildEstimatePdf(signedEstimate(), SAMPLE_COMPANY)],
        // A phone signature (1500x600 px), the accepted terms, and the real post-signing status.
        ['fallback-signed-phone', await buildEstimatePdf({
            ...shortEstimate(),
            status: 'Invoiced',
            approvedBy: 'Pat Sample',
            approvedAt: new Date('2026-11-06T05:30:00Z'),
            approvalIp: '203.0.113.9',
            signatureUrl: sampleSignatureDataUrl(1500, 600),
            paymentSchedules: [{ name: 'Deposit', percentage: 30, amount: 187.16 }, { name: 'Final payment', percentage: 70, amount: 436.72 }],
            termsAndConditions: '<h2>Terms &amp; Conditions</h2><p>Payment is due within 14 days of each milestone.</p><ul><li>Change orders need written approval.</li><li>Hidden conditions may change the price.</li></ul>',
        }, SAMPLE_COMPANY, {}, { timeZone: 'America/Los_Angeles' })],
    ];
    for (const [name, buf] of outputs) {
        writeFileSync(join(dir, `${name}.pdf`), buf);
        console.log(`wrote ${join(dir, `${name}.pdf`)}`);
    }
    try {
        const { PDFParse } = await import('pdf-parse');
        for (const [name, buf] of outputs) {
            const parser = new PDFParse({ data: new Uint8Array(buf) });
            const info = await parser.getInfo();
            const total = (info as { total?: number }).total ?? 1;
            // The signed sample is checked page by page; the others only need page 1.
            const wanted = name === 'fallback-signed-phone' ? Array.from({ length: total }, (_, i) => i + 1) : [1];
            const shot = await parser.getScreenshot({ partial: wanted, scale: 1.5 });
            await parser.destroy();
            shot.pages.forEach((pg, i) => {
                const file = wanted.length === 1 ? `${name}.png` : `${name}-p${wanted[i]}.png`;
                writeFileSync(join(dir, file), pg.data);
                console.log(`wrote ${join(dir, file)}`);
            });
        }
    } catch (err) {
        console.log('PNG render skipped:', (err as Error).message);
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
