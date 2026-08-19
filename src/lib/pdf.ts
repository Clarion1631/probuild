import { PDFDocument, PDFPage, PDFFont, PDFImage, rgb, StandardFonts } from 'pdf-lib';
import { prisma } from './prisma';
import { toNum } from './prisma-helpers';
import { buildLetterheadConfig, type LetterheadConfig } from './letterhead';
import { isOwnSignatureStorageUrl } from './signature-storage';
import { isSecureRef, downloadDocBytes } from './secure-storage';
import { coTaxRate, coTaxLabel, billableCoItems } from './co-tax';
import { drawRichHtml, drawWrappedText, measureWrappedLines, type RichTextCtx } from './pdf-richtext';
import { isEstimateSectionRow, rm } from './estimate-item-payload';

/** pdf-lib only supports PNG/JPG; SignaturePad always emits PNG, so a failed PNG embed
 *  falls through to a JPG attempt (no content-type header is available once bytes come
 *  from downloadDocBytes rather than a fetch() Response). */
async function embedImageBytes(doc: PDFDocument, bytes: Uint8Array): Promise<PDFImage> {
    try {
        return await doc.embedPng(bytes);
    } catch {
        return await doc.embedJpg(bytes);
    }
}

/**
 * Embed a signature image from a legacy inline data-URL, a secure ref (private bucket),
 * or a migrated http(s) Storage URL. Returns the embedded image, or null if it can't be
 * loaded/decoded.
 */
async function embedSignatureImage(doc: PDFDocument, value: string): Promise<PDFImage | null> {
    try {
        const dataUrlMatch = value.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
        if (dataUrlMatch) {
            const bytes = Buffer.from(dataUrlMatch[2], 'base64');
            return /^jpe?g$/i.test(dataUrlMatch[1]) ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
        }
        if (isSecureRef(value)) {
            const bytes = await downloadDocBytes(value);
            return bytes ? await embedImageBytes(doc, bytes) : null;
        }
        if (/^https?:\/\//i.test(value)) {
            // SSRF guard: only fetch URLs that point at our own Supabase Storage signatures
            // dir. A DB-stored signature column must never be able to aim the server at an
            // arbitrary host (e.g. cloud metadata). Anything else is treated as no image.
            if (!isOwnSignatureStorageUrl(value)) return null;
            const bytes = await downloadDocBytes(value);
            return bytes ? await embedImageBytes(doc, bytes) : null;
        }
        return null;
    } catch (err) {
        console.warn('Could not embed signature image in PDF:', err);
        return null;
    }
}

/**
 * Append a "Certificate of Execution" page to an existing (client-signed) contract PDF,
 * recording the company countersignature alongside the client's. Returns the new PDF as a Buffer.
 *
 * The customer's browser already produced a PDF with the document body + their signature
 * (the client-signed intermediate). At countersign time we load that PDF, stamp a final
 * certificate page carrying both parties' attribution + audit metadata, and re-save — so the
 * executed copy is a single PDF with both signatures. No headless browser required.
 */
export async function appendContractCountersignaturePage(
    existingPdf: Uint8Array | Buffer,
    opts: {
        companyName: string;
        contractTitle: string;
        clientSignedBy?: string | null;
        clientSignedAt?: Date | null;
        clientIp?: string | null;
        clientSignatureValue?: string | null; // data-URL or Storage URL
        companySignedBy?: string | null;
        companySignedAt?: Date | null;
        companyIp?: string | null;
        companySignatureValue?: string | null; // data-URL or Storage URL
    }
): Promise<Buffer> {
    const doc = await PDFDocument.load(existingPdf);
    const helv = await doc.embedFont(StandardFonts.Helvetica);
    const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);

    const page = doc.addPage([612, 792]); // US Letter
    const { width, height } = page.getSize();
    const margin = 56;
    const ink = rgb(0.06, 0.09, 0.16);
    const muted = rgb(0.42, 0.45, 0.5);
    const accent = rgb(0.31, 0.27, 0.9);
    let y = height - margin;

    page.drawText('Certificate of Execution', { x: margin, y, size: 20, font: helvBold, color: ink });
    y -= 24;
    page.drawText((opts.contractTitle || '').slice(0, 90), { x: margin, y, size: 11, font: helv, color: muted, maxWidth: width - margin * 2 });
    y -= 14;
    page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: 1, color: accent });
    y -= 36;

    const drawParty = (heading: string, name: string, when?: Date | null, ip?: string | null, img?: PDFImage | null) => {
        page.drawText(heading, { x: margin, y, size: 9, font: helvBold, color: muted });
        y -= 17;
        page.drawText((name || '—').slice(0, 70), { x: margin, y, size: 13, font: helvBold, color: ink, maxWidth: width - margin * 2 });
        y -= 16;
        if (when) { page.drawText(`Signed: ${when.toLocaleString()}`, { x: margin, y, size: 9, font: helv, color: muted }); y -= 13; }
        if (ip) { page.drawText(`IP address: ${ip}`, { x: margin, y, size: 9, font: helv, color: muted }); y -= 13; }
        if (img) {
            const maxW = 180, maxH = 56;
            const scale = Math.min(maxW / img.width, maxH / img.height, 1);
            const w = img.width * scale, h = img.height * scale;
            page.drawImage(img, { x: margin, y: y - h - 4, width: w, height: h });
            y -= h + 10;
        }
        y -= 22;
    };

    const clientImg = opts.clientSignatureValue ? await embedSignatureImage(doc, opts.clientSignatureValue) : null;
    drawParty('CLIENT', opts.clientSignedBy || '', opts.clientSignedAt, opts.clientIp, clientImg);
    
    if (opts.companySignedBy) {
        const companyImg = opts.companySignatureValue ? await embedSignatureImage(doc, opts.companySignatureValue) : null;
        drawParty(`COMPANY — ${opts.companyName}`, opts.companySignedBy, opts.companySignedAt, opts.companyIp, companyImg);
    }

    page.drawText(
        'This certificate records the electronic signatures applied to this document under the U.S. ESIGN Act (15 U.S.C. § 7001) and UETA.',
        { x: margin, y: margin, size: 8, font: helv, color: muted, maxWidth: width - margin * 2, lineHeight: 11 }
    );

    return Buffer.from(await doc.save());
}

// Color helpers
const colors = {
    primary: rgb(79 / 255, 70 / 255, 229 / 255),     // indigo-600
    textMain: rgb(15 / 255, 23 / 255, 42 / 255),      // slate-900
    textMuted: rgb(100 / 255, 116 / 255, 139 / 255),   // slate-500
    border: rgb(226 / 255, 232 / 255, 240 / 255),      // slate-200
    bgLight: rgb(248 / 255, 250 / 255, 252 / 255),     // slate-50
    white: rgb(1, 1, 1),
};

function hexToRgb(hex: string) {
    const h = hex.replace('#', '');
    const r = parseInt(h.substring(0, 2), 16) / 255;
    const g = parseInt(h.substring(2, 4), 16) / 255;
    const b = parseInt(h.substring(4, 6), 16) / 255;
    return rgb(r, g, b);
}

function formatCurrency(amount: number): string {
    const n = Number(amount);
    const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // Sign before the dollar sign: -$4,629.63, not $-4,629.63.
    return n < 0 ? `-$${abs}` : `$${abs}`;
}

/** Word-wrap plain (non-HTML) text to maxWidth, collapsing any run of blank lines to a single one
 *  (whitespace-only lines count as blank for this rule), trimming leading/trailing blank lines,
 *  and hard-breaking any single word wider than maxWidth by character. Used for table cells and
 *  the letterhead, which need the wrapped lines themselves (for manual per-line column alignment)
 *  rather than pdf-richtext's flow-and-paginate drawWrappedText/measureWrappedLines. */
function wrapPlainText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const normalized = (text ?? '').replace(/\r\n/g, '\n');
    const lines: string[] = [];
    for (const rawLine of normalized.split('\n')) {
        if (rawLine.trim() === '') { lines.push(''); continue; }
        const words = rawLine.split(/\s+/).filter(Boolean);
        let current = '';
        for (const word of words) {
            if (font.widthOfTextAtSize(word, size) > maxWidth) {
                if (current) { lines.push(current); current = ''; }
                let chunk = '';
                for (const ch of word) {
                    if (chunk && font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
                        lines.push(chunk);
                        chunk = ch;
                    } else {
                        chunk += ch;
                    }
                }
                current = chunk;
                continue;
            }
            const candidate = current ? `${current} ${word}` : word;
            if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
                lines.push(current);
                current = word;
            } else {
                current = candidate;
            }
        }
        lines.push(current);
    }

    // Collapse any run of blank lines to a single blank line.
    const collapsed: string[] = [];
    let blankRun = 0;
    for (const line of lines) {
        if (line === '') {
            blankRun++;
            if (blankRun <= 1) collapsed.push(line);
        } else {
            blankRun = 0;
            collapsed.push(line);
        }
    }

    // Trim leading/trailing blank lines.
    let start = 0;
    let end = collapsed.length;
    while (start < end && collapsed[start] === '') start++;
    while (end > start && collapsed[end - 1] === '') end--;
    return collapsed.slice(start, end);
}

async function drawLetterhead(
    doc: PDFDocument,
    page: PDFPage,
    config: LetterheadConfig,
    opts: { pageWidth: number; pageHeight: number; margin: number },
    fonts: { regular: PDFFont; bold: PDFFont },
): Promise<number> {
    const { pageWidth, pageHeight, margin } = opts;
    let y: number;

    if (config.mode === 'custom_image' && config.customImageUrl) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);
            let res: Response;
            try {
                res = await fetch(config.customImageUrl, { signal: controller.signal });
            } finally {
                clearTimeout(timeoutId);
            }
            const buf = new Uint8Array(await res.arrayBuffer());
            const contentType = res.headers.get('content-type') || '';
            const img = contentType.includes('png')
                ? await doc.embedPng(buf)
                : await doc.embedJpg(buf);
            const scale = pageWidth / img.width;
            const imgHeight = Math.min(img.height * scale, 150);
            page.drawImage(img, { x: 0, y: pageHeight - imgHeight, width: pageWidth, height: imgHeight });
            y = pageHeight - imgHeight - 20;
        } catch {
            // Fall back to built-in if image fetch fails
            return drawBuiltInHeader(page, config, opts, fonts);
        }
        return y;
    }

    return drawBuiltInHeader(page, config, opts, fonts);
}

function drawBuiltInHeader(
    page: PDFPage,
    config: LetterheadConfig,
    opts: { pageWidth: number; pageHeight: number; margin: number },
    fonts: { regular: PDFFont; bold: PDFFont },
): number {
    const { pageWidth, pageHeight, margin } = opts;
    const contentWidth = pageWidth - margin * 2;
    let y: number;

    if (config.showDivider) {
        const barColor = hexToRgb(config.accentColor);
        page.drawRectangle({ x: 0, y: pageHeight - 6, width: pageWidth, height: 6, color: barColor });
    }
    y = pageHeight - 40;

    const fieldValues: string[] = [];
    for (const f of config.fields) {
        let v: string | null = null;
        switch (f) {
            case 'name': v = config.companyName; break;
            case 'address': v = config.address; break;
            case 'phone': v = config.phone; break;
            case 'email': v = config.email; break;
            case 'license': v = config.licenseNumber ? `Lic# ${config.licenseNumber}` : null; break;
            case 'website': v = config.website; break;
        }
        if (v) fieldValues.push(v);
    }

    // The header can never be allowed to consume the whole page — stop drawing further
    // lines once y would cross margin + 250, leaving room for each document's intro
    // block and first table header, whose draws run unguarded until the first row.
    outer:
    for (let i = 0; i < fieldValues.length; i++) {
        const size = i === 0 ? 11 : 9;
        const value = i === 0 ? fieldValues[i].toUpperCase() : fieldValues[i];
        for (const line of wrapPlainText(value, fonts.regular, size, contentWidth)) {
            if (y < margin + 250) break outer;
            page.drawText(line, { x: margin, y, size, font: fonts.regular, color: colors.textMuted });
            y -= 14;
        }
    }

    y -= 6;
    return y;
}

export async function generateEstimatePdf(estimateId: string): Promise<Buffer> {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: {
            items: { orderBy: { order: 'asc' } },
            paymentSchedules: { orderBy: { order: 'asc' } },
            project: {
                include: { client: true },
            },
            lead: {
                include: { client: true },
            },
        },
    });

    if (!estimate) throw new Error('Estimate not found');

    const company = await prisma.companySettings.findUnique({ where: { id: 'singleton' } });

    const doc = await PDFDocument.create();
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);
    const helveticaOblique = await doc.embedFont(StandardFonts.HelveticaOblique);
    const helveticaBoldOblique = await doc.embedFont(StandardFonts.HelveticaBoldOblique);

    const pageWidth = 612; // Letter width in points
    const pageHeight = 792; // Letter height in points
    const margin = 50;
    const contentWidth = pageWidth - margin * 2;

    let page = doc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    function checkNewPage(needed: number = 80) {
        if (y < needed) {
            page = doc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
        }
    }

    // Render a titled rich-text section (Project Overview / Notes & Assumptions) using
    // the shared HTML-subset renderer, keeping the closure's page/y cursor in sync.
    const richFonts = { regular: helvetica, bold: helveticaBold, italic: helveticaOblique, boldItalic: helveticaBoldOblique };
    function drawRichSection(title: string, body: string, titleSize: number) {
        checkNewPage(140);
        page.drawText(title, { x: margin, y, size: titleSize, font: helveticaBold, color: colors.textMain });
        y -= titleSize + 10;
        const ctx: RichTextCtx = {
            doc, page, y, fonts: richFonts,
            layout: { pageWidth, pageHeight, margin, contentWidth },
            color: colors.textMain, mutedColor: colors.textMuted,
        };
        const res = drawRichHtml(body, ctx);
        page = res.page;
        y = res.y;
    }

    // --- Letterhead ---
    const lhConfig = buildLetterheadConfig(company);
    y = await drawLetterhead(doc, page, lhConfig, { pageWidth, pageHeight, margin }, { regular: helvetica, bold: helveticaBold });

    // --- Title ---
    page.drawText(estimate.title || 'Estimate', {
        x: margin, y, size: 26, font: helveticaBold, color: colors.textMain,
    });

    // --- Estimate Info ---
    y -= 30;

    // Left: Client info
    const clientName = estimate.project?.client?.name || estimate.lead?.name || '';
    const clientEmail = estimate.project?.client?.email || estimate.lead?.client?.email || '';

    page.drawText('ESTIMATE TO', {
        x: margin, y, size: 9, font: helveticaBold, color: colors.textMuted,
    });

    if (clientName) {
        y -= 16;
        page.drawText(clientName, {
            x: margin, y, size: 11, font: helvetica, color: colors.textMain,
        });
    }
    if (clientEmail) {
        y -= 14;
        page.drawText(clientEmail, {
            x: margin, y, size: 9, font: helvetica, color: colors.textMuted,
        });
    }

    // Right side: Estimate # / Date / Status
    const rightX = pageWidth - margin;
    let ry = y + (clientEmail ? 30 : 16);

    const drawRightLabel = (label: string, value: string, yPos: number) => {
        page.drawText(label, {
            x: rightX - 160, y: yPos, size: 9, font: helvetica, color: colors.textMuted,
        });
        const valueWidth = helveticaBold.widthOfTextAtSize(value, 9);
        page.drawText(value, {
            x: rightX - valueWidth, y: yPos, size: 9, font: helveticaBold, color: colors.textMain,
        });
    };

    drawRightLabel('Estimate No.', estimate.code || '', ry);
    ry -= 16;
    drawRightLabel('Date', new Date(estimate.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }), ry);
    ry -= 16;
    drawRightLabel('Status', estimate.status || 'Draft', ry);

    // --- Separator ---
    y -= 20;
    page.drawLine({
        start: { x: margin, y }, end: { x: pageWidth - margin, y },
        thickness: 0.5, color: colors.border,
    });
    y -= 20;

    // --- Project Overview / Vision (client-facing, no pricing) ---
    // Rendered after the header/client block, then the estimate details are forced
    // onto a fresh page so pricing begins on the following page.
    if (estimate.overviewEnabled && estimate.overviewBody) {
        drawRichSection(estimate.overviewTitle || 'Project Overview', estimate.overviewBody, 15);
        page = doc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
    }

    // --- Estimate Notes & Assumptions (placed before the line items) ---
    if (estimate.notesEnabled && estimate.notesBody && estimate.notesPlacement === 'before') {
        drawRichSection(estimate.notesTitle || 'Estimate Notes & Assumptions', estimate.notesBody, 12);
        y -= 12;
    }

    // --- Table Header ---
    const cols = {
        name: margin,
        qty: margin + contentWidth * 0.55,
        unitCost: margin + contentWidth * 0.75,
        total: pageWidth - margin,
    };

    function drawTableHeader() {
        page.drawText('ITEM DESCRIPTION', {
            x: cols.name, y, size: 8, font: helveticaBold, color: colors.textMuted,
        });
        const qtyLabel = 'QTY';
        const qtyWidth = helveticaBold.widthOfTextAtSize(qtyLabel, 8);
        page.drawText(qtyLabel, {
            x: cols.qty - qtyWidth, y, size: 8, font: helveticaBold, color: colors.textMuted,
        });
        const ucLabel = 'UNIT COST';
        const ucWidth = helveticaBold.widthOfTextAtSize(ucLabel, 8);
        page.drawText(ucLabel, {
            x: cols.unitCost - ucWidth, y, size: 8, font: helveticaBold, color: colors.textMuted,
        });
        const totalLabel = 'TOTAL';
        const totalWidth = helveticaBold.widthOfTextAtSize(totalLabel, 8);
        page.drawText(totalLabel, {
            x: cols.total - totalWidth, y, size: 8, font: helveticaBold, color: colors.textMuted,
        });

        y -= 8;
        page.drawLine({
            start: { x: margin, y }, end: { x: pageWidth - margin, y },
            thickness: 0.5, color: colors.border,
        });
        y -= 14;
    }

    // Guard against a before-placement Notes section leaving no room: keep the table
    // header with at least the first row instead of stranding it at the page bottom.
    checkNewPage(120);
    drawTableHeader();

    // --- Table Rows ---
    const rowLeading = 12;
    for (const item of estimate.items) {
        // Shared with serializeEstimateItemsForSave: a row is a section if it is typed as one
        // or has children. Keying off children alone rendered an emptied section (and any
        // nested section) as a billable line with qty/unit-cost columns, even though its
        // stored total is a rolled-up figure that does not equal qty * unitCost.
        const isSection = isEstimateSectionRow(item, estimate.items);
        const isSubItem = !!item.parentId;
        const nameX = isSubItem ? cols.name + 16 : cols.name;
        const nameFont = isSection || !isSubItem ? helveticaBold : helvetica;

        // Wrap the name/description to the column width instead of truncating it.
        const displayName = item.name || '';
        const maxNameWidth = contentWidth * 0.5;
        const wrappedName = wrapPlainText(displayName, nameFont, 10, maxNameWidth);
        const lineCount = Math.max(wrappedName.length, 1);
        const rowHeight = lineCount * rowLeading + 8;

        // Page-break BEFORE the row if the whole (possibly multi-line) row doesn't fit,
        // re-drawing the table header on the new page.
        if (y - rowHeight < margin) {
            page = doc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
            drawTableHeader();
        }

        if (isSection) {
            // Draw a subtle slate background banner for the section header, sized to
            // the (possibly multi-line) row height.
            page.drawRectangle({
                x: margin - 6,
                y: y - rowHeight + 16,
                width: contentWidth + 12,
                height: rowHeight - 2,
                color: colors.bgLight,
            });
        }

        wrappedName.forEach((line, idx) => {
            page.drawText(line, {
                x: nameX, y: y - idx * rowLeading, size: 10, font: nameFont, color: colors.textMain,
            });
        });

        if (!isSection) {
            // Qty — aligned with the first line of the wrapped name
            const qtyStr = String(item.quantity || 0);
            const qtyWidth = helvetica.widthOfTextAtSize(qtyStr, 10);
            page.drawText(qtyStr, {
                x: cols.qty - qtyWidth, y, size: 10, font: helvetica, color: colors.textMuted,
            });

            // Unit cost — aligned with the first line of the wrapped name
            const ucStr = formatCurrency(toNum(item.unitCost));
            const ucWidth = helvetica.widthOfTextAtSize(ucStr, 10);
            page.drawText(ucStr, {
                x: cols.unitCost - ucWidth, y, size: 10, font: helvetica, color: colors.textMuted,
            });
        }

        // Total — aligned with the first line of the wrapped name
        const totalStr = formatCurrency(toNum(item.total));
        const totalWidth = helveticaBold.widthOfTextAtSize(totalStr, 10);
        page.drawText(totalStr, {
            x: cols.total - totalWidth, y, size: 10, font: helveticaBold, color: isSection ? colors.primary : colors.textMain,
        });

        y -= rowHeight;
    }

    // --- Totals Section ---
    y -= 10;
    // 135 (not 120): the Total row below draws at y-8, and with Subtotal/Tax/Fee all
    // shown that chain can eat 74pt — keep the offset Total-row draw comfortably clear
    // of the footer rather than relying on the footer's own guard.
    checkNewPage(135);
    page.drawLine({
        start: { x: margin + contentWidth * 0.5, y },
        end: { x: pageWidth - margin, y },
        thickness: 0.5, color: colors.border,
    });
    y -= 20;

    // Leaf rows only, using the same predicate as the rows above. Keying off `parentId`
    // added a nested section's rolled-up total on top of the child totals it already
    // contains, inflating the subtotal (and therefore tax and the grand total).
    // `rm` on the accumulated sum matches computeEstimateSubtotal: without it the raw float
    // sum can land a hair under the canonical figure and drag tax, the processing fee and
    // the grand total a cent below what the editor showed.
    const subtotal = rm(
        estimate.items.reduce(
            (acc, item) => (isEstimateSectionRow(item, estimate.items) ? acc : acc + toNum(item.total)),
            0,
        ),
    );

    const taxRatePercent = toNum(estimate.taxRatePercent);
    const taxExempt = !!estimate.taxExempt;
    const taxRate = taxExempt ? 0 : taxRatePercent / 100;
    const tax = Math.round(subtotal * taxRate * 100) / 100;

    const taxRateDisplay = Number(taxRatePercent.toFixed(4));
    const taxName = taxExempt
        ? "Tax Exempt"
        : (estimate.taxRateName ? `${estimate.taxRateName} (${taxRateDisplay}%)` : `Estimated Tax (${taxRateDisplay}%)`);

    const processingFeeMarkup = toNum(estimate.processingFeeMarkup);
    const hideProcessingFee = estimate.hideProcessingFee ?? true;
    const processingFee = processingFeeMarkup > 0 ? Math.round(subtotal * (processingFeeMarkup / 100) * 100) / 100 : 0;

    const total = Math.round((subtotal + tax + processingFee) * 100) / 100;

    // Subtotal
    const labelX = cols.unitCost - 60;
    page.drawText('Subtotal', {
        x: labelX, y, size: 10, font: helvetica, color: colors.textMuted,
    });
    const subtotalStr = formatCurrency(subtotal);
    const subtotalWidth = helvetica.widthOfTextAtSize(subtotalStr, 10);
    page.drawText(subtotalStr, {
        x: cols.total - subtotalWidth, y, size: 10, font: helvetica, color: colors.textMain,
    });
    y -= 18;

    // Tax
    page.drawText(taxName, {
        x: labelX, y, size: 10, font: helvetica, color: colors.textMuted,
    });
    const taxStr = formatCurrency(tax);
    const taxWidth = helvetica.widthOfTextAtSize(taxStr, 10);
    page.drawText(taxStr, {
        x: cols.total - taxWidth, y, size: 10, font: helvetica, color: colors.textMain,
    });
    y -= 18;

    // Processing Fee (only if not hidden)
    if (!hideProcessingFee && processingFee > 0) {
        page.drawText(`Processing Fee (${processingFeeMarkup}%)`, {
            x: labelX, y, size: 10, font: helvetica, color: colors.textMuted,
        });
        const feeStr = formatCurrency(processingFee);
        const feeWidth = helvetica.widthOfTextAtSize(feeStr, 10);
        page.drawText(feeStr, {
            x: cols.total - feeWidth, y, size: 10, font: helvetica, color: colors.textMain,
        });
        y -= 18;
    }

    // Total line
    page.drawLine({
        start: { x: labelX - 10, y: y + 6 },
        end: { x: pageWidth - margin, y: y + 6 },
        thickness: 0.5, color: colors.border,
    });

    page.drawText('Total', {
        x: labelX, y: y - 8, size: 14, font: helveticaBold, color: colors.primary,
    });
    const totalStr2 = formatCurrency(total);
    const totalWidth2 = helveticaBold.widthOfTextAtSize(totalStr2, 14);
    page.drawText(totalStr2, {
        x: cols.total - totalWidth2, y: y - 8, size: 14, font: helveticaBold, color: colors.primary,
    });

    // --- Estimate Notes & Assumptions (placed immediately after the line items/totals) ---
    if (estimate.notesEnabled && estimate.notesBody && estimate.notesPlacement !== 'before') {
        y -= 30;
        drawRichSection(estimate.notesTitle || 'Estimate Notes & Assumptions', estimate.notesBody, 12);
    }

    // --- Payment Schedule ---
    if (estimate.paymentSchedules.length > 0) {
        y -= 50;
        checkNewPage(120);

        page.drawText('Payment Schedule', {
            x: margin, y, size: 11, font: helveticaBold, color: colors.textMain,
        });
        y -= 20;

        for (const sched of estimate.paymentSchedules) {
            checkNewPage(60);

            page.drawText(sched.name || '', {
                x: margin, y, size: 9, font: helveticaBold, color: colors.textMain,
            });

            const schedInfo: string[] = [];
            if (sched.percentage) schedInfo.push(`${sched.percentage}%`);
            if (sched.amount) schedInfo.push(formatCurrency(toNum(sched.amount)));
            const schedText = schedInfo.join('  ');

            page.drawText(schedText, {
                x: margin + contentWidth * 0.5, y, size: 9, font: helvetica, color: colors.textMuted,
            });

            if (sched.dueDate) {
                const dateStr = new Date(sched.dueDate).toLocaleDateString();
                const dateWidth = helvetica.widthOfTextAtSize(dateStr, 9);
                page.drawText(dateStr, {
                    x: cols.total - dateWidth, y, size: 9, font: helvetica, color: colors.textMuted,
                });
            }
            y -= 18;
        }
    }

    // --- Signature Section ---
    if (estimate.status === 'Approved' && estimate.approvedBy) {
        y -= 60;
        checkNewPage(150);

        page.drawText('Electronic Signature / Approval', {
            x: margin, y, size: 11, font: helveticaBold, color: colors.textMain,
        });

        y -= 20;
        page.drawLine({
            start: { x: margin, y }, end: { x: pageWidth - margin, y },
            thickness: 0.5, color: colors.border,
        });

        y -= 25;
        // Signature metadata
        page.drawText(`Signed By:  ${estimate.approvedBy}`, {
            x: margin, y, size: 10, font: helveticaBold, color: colors.textMain,
        });
        y -= 15;
        page.drawText(`Date:          ${estimate.approvedAt ? new Date(estimate.approvedAt).toLocaleString() : new Date().toLocaleString()}`, {
            x: margin, y, size: 10, font: helvetica, color: colors.textMain,
        });
        if (estimate.approvalIp) {
            y -= 15;
            page.drawText(`IP Address:  ${estimate.approvalIp}`, {
                x: margin, y, size: 9, font: helvetica, color: colors.textMuted,
            });
        }

        // Signature Image — handles legacy inline data-URLs and migrated Storage URLs.
        if (estimate.signatureUrl) {
            const embeddedSig = await embedSignatureImage(doc, estimate.signatureUrl);
            if (embeddedSig) {
                // Scale signature down so it fits nicely
                const sigDims = embeddedSig.scale(0.35);
                page.drawImage(embeddedSig, {
                    x: pageWidth - margin - sigDims.width,
                    y: y, // draw next to metadata
                    width: sigDims.width,
                    height: sigDims.height,
                });
            }
        }
        
        y -= 40;
    }

    // --- Footer ---
    // No pre-footer page-break guard here: every content path above already page-breaks
    // (or is bounded, see the checkNewPage(135) totals guard) well clear of the footer's
    // y=30, so this can't collide — and a guard here would emit a footer-only blank page.
    const footerY = 30;
    const footerText = `Generated ${new Date().toLocaleDateString()} • ${company?.companyName || 'ProBuild'}`;
    page.drawText(footerText, {
        x: margin, y: footerY, size: 7, font: helvetica, color: colors.textMuted,
    });
    const pageLabel = 'Page 1';
    const pageLabelWidth = helvetica.widthOfTextAtSize(pageLabel, 7);
    page.drawText(pageLabel, {
        x: pageWidth - margin - pageLabelWidth, y: footerY, size: 7, font: helvetica, color: colors.textMuted,
    });

    const pdfBytes = await doc.save();
    return Buffer.from(pdfBytes);
}

export async function generatePurchaseOrderPdf(poId: string): Promise<Buffer> {
    const po = await prisma.purchaseOrder.findUnique({
        where: { id: poId },
        include: {
            items: { orderBy: { order: 'asc' } },
            vendor: true,
            project: { include: { client: true } },
        },
    });

    if (!po) throw new Error('Purchase Order not found');

    const company = await prisma.companySettings.findUnique({ where: { id: 'singleton' } });

    const doc = await PDFDocument.create();
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);

    const pageWidth = 612; // Letter width
    const pageHeight = 792; // Letter height
    const margin = 50;
    const contentWidth = pageWidth - margin * 2;

    let page = doc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    function checkNewPage(needed: number = 80) {
        if (y < needed) {
            page = doc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
        }
    }

    // Flow wrapped multi-line plain text (notes/terms can be long) and sync the local
    // page/y cursor — drawWrappedText paginates on its own when it runs out of room.
    const poFonts = { regular: helvetica, bold: helveticaBold, italic: helvetica, boldItalic: helveticaBold };
    function flowText(text: string, opts: { x: number; maxWidth: number; size: number; color: ReturnType<typeof rgb>; lineHeight: number }) {
        const ctx: RichTextCtx = {
            doc, page, y, fonts: poFonts,
            layout: { pageWidth, pageHeight, margin, contentWidth },
            color: colors.textMain, mutedColor: colors.textMuted,
        };
        const res = drawWrappedText(text, ctx, opts);
        page = res.page;
        y = res.y;
    }

    // --- Letterhead ---
    const lhConfig = buildLetterheadConfig(company);
    y = await drawLetterhead(doc, page, lhConfig, { pageWidth, pageHeight, margin }, { regular: helvetica, bold: helveticaBold });

    // --- Title ---
    page.drawText('PURCHASE ORDER', {
        x: margin, y, size: 22, font: helveticaBold, color: colors.textMain,
    });

    // --- PO Info ---
    y -= 30;

    // Left: Vendor info
    page.drawText('VENDOR', {
        x: margin, y, size: 9, font: helveticaBold, color: colors.textMuted,
    });

    if (po.vendor?.name) {
        y -= 16;
        page.drawText(po.vendor.name, {
            x: margin, y, size: 11, font: helveticaBold, color: colors.textMain,
        });
    }
    const vendorNameStr = [po.vendor?.firstName, po.vendor?.lastName].filter(Boolean).join(" ");
    if (vendorNameStr) {
        y -= 14;
        page.drawText(vendorNameStr, {
            x: margin, y, size: 9, font: helvetica, color: colors.textMain,
        });
    }
    if (po.vendor?.email) {
        y -= 14;
        page.drawText(po.vendor.email, {
            x: margin, y, size: 9, font: helvetica, color: colors.textMuted,
        });
    }

    // Right side: PO # / Date
    const rightX = pageWidth - margin;
    let ry = y + (po.vendor?.email ? 44 : 30);

    const drawRightLabel = (label: string, value: string, yPos: number) => {
        page.drawText(label, {
            x: rightX - 160, y: yPos, size: 9, font: helvetica, color: colors.textMuted,
        });
        const valueWidth = helveticaBold.widthOfTextAtSize(value, 9);
        page.drawText(value, {
            x: rightX - valueWidth, y: yPos, size: 9, font: helveticaBold, color: colors.textMain,
        });
    };

    drawRightLabel('P.O. No.', po.code || '', ry);
    ry -= 16;
    drawRightLabel('Date', new Date(po.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }), ry);
    ry -= 16;
    drawRightLabel('Project', po.project?.name || '', ry);

    // --- Separator ---
    y -= 20;
    page.drawLine({
        start: { x: margin, y }, end: { x: pageWidth - margin, y },
        thickness: 0.5, color: colors.border,
    });
    y -= 20;

    // --- Table Header ---
    const cols = {
        name: margin,
        qty: margin + contentWidth * 0.55,
        unitCost: margin + contentWidth * 0.75,
        total: pageWidth - margin,
    };

    function drawPOTableHeader() {
        page.drawText('DESCRIPTION', {
            x: cols.name, y, size: 8, font: helveticaBold, color: colors.textMuted,
        });
        const qtyLabel = 'QTY';
        const qtyWidth = helveticaBold.widthOfTextAtSize(qtyLabel, 8);
        page.drawText(qtyLabel, {
            x: cols.qty - qtyWidth, y, size: 8, font: helveticaBold, color: colors.textMuted,
        });
        const ucLabel = 'UNIT COST';
        const ucWidth = helveticaBold.widthOfTextAtSize(ucLabel, 8);
        page.drawText(ucLabel, {
            x: cols.unitCost - ucWidth, y, size: 8, font: helveticaBold, color: colors.textMuted,
        });
        const totalLabel = 'TOTAL';
        const totalWidth = helveticaBold.widthOfTextAtSize(totalLabel, 8);
        page.drawText(totalLabel, {
            x: cols.total - totalWidth, y, size: 8, font: helveticaBold, color: colors.textMuted,
        });

        y -= 8;
        page.drawLine({
            start: { x: margin, y }, end: { x: pageWidth - margin, y },
            thickness: 0.5, color: colors.border,
        });
        y -= 14;
    }

    drawPOTableHeader();

    // --- Table Rows ---
    const rowLeading = 12;
    for (const item of po.items) {
        // Wrap the description to the column width instead of truncating it.
        const displayName = item.description || '';
        const maxNameWidth = contentWidth * 0.5;
        const wrappedName = wrapPlainText(displayName, helvetica, 10, maxNameWidth);
        const lineCount = Math.max(wrappedName.length, 1);
        const rowHeight = lineCount * rowLeading + 8;

        // Page-break BEFORE the row if the whole (possibly multi-line) row doesn't fit,
        // re-drawing the table header on the new page.
        if (y - rowHeight < margin) {
            page = doc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
            drawPOTableHeader();
        }

        wrappedName.forEach((line, idx) => {
            page.drawText(line, {
                x: cols.name, y: y - idx * rowLeading, size: 10, font: helvetica, color: colors.textMain,
            });
        });

        // Qty — aligned with the first line of the wrapped description
        const qtyStr = String(item.quantity || 0);
        const qtyStrWidth = helvetica.widthOfTextAtSize(qtyStr, 10);
        page.drawText(qtyStr, {
            x: cols.qty - qtyStrWidth, y, size: 10, font: helvetica, color: colors.textMuted,
        });

        // Unit cost — aligned with the first line of the wrapped description
        const ucStr = formatCurrency(toNum(item.unitCost));
        const ucStrWidth = helvetica.widthOfTextAtSize(ucStr, 10);
        page.drawText(ucStr, {
            x: cols.unitCost - ucStrWidth, y, size: 10, font: helvetica, color: colors.textMuted,
        });

        // Total — aligned with the first line of the wrapped description
        const totalStr = formatCurrency(toNum(item.total));
        const totalStrWidth = helveticaBold.widthOfTextAtSize(totalStr, 10);
        page.drawText(totalStr, {
            x: cols.total - totalStrWidth, y, size: 10, font: helveticaBold, color: colors.textMain,
        });

        y -= rowHeight;
    }

    // --- Totals Section ---
    y -= 10;
    checkNewPage(120);
    page.drawLine({
        start: { x: margin + contentWidth * 0.5, y },
        end: { x: pageWidth - margin, y },
        thickness: 0.5, color: colors.border,
    });
    y -= 25;

    const total = toNum(po.totalAmount);

    // Total line
    const labelX = cols.unitCost - 60;
    page.drawText('Total Amount', {
        x: labelX, y: y, size: 14, font: helveticaBold, color: colors.textMain,
    });
    const totalStr2 = formatCurrency(total);
    const totalWidth2 = helveticaBold.widthOfTextAtSize(totalStr2, 14);
    page.drawText(totalStr2, {
        x: cols.total - totalWidth2, y: y, size: 14, font: helveticaBold, color: colors.textMain,
    });

    // --- Notes and Terms ---
    if (po.notes) {
        y -= 40;
        checkNewPage(80);
        page.drawText('Notes:', { x: margin, y, size: 10, font: helveticaBold, color: colors.textMain });
        y -= 14;
        flowText(po.notes, { x: margin, maxWidth: contentWidth, size: 9, color: colors.textMuted, lineHeight: 13 });
    }

    if (po.terms) {
        y -= 16;
        checkNewPage(80);
        page.drawText('Terms & Conditions:', { x: margin, y, size: 10, font: helveticaBold, color: colors.textMain });
        y -= 14;
        flowText(po.terms, { x: margin, maxWidth: contentWidth, size: 9, color: colors.textMuted, lineHeight: 13 });
    }

    const pdfBytes = await doc.save();
    return Buffer.from(pdfBytes);
}

export async function generateInvoicePdf(
    invoiceId: string,
    // When set, the PDF mirrors the client's milestone-scoped view: the listed
    // milestones are marked "Requested" and the headline figure is the requested
    // total, not the full invoice balance.
    opts?: { requestedMilestoneIds?: string[] },
): Promise<Buffer> {
    const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
            // Schedule order (same as the portal and invoice editor), not alphabetical.
            // id tiebreaker: same-transaction inserts can share createdAt, and cuids
            // are monotonic within a batch, so this pins insertion order.
            payments: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
            project: { include: { client: true } },
            client: true,
        },
    });

    if (!invoice) throw new Error('Invoice not found');

    const requestedIds = new Set(opts?.requestedMilestoneIds ?? []);
    // Pending-only — same predicate as the portal's focus mode and markInvoiceViewed.
    const requestedPayments = invoice.payments.filter(p => requestedIds.has(p.id) && p.status === 'Pending');

    const company = await prisma.companySettings.findUnique({ where: { id: 'singleton' } });

    const doc = await PDFDocument.create();
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);

    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 50;
    const contentWidth = pageWidth - margin * 2;

    let page = doc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    function checkNewPage(needed: number = 80) {
        if (y < needed) {
            page = doc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
        }
    }

    // Flow wrapped multi-line plain text (notes can be long) and sync the local
    // page/y cursor — drawWrappedText paginates on its own when it runs out of room.
    const invFonts = { regular: helvetica, bold: helveticaBold, italic: helvetica, boldItalic: helveticaBold };
    function flowText(text: string, opts: { x: number; maxWidth: number; size: number; color: ReturnType<typeof rgb>; lineHeight: number }) {
        const ctx: RichTextCtx = {
            doc, page, y, fonts: invFonts,
            layout: { pageWidth, pageHeight, margin, contentWidth },
            color: colors.textMain, mutedColor: colors.textMuted,
        };
        const res = drawWrappedText(text, ctx, opts);
        page = res.page;
        y = res.y;
    }

    // --- Letterhead ---
    const lhConfig = buildLetterheadConfig(company);
    y = await drawLetterhead(doc, page, lhConfig, { pageWidth, pageHeight, margin }, { regular: helvetica, bold: helveticaBold });

    page.drawText('INVOICE', { x: margin, y, size: 26, font: helveticaBold, color: colors.textMain });

    y -= 30;
    const clientName = invoice.client?.name || '';
    const clientEmail = invoice.client?.email || '';

    page.drawText('BILL TO', { x: margin, y, size: 9, font: helveticaBold, color: colors.textMuted });
    if (clientName) { y -= 16; page.drawText(clientName, { x: margin, y, size: 11, font: helvetica, color: colors.textMain }); }
    if (clientEmail) { y -= 14; page.drawText(clientEmail, { x: margin, y, size: 9, font: helvetica, color: colors.textMuted }); }

    const rightX = pageWidth - margin;
    let ry = y + (clientEmail ? 30 : 16);

    const drawRL = (label: string, value: string, yPos: number) => {
        page.drawText(label, { x: rightX - 160, y: yPos, size: 9, font: helvetica, color: colors.textMuted });
        const vw = helveticaBold.widthOfTextAtSize(value, 9);
        page.drawText(value, { x: rightX - vw, y: yPos, size: 9, font: helveticaBold, color: colors.textMain });
    };

    drawRL('Invoice No.', invoice.code || '', ry);
    ry -= 16;
    drawRL('Date', new Date(invoice.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }), ry);
    ry -= 16;
    drawRL('Status', invoice.status || 'Draft', ry);
    ry -= 16;
    drawRL('Project', invoice.project?.name || '', ry);

    y -= 20;
    page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 0.5, color: colors.border });
    y -= 20;

    // Payment schedule table
    const invCols = { name: margin, status: margin + contentWidth * 0.45, dueDate: margin + contentWidth * 0.65, amount: pageWidth - margin };

    function drawInvoiceTableHeader() {
        page.drawText('PAYMENT', { x: invCols.name, y, size: 8, font: helveticaBold, color: colors.textMuted });
        const sLabel = 'STATUS'; const sW = helveticaBold.widthOfTextAtSize(sLabel, 8);
        page.drawText(sLabel, { x: invCols.status - sW, y, size: 8, font: helveticaBold, color: colors.textMuted });
        const dLabel = 'DUE DATE'; const dW = helveticaBold.widthOfTextAtSize(dLabel, 8);
        page.drawText(dLabel, { x: invCols.dueDate - dW, y, size: 8, font: helveticaBold, color: colors.textMuted });
        const aLabel = 'AMOUNT'; const aW = helveticaBold.widthOfTextAtSize(aLabel, 8);
        page.drawText(aLabel, { x: invCols.amount - aW, y, size: 8, font: helveticaBold, color: colors.textMuted });

        y -= 8;
        page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 0.5, color: colors.border });
        y -= 14;
    }

    drawInvoiceTableHeader();

    const rowLeading = 12;
    for (const payment of invoice.payments) {
        // Wrap the payment label to the column width instead of truncating it.
        const displayName = payment.name || '';
        const maxNameWidth = contentWidth * 0.4;
        const wrappedName = wrapPlainText(displayName, helvetica, 10, maxNameWidth);
        const lineCount = Math.max(wrappedName.length, 1);
        const rowHeight = lineCount * rowLeading + 8;

        // Page-break BEFORE the row if the whole (possibly multi-line) row doesn't fit,
        // re-drawing the table header on the new page.
        if (y - rowHeight < margin) {
            page = doc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
            drawInvoiceTableHeader();
        }

        wrappedName.forEach((line, idx) => {
            page.drawText(line, { x: invCols.name, y: y - idx * rowLeading, size: 10, font: helvetica, color: colors.textMain });
        });

        const isRequested = requestedIds.has(payment.id) && payment.status === 'Pending';
        const statusStr = isRequested ? 'Requested' : (payment.status || 'Pending');
        const statusFont = isRequested ? helveticaBold : helvetica;
        const statusW = statusFont.widthOfTextAtSize(statusStr, 10);
        page.drawText(statusStr, { x: invCols.status - statusW, y, size: 10, font: statusFont, color: payment.status === 'Paid' || isRequested ? colors.primary : colors.textMuted });

        const dueDateStr = payment.dueDate ? new Date(payment.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
        const dueDateW = helvetica.widthOfTextAtSize(dueDateStr, 10);
        page.drawText(dueDateStr, { x: invCols.dueDate - dueDateW, y, size: 10, font: helvetica, color: colors.textMuted });

        const amtStr = formatCurrency(Number(payment.amount) || 0);
        const amtW = helveticaBold.widthOfTextAtSize(amtStr, 10);
        page.drawText(amtStr, { x: invCols.amount - amtW, y, size: 10, font: helveticaBold, color: colors.textMain });

        y -= rowHeight;
    }

    // Totals
    y -= 10;
    // 110 (not 80): the headline (Balance Due / Amount Requested) row below draws at
    // plain y after two more 20-ish-pt decrements — keep it comfortably clear of the
    // footer rather than relying on the footer's own guard.
    checkNewPage(110);
    page.drawLine({ start: { x: margin + contentWidth * 0.5, y }, end: { x: pageWidth - margin, y }, thickness: 0.5, color: colors.border });
    y -= 25;

    const invLabelX = margin + contentWidth * 0.5;
    const totalAmt = Number(invoice.totalAmount) || 0;
    const balanceDue = Number(invoice.balanceDue) || 0;

    page.drawText('Total Amount', { x: invLabelX, y, size: 10, font: helvetica, color: colors.textMuted });
    const totalStr = formatCurrency(totalAmt);
    const totalW = helvetica.widthOfTextAtSize(totalStr, 10);
    page.drawText(totalStr, { x: invCols.amount - totalW, y, size: 10, font: helvetica, color: colors.textMain });
    y -= 22;

    // Milestone-scoped view: the headline is what was requested of the client,
    // not the whole outstanding balance.
    const requestedTotal = requestedPayments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const headlineLabel = requestedPayments.length > 0 ? 'Amount Requested' : 'Balance Due';
    const headlineAmt = requestedPayments.length > 0 ? requestedTotal : balanceDue;
    page.drawText(headlineLabel, { x: invLabelX, y, size: 14, font: helveticaBold, color: colors.primary });
    const balStr = formatCurrency(headlineAmt);
    const balW = helveticaBold.widthOfTextAtSize(balStr, 14);
    page.drawText(balStr, { x: invCols.amount - balW, y, size: 14, font: helveticaBold, color: colors.primary });

    if (invoice.notes) {
        y -= 40;
        checkNewPage(80);
        page.drawText('Notes:', { x: margin, y, size: 10, font: helveticaBold, color: colors.textMain });
        y -= 14;
        flowText(invoice.notes, { x: margin, maxWidth: contentWidth, size: 9, color: colors.textMuted, lineHeight: 13 });
    }

    // No pre-footer page-break guard here: every content path above already page-breaks
    // (or is bounded, see the checkNewPage(110) totals guard) well clear of the footer's
    // y=30, so this can't collide — and a guard here would emit a footer-only blank page.
    const footerText = `Generated ${new Date().toLocaleDateString()} • ${company?.companyName || 'ProBuild'}`;
    page.drawText(footerText, { x: margin, y: 30, size: 7, font: helvetica, color: colors.textMuted });

    const pdfBytes = await doc.save();
    return Buffer.from(pdfBytes);
}

export async function generateChangeOrderPdf(coId: string): Promise<Buffer> {
    const co = await prisma.changeOrder.findUnique({
        where: { id: coId },
        include: {
            items: { orderBy: { order: 'asc' } },
            paymentSchedules: { orderBy: { order: 'asc' } },
            project: { include: { client: true } },
            estimate: true,
        },
    });

    if (!co) throw new Error('Change Order not found');

    const company = await prisma.companySettings.findUnique({ where: { id: 'singleton' } });

    const doc = await PDFDocument.create();
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);

    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 50;
    const contentWidth = pageWidth - margin * 2;

    let page = doc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    function checkNewPage(needed: number = 80) {
        if (y < needed) {
            page = doc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
        }
    }

    // Flow wrapped multi-line text (descriptions can be long) and sync the local
    // page/y cursor — drawWrappedText paginates on its own when it runs out of room.
    const coFonts = { regular: helvetica, bold: helveticaBold, italic: helvetica, boldItalic: helveticaBold };
    function flowText(text: string, opts: { x: number; maxWidth: number; size: number; color: ReturnType<typeof rgb>; lineHeight: number }) {
        const ctx: RichTextCtx = {
            doc, page, y, fonts: coFonts,
            layout: { pageWidth, pageHeight, margin, contentWidth },
            color: colors.textMain, mutedColor: colors.textMuted,
        };
        const res = drawWrappedText(text, ctx, opts);
        page = res.page;
        y = res.y;
    }

    // --- Letterhead ---
    const coLhConfig = buildLetterheadConfig(company);
    y = await drawLetterhead(doc, page, coLhConfig, { pageWidth, pageHeight, margin }, { regular: helvetica, bold: helveticaBold });

    // Header mirrors the invoice PDF: 26pt title, BILL TO block (name + email),
    // right-aligned meta column, then a divider clear of both columns.
    y -= 24;
    page.drawText('CHANGE ORDER', { x: margin, y, size: 26, font: helveticaBold, color: colors.textMain });

    if (co.title) {
        y -= 22;
        page.drawText(co.title, { x: margin, y, size: 11, font: helvetica, color: colors.textMuted });
    }
    y -= 30;

    const coClientName = co.project?.client?.name || '';
    const coClientEmail = co.project?.client?.email || '';
    const coBillToY = y; // meta column anchors to the BILL TO baseline
    page.drawText('BILL TO', { x: margin, y, size: 9, font: helveticaBold, color: colors.textMuted });
    if (coClientName) { y -= 16; page.drawText(coClientName, { x: margin, y, size: 11, font: helvetica, color: colors.textMain }); }
    if (coClientEmail) { y -= 14; page.drawText(coClientEmail, { x: margin, y, size: 9, font: helvetica, color: colors.textMuted }); }

    const coRightX = pageWidth - margin;
    let coRy = coBillToY;

    const drawCORL = (label: string, value: string, yPos: number) => {
        page.drawText(label, { x: coRightX - 160, y: yPos, size: 9, font: helvetica, color: colors.textMuted });
        const vw = helveticaBold.widthOfTextAtSize(value, 9);
        page.drawText(value, { x: coRightX - vw, y: yPos, size: 9, font: helveticaBold, color: colors.textMain });
    };

    drawCORL('C.O. No.', co.code || '', coRy);
    coRy -= 16;
    drawCORL('Date', new Date(co.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }), coRy);
    coRy -= 16;
    drawCORL('Status', co.status || 'Draft', coRy);
    coRy -= 16;
    drawCORL('Project', co.project?.name || '', coRy);

    // The meta column is 4 rows tall; the client block can be shorter. Drop the
    // divider below whichever column ends lower so it never crosses a meta row.
    y = Math.min(y, coRy) - 20;
    page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 0.5, color: colors.border });
    y -= 20;

    if (co.description) {
        page.drawText('Description:', { x: margin, y, size: 10, font: helveticaBold, color: colors.textMain });
        y -= 14;
        flowText(co.description, { x: margin, maxWidth: contentWidth, size: 9, color: colors.textMuted, lineHeight: 13 });
        y -= 10;
    }

    // Full name and description render wrapped (no truncation — the client must
    // see the entire scope text). Items are pre-measured so short items never
    // split across a page break; very long ones flow and paginate on their own.
    // An empty name still consumes one 13pt row (the money columns' baseline).
    // The name shares its first row with the QTY/UNIT COST/TOTAL figures so it
    // stays inside its column; description lines sit below that row and can run
    // wider without colliding with the money columns.
    const coNameWidth = contentWidth * 0.5;
    const coDescWidth = contentWidth * 0.78;
    const coItemEstHeight = (item: { name?: string | null; description?: string | null }) => {
        const nameLines = measureWrappedLines(item.name || '', helvetica, 10, coNameWidth);
        const descLines = item.description ? measureWrappedLines(item.description, helvetica, 8.5, coDescWidth) : 0;
        return Math.max(1, nameLines) * 13 + (descLines ? 4 + descLines * 11.5 : 0) + 16;
    };
    // Fully empty placeholder rows (no name, no description, $0) would render
    // as orphan "$0.00" lines — drop them. Anything with text or money stays.
    // Section headers are excluded before the empty-row filter: a header mirrors the total
    // of the lines beneath it, so printing it would make the visible lines out-sum the
    // subtotal the customer signs. (The send guard refuses such a CO outright; this keeps an
    // unsent draft's preview honest.)
    const coVisibleItems = billableCoItems(co.items).filter(it =>
        (it.name || '').trim() || (it.description || '').trim() || Number(it.total) || Number(it.unitCost));
    // Reserve through the first item so neither the cost-plus terms block nor
    // the table header is left orphaned when the first row's preflight breaks.
    const coFirstItemH = coVisibleItems.length ? coItemEstHeight(coVisibleItems[0]) : 30;

    if (co.pricingType === 'COST_PLUS') {
        // Terms block (40pt) + table header (22pt) + first item stay together.
        checkNewPage(Math.min(margin + 62 + coFirstItemH, 500));
        page.drawText(`COST + ${co.markupPercent ?? 10}% + TAX`, { x: margin, y, size: 12, font: helveticaBold, color: colors.primary });
        y -= 16;
        page.drawText('Billed from actual time and materials. Scope-line amounts below are non-binding estimates.', { x: margin, y, size: 9, font: helvetica, color: colors.textMuted });
        y -= 24;
    }

    // Items table — a long description above may have flowed near the page
    // bottom; keep the column header (22pt) with the complete first item.
    checkNewPage(Math.min(margin + 22 + coFirstItemH, 500));
    const coCols = { name: margin, qty: margin + contentWidth * 0.55, unitCost: margin + contentWidth * 0.75, total: pageWidth - margin };

    page.drawText(co.pricingType === 'COST_PLUS' ? 'SCOPE ESTIMATE (NOT A FIXED PRICE)' : 'ITEM DESCRIPTION', { x: coCols.name, y, size: 8, font: helveticaBold, color: colors.textMuted });
    const coQtyLabel = 'QTY'; const coQtyW = helveticaBold.widthOfTextAtSize(coQtyLabel, 8);
    page.drawText(coQtyLabel, { x: coCols.qty - coQtyW, y, size: 8, font: helveticaBold, color: colors.textMuted });
    const coUcLabel = 'UNIT COST'; const coUcW = helveticaBold.widthOfTextAtSize(coUcLabel, 8);
    page.drawText(coUcLabel, { x: coCols.unitCost - coUcW, y, size: 8, font: helveticaBold, color: colors.textMuted });
    const coTLabel = 'TOTAL'; const coTW = helveticaBold.widthOfTextAtSize(coTLabel, 8);
    page.drawText(coTLabel, { x: coCols.total - coTW, y, size: 8, font: helveticaBold, color: colors.textMuted });

    y -= 8;
    page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 0.5, color: colors.border });
    y -= 14;

    for (let itemIdx = 0; itemIdx < coVisibleItems.length; itemIdx++) {
        const item = coVisibleItems[itemIdx];
        const itemName = item.name || '';
        const itemDesc = item.description || '';
        const nameLines = measureWrappedLines(itemName, helvetica, 10, coNameWidth);
        checkNewPage(Math.min(margin + coItemEstHeight(item), 500));

        const qtyStr = String(item.quantity || 0);
        const qtyStrW = helvetica.widthOfTextAtSize(qtyStr, 10);
        page.drawText(qtyStr, { x: coCols.qty - qtyStrW, y, size: 10, font: helvetica, color: colors.textMuted });

        const ucStr = formatCurrency(Number(item.unitCost) || 0);
        const ucStrW = helvetica.widthOfTextAtSize(ucStr, 10);
        page.drawText(ucStr, { x: coCols.unitCost - ucStrW, y, size: 10, font: helvetica, color: colors.textMuted });

        const itemTotalStr = formatCurrency(Number(item.total) || 0);
        const itemTotalW = helveticaBold.widthOfTextAtSize(itemTotalStr, 10);
        page.drawText(itemTotalStr, { x: coCols.total - itemTotalW, y, size: 10, font: helveticaBold, color: colors.textMain });

        if (nameLines > 0) flowText(itemName, { x: coCols.name, maxWidth: coNameWidth, size: 10, color: colors.textMain, lineHeight: 13 });
        else y -= 13;
        if (itemDesc) {
            y -= 4;
            flowText(itemDesc, { x: coCols.name, maxWidth: coDescWidth, size: 8.5, color: colors.textMuted, lineHeight: 11.5 });
        }
        // Hairline between items keeps long scope lists scannable; the totals
        // rule already follows the last item, so skip it there.
        if (itemIdx < coVisibleItems.length - 1) {
            const ruleY = y + 5;
            page.drawLine({ start: { x: margin, y: ruleY }, end: { x: pageWidth - margin, y: ruleY }, thickness: 0.5, color: colors.border });
            y = ruleY - 16;
        } else {
            y -= 7;
        }
    }

    // Total — reserve the whole Subtotal/Tax/Revised Amount block (rule + 3 rows)
    // so it never straddles the bottom margin or splits across pages. Cost-plus
    // shows a single terms row, so the smaller reserve avoids early page breaks.
    y -= 10;
    checkNewPage(co.pricingType === 'COST_PLUS' ? 80 : 125);
    page.drawLine({ start: { x: margin + contentWidth * 0.5, y }, end: { x: pageWidth - margin, y }, thickness: 0.5, color: colors.border });
    y -= 25;

    const coLabelX = coCols.unitCost - 60;
    // co.totalAmount is the PRE-TAX subtotal (billChangeOrderCore semantic); show
    // the same Subtotal / Tax / Revised Amount breakdown the customer signs on the
    // portal page so the PDF and signature page never disagree.
    const coSubtotal = Math.round((Number(co.totalAmount) || 0) * 100) / 100;
    const coTax = Math.round(coSubtotal * coTaxRate(co.estimate) * 100) / 100;
    const coTotal = Math.round((coSubtotal + coTax) * 100) / 100;

    const drawCoTotalRow = (label: string, value: string, size: number, font: PDFFont, color: ReturnType<typeof rgb>) => {
        page.drawText(label, { x: coLabelX, y, size, font, color });
        const vw = font.widthOfTextAtSize(value, size);
        page.drawText(value, { x: coCols.total - vw, y, size, font, color });
    };

    if (co.pricingType === 'COST_PLUS') {
        drawCoTotalRow('Approved terms', `Cost + ${co.markupPercent ?? 10}% + tax`, 12, helveticaBold, colors.primary);
    } else {
        drawCoTotalRow('Subtotal', formatCurrency(coSubtotal), 10, helvetica, colors.textMain);
        y -= 18;
        drawCoTotalRow(coTaxLabel(co.estimate), formatCurrency(coTax), 10, helvetica, colors.textMain);
        y -= 22;
        checkNewPage(60);
        drawCoTotalRow('Revised Amount', formatCurrency(coTotal), 14, helveticaBold, colors.primary);
    }

    if (co.pricingType === 'FIXED' && co.paymentSchedules.length > 0) {
        y -= 38;
        checkNewPage(60 + co.paymentSchedules.length * 18);
        page.drawText('PAYMENT SCHEDULE', { x: margin, y, size: 10, font: helveticaBold, color: colors.textMain });
        y -= 18;
        for (const schedule of co.paymentSchedules) {
            page.drawText(`${schedule.name}${schedule.dueDate ? ` · ${new Date(schedule.dueDate).toLocaleDateString('en-US')}` : ''}`, { x: margin, y, size: 9, font: helvetica, color: colors.textMain });
            const value = formatCurrency(Number(schedule.amount));
            page.drawText(value, { x: pageWidth - margin - helveticaBold.widthOfTextAtSize(value, 9), y, size: 9, font: helveticaBold, color: colors.textMain });
            y -= 18;
        }
    }

    // Signatures — client approval and company countersignature are independent blocks.
    if (co.status === 'Approved' && co.approvedBy) {
        y -= 50;
        checkNewPage(100);
        page.drawText('Client Approval', { x: margin, y, size: 11, font: helveticaBold, color: colors.textMain });
        y -= 20;
        page.drawText(`Approved By: ${co.approvedBy}`, { x: margin, y, size: 10, font: helveticaBold, color: colors.textMain });
        y -= 15;
        page.drawText(`Date: ${co.approvedAt ? new Date(co.approvedAt).toLocaleString() : '—'}`, { x: margin, y, size: 10, font: helvetica, color: colors.textMain });
    }

    if (co.companySignedBy) {
        y -= 30;
        checkNewPage(100);
        page.drawText('Company Countersignature', { x: margin, y, size: 11, font: helveticaBold, color: colors.textMain });
        y -= 20;
        page.drawText(`Signed By: ${co.companySignedBy}`, { x: margin, y, size: 10, font: helveticaBold, color: colors.textMain });
        y -= 15;
        page.drawText(`Date: ${co.companySignedAt ? new Date(co.companySignedAt).toLocaleString() : '—'}`, { x: margin, y, size: 10, font: helvetica, color: colors.textMain });
    }

    const coFooterText = `Generated ${new Date().toLocaleDateString()} • ${company?.companyName || 'ProBuild'}`;
    page.drawText(coFooterText, { x: margin, y: 30, size: 7, font: helvetica, color: colors.textMuted });

    const pdfBytes = await doc.save();
    return Buffer.from(pdfBytes);
}

type BillingSnapshot = {
    timeEntries?: Array<{ name?: string; date?: string; hours?: number; notes?: string | null; laborCents?: number; burdenCents?: number; totalCents?: number }>;
    expenses?: Array<{ date?: string; vendor?: string | null; description?: string | null; receiptUrl?: string | null; amountCents?: number }>;
};

/** Generate the immutable itemized backup for one cost-plus billing run. */
export async function generateChangeOrderBillingPdf(changeOrderId: string, billingId: string): Promise<Buffer> {
    const billing = await prisma.changeOrderBilling.findFirst({
        where: { id: billingId, changeOrderId },
        include: { changeOrder: { include: { project: { include: { client: true } } } } },
    });
    if (!billing) throw new Error("Change-order billing not found");

    const snapshot = (billing.snapshot ?? {}) as BillingSnapshot;
    const company = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 48;
    let page = doc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;
    const money = (cents: number | undefined) => formatCurrency((cents ?? 0) / 100);
    const addPageIfNeeded = (height = 24) => {
        if (y - height < 48) {
            page = doc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
        }
    };
    const line = (label: string, amount: string, emphasize = false) => {
        addPageIfNeeded();
        const font = emphasize ? bold : regular;
        page.drawText(label.slice(0, 72), { x: margin, y, size: emphasize ? 11 : 9, font, color: colors.textMain });
        const width = font.widthOfTextAtSize(amount, emphasize ? 11 : 9);
        page.drawText(amount, { x: pageWidth - margin - width, y, size: emphasize ? 11 : 9, font, color: colors.textMain });
        y -= 18;
    };

    page.drawText(company?.companyName || "ProBuild", { x: margin, y, size: 12, font: bold, color: colors.primary });
    y -= 28;
    page.drawText("ITEMIZED TIME & MATERIALS BACKUP", { x: margin, y, size: 18, font: bold, color: colors.textMain });
    y -= 22;
    page.drawText(`${billing.changeOrder.code} — ${billing.changeOrder.title}`, { x: margin, y, size: 11, font: bold, color: colors.textMain });
    y -= 16;
    page.drawText(`${billing.changeOrder.project.name} · ${billing.changeOrder.project.client?.name || "Client"} · ${billing.label}`, { x: margin, y, size: 9, font: regular, color: colors.textMuted });
    y -= 28;

    page.drawText("TIME", { x: margin, y, size: 11, font: bold, color: colors.textMain });
    y -= 20;
    for (const row of snapshot.timeEntries ?? []) {
        const date = row.date ? new Date(row.date).toLocaleDateString("en-US") : "";
        const detail = `${date} · ${row.name || "Crew"} · ${row.hours ?? 0} hr${row.notes ? ` · ${row.notes}` : ""}`;
        line(detail, money(row.totalCents ?? ((row.laborCents ?? 0) + (row.burdenCents ?? 0))));
    }
    if (!(snapshot.timeEntries?.length)) line("No time entries", "$0.00");

    y -= 8;
    addPageIfNeeded(40);
    page.drawText("EXPENSES", { x: margin, y, size: 11, font: bold, color: colors.textMain });
    y -= 20;
    for (const row of snapshot.expenses ?? []) {
        const date = row.date ? new Date(row.date).toLocaleDateString("en-US") : "";
        const receipt = row.receiptUrl ? " · receipt on file" : "";
        line(`${date} · ${row.vendor || "Expense"}${row.description ? ` · ${row.description}` : ""}${receipt}`, money(row.amountCents));
        if (row.receiptUrl) {
            addPageIfNeeded();
            page.drawText(row.receiptUrl.slice(0, 90), { x: margin + 12, y, size: 7, font: regular, color: colors.textMuted });
            y -= 14;
        }
    }
    if (!(snapshot.expenses?.length)) line("No expenses", "$0.00");

    y -= 12;
    page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 0.5, color: colors.border });
    y -= 22;
    line("Labor", money(billing.laborCents));
    line("Expenses", money(billing.expenseCents));
    line("Markup", money(billing.markupCents));
    line("Subtotal", money(billing.laborCents + billing.expenseCents + billing.markupCents));
    line("Sales tax", money(billing.taxCents));
    line("Total", money(billing.totalCents), true);

    const bytes = await doc.save();
    return Buffer.from(bytes);
}
