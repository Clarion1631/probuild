// Writes sample invoice and change order PDFs (and a PNG per page when a renderer is available) to .pdf-samples/.
// Run: npx tsx scripts/render-invoice-co-pdf-samples.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInvoicePdf, buildChangeOrderPdf } from '../src/lib/pdf';
import * as fx from '../tests/invoice-co-pdf-fixtures';
import { SAMPLE_COMPANY, SAMPLE_COMPANY_WITH_LOGO, sampleSignatureDataUrl, sampleLogoBytes } from '../tests/invoice-co-pdf-fixtures';

async function main() {
    const dir = join(process.cwd(), '.pdf-samples');
    mkdirSync(dir, { recursive: true });
    const o = { timeZone: fx.LA, now: fx.FIXED_NOW };
    const sig = { clientSignatureUrl: sampleSignatureDataUrl(1500, 600), companySignatureUrl: sampleSignatureDataUrl() };
    const outputs: Array<[string, Buffer, boolean]> = [];
    const inv = async (name: string, d: Parameters<typeof buildInvoicePdf>[0], extra: Parameters<typeof buildInvoicePdf>[2] = {}, company: Record<string, unknown> = SAMPLE_COMPANY) => {
        const audit = { lossy: false };
        outputs.push([name, await buildInvoicePdf(d, company, { ...o, ...extra, audit }), audit.lossy]);
    };
    // The change order page always shows a logo, so its samples use a company with one (bytes supplied, never fetched).
    const co = async (name: string, d: Parameters<typeof buildChangeOrderPdf>[0], company: Record<string, unknown> = SAMPLE_COMPANY_WITH_LOGO) => {
        const audit = { lossy: false };
        outputs.push([name, await buildChangeOrderPdf(d, company, { ...o, audit, logoBytes: sampleLogoBytes() }), audit.lossy]);
    };
    await inv('invoice-short', fx.shortInvoice());
    await inv('invoice-due', fx.dueInvoice());
    await inv('invoice-focus', fx.dueInvoice(), { requestedMilestoneIds: ['p2', 'p3'], omitFocusedTotal: true });
    await inv('invoice-logo', fx.dueInvoice(), { logoBytes: sampleLogoBytes() }, SAMPLE_COMPANY_WITH_LOGO);
    await inv('invoice-all-paid', fx.allPaidInvoice());
    await inv('invoice-long', fx.longInvoice());
    await co('co-fixed-signed', { ...fx.fixedSignedCo(), ...sig });
    await co('co-cost-plus', fx.costPlusCo());
    await co('co-credit', fx.creditCo());
    await co('co-offline', fx.offlineCo());
    await co('co-long', fx.longCo());
    await co('co-drift', fx.driftCo());
    await co('co-empty', fx.emptyCo());
    await co('co-qty-1250', { ...fx.qtyCo(1250), items: [4, 999, 1000, 1250, 12.75].map(q => ({ type: 'Material', name: `Cabinet screws, qty ${q}`, quantity: q, unitCost: 10, total: Math.round(q * 1000) / 100 })), totalAmount: [4, 999, 1000, 1250, 12.75].reduce((a, q) => a + Math.round(q * 1000) / 100, 0) });
    for (const [name, buf, lossy] of outputs) {
        writeFileSync(join(dir, `${name}.pdf`), buf);
        console.log(`wrote ${join(dir, `${name}.pdf`)} (lossy=${lossy})`);
    }
    try {
        const { PDFParse } = await import('pdf-parse');
        for (const [name, buf] of outputs) {
            const parser = new PDFParse({ data: new Uint8Array(buf) });
            const info = await parser.getInfo();
            const total = (info as { total?: number }).total ?? 1;
            const wanted = Array.from({ length: Math.min(total, 6) }, (_, i) => i + 1);
            const shot = await parser.getScreenshot({ partial: wanted, scale: 1.5 });
            await parser.destroy();
            shot.pages.forEach((pg, i) => {
                const file = `${name}-p${wanted[i]}.png`;
                writeFileSync(join(dir, file), pg.data);
                console.log(`wrote ${join(dir, file)}`);
            });
        }
    } catch (err) {
        console.log('PNG render skipped:', (err as Error).message);
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
