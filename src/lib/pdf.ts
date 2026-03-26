import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { prisma } from './prisma';

// Color helpers
const colors = {
    primary: rgb(79 / 255, 70 / 255, 229 / 255),     // indigo-600
    textMain: rgb(15 / 255, 23 / 255, 42 / 255),      // slate-900
    textMuted: rgb(100 / 255, 116 / 255, 139 / 255),   // slate-500
    border: rgb(226 / 255, 232 / 255, 240 / 255),      // slate-200
    bgLight: rgb(248 / 255, 250 / 255, 252 / 255),     // slate-50
    white: rgb(1, 1, 1),
};

function formatCurrency(amount: number): string {
    return `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

    // --- Header accent bar ---
    page.drawRectangle({
        x: 0, y: pageHeight - 6, width: pageWidth, height: 6,
        color: colors.primary,
    });
    y = pageHeight - 40;

    // --- Company Name ---
    if (company?.companyName) {
        page.drawText(company.companyName.toUpperCase(), {
            x: margin, y, size: 11, font: helvetica, color: colors.textMuted,
        });
    }

    // --- Title ---
    y -= 30;
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

    drawTableHeader();

    // --- Table Rows ---
    for (const item of estimate.items) {
        checkNewPage(100);

        const isSubItem = !!item.parentId;
        const nameX = isSubItem ? cols.name + 16 : cols.name;
        const nameFont = isSubItem ? helvetica : helveticaBold;

        // Truncate long names
        let displayName = item.name || '';
        const maxNameWidth = contentWidth * 0.5;
        while (nameFont.widthOfTextAtSize(displayName, 10) > maxNameWidth && displayName.length > 0) {
            displayName = displayName.slice(0, -1);
        }

        page.drawText(displayName, {
            x: nameX, y, size: 10, font: nameFont, color: colors.textMain,
        });

        // Qty
        const qtyStr = String(item.quantity || 0);
        const qtyWidth = helvetica.widthOfTextAtSize(qtyStr, 10);
        page.drawText(qtyStr, {
            x: cols.qty - qtyWidth, y, size: 10, font: helvetica, color: colors.textMuted,
        });

        // Unit cost
        const ucStr = formatCurrency(item.unitCost || 0);
        const ucWidth = helvetica.widthOfTextAtSize(ucStr, 10);
        page.drawText(ucStr, {
            x: cols.unitCost - ucWidth, y, size: 10, font: helvetica, color: colors.textMuted,
        });

        // Total
        const totalStr = formatCurrency(item.total || 0);
        const totalWidth = helveticaBold.widthOfTextAtSize(totalStr, 10);
        page.drawText(totalStr, {
            x: cols.total - totalWidth, y, size: 10, font: helveticaBold, color: colors.textMain,
        });

        y -= 20;
    }

    // --- Totals Section ---
    y -= 10;
    checkNewPage(120);
    page.drawLine({
        start: { x: margin + contentWidth * 0.5, y },
        end: { x: pageWidth - margin, y },
        thickness: 0.5, color: colors.border,
    });
    y -= 20;

    const subtotal = estimate.items.reduce((sum, item) => sum + (item.total || 0), 0);
    const tax = subtotal * 0.087;
    const total = subtotal + tax;

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
    page.drawText('Estimated Tax (8.7%)', {
        x: labelX, y, size: 10, font: helvetica, color: colors.textMuted,
    });
    const taxStr = formatCurrency(tax);
    const taxWidth = helvetica.widthOfTextAtSize(taxStr, 10);
    page.drawText(taxStr, {
        x: cols.total - taxWidth, y, size: 10, font: helvetica, color: colors.textMain,
    });
    y -= 22;

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
            if (sched.amount) schedInfo.push(formatCurrency(sched.amount));
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

        // Signature Image
        if (estimate.signatureUrl && estimate.signatureUrl.startsWith('data:image/png;base64,')) {
            try {
                const base64Data = estimate.signatureUrl.replace('data:image/png;base64,', '');
                const sigImageBytes = Buffer.from(base64Data, 'base64');
                const embeddedSig = await doc.embedPng(sigImageBytes);
                
                // Scale signature down so it fits nicely
                const sigDims = embeddedSig.scale(0.35); 
                page.drawImage(embeddedSig, {
                    x: pageWidth - margin - sigDims.width,
                    y: y, // draw next to metadata
                    width: sigDims.width,
                    height: sigDims.height,
                });
            } catch (err) {
                console.warn("Could not embed signature image in PDF:", err);
            }
        }
        
        y -= 40;
    }

    // --- Footer ---
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
