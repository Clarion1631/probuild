import { PDFDocument, rgb, StandardFonts, PDFImage } from 'pdf-lib';
import { prisma } from './prisma';

async function fetchAndEmbedLogo(doc: PDFDocument, url: string): Promise<PDFImage | null> {
    try {
        // SSRF guard: only allow HTTPS URLs from known safe hosts
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return null;
        const allowedHosts = [
            process.env.NEXT_PUBLIC_SUPABASE_URL ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname : null,
            'ghzdbzdnwjxazvmcefbh.supabase.co',
        ].filter(Boolean);
        const isAllowed = allowedHosts.some(h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`));
        if (!isAllowed) {
            console.warn('Logo URL blocked (not in allowlist):', parsed.hostname);
            return null;
        }
        const res = await fetch(url);
        if (!res.ok) return null;
        const buffer = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('png') || url.toLowerCase().endsWith('.png')) {
            return await doc.embedPng(buffer);
        }
        return await doc.embedJpg(buffer);
    } catch (err) {
        console.warn('Could not embed logo in PDF:', err);
        return null;
    }
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

function formatCurrency(amount: number): string {
    return `$${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

    // --- Logo + Company Name + Contact Info ---
    let logoImage: PDFImage | null = null;
    if (company?.logoUrl) {
        logoImage = await fetchAndEmbedLogo(doc, company.logoUrl);
    }

    let textX = margin;
    if (logoImage) {
        const maxLogoH = 40;
        const maxLogoW = 120;
        const scale = Math.min(maxLogoW / logoImage.width, maxLogoH / logoImage.height, 1);
        const logoW = logoImage.width * scale;
        const logoH = logoImage.height * scale;
        page.drawImage(logoImage, {
            x: margin, y: y - logoH + 12, width: logoW, height: logoH,
        });
        textX = margin + logoW + 12;
    }

    if (company?.companyName) {
        page.drawText(company.companyName.toUpperCase(), {
            x: textX, y, size: 11, font: helveticaBold, color: colors.textMain,
        });
    }

    // Contact info
    const contactLines: string[] = [];
    if (company?.address) contactLines.push(company.address);
    if (company?.phone) contactLines.push(company.phone);
    if (company?.email) contactLines.push(company.email);

    let contactY = y;
    for (const line of contactLines) {
        contactY -= 12;
        page.drawText(line, {
            x: textX, y: contactY, size: 8, font: helvetica, color: colors.textMuted,
        });
    }

    const headerTopY = Math.min(contactY, y) - 20;

    // Right side header: "ESTIMATE" label (portal style, top-right)
    const rightX = pageWidth - margin;
    const estimateHeadLabel = 'ESTIMATE';
    const estimateHeadWidth = helveticaBold.widthOfTextAtSize(estimateHeadLabel, 22);
    page.drawText(estimateHeadLabel, {
        x: rightX - estimateHeadWidth, y: headerTopY, size: 22, font: helveticaBold, color: colors.primary,
    });

    const drawRightLabel = (label: string, value: string, yPos: number) => {
        page.drawText(label, {
            x: rightX - 160, y: yPos, size: 9, font: helvetica, color: colors.textMuted,
        });
        const valueWidth = helveticaBold.widthOfTextAtSize(value, 9);
        page.drawText(value, {
            x: rightX - valueWidth, y: yPos, size: 9, font: helveticaBold, color: colors.textMain,
        });
    };

    let ry = headerTopY - 24;
    drawRightLabel('Estimate No.', estimate.code || '', ry);
    ry -= 16;
    drawRightLabel('Date', new Date(estimate.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }), ry);
    ry -= 16;
    drawRightLabel('Status', estimate.status || 'Draft', ry);

    // --- Client + Project section ---
    y = headerTopY - 70;

    // Left: "PREPARED FOR" + client info
    const clientName = estimate.project?.client?.name || estimate.lead?.name || '';
    const clientEmail = estimate.project?.client?.email || estimate.lead?.client?.email || '';
    const client = estimate.project?.client || estimate.lead?.client;
    const clientAddress = client ? [client.addressLine1, client.city, client.state, client.zipCode].filter(Boolean).join(', ') : '';

    page.drawText('PREPARED FOR', {
        x: margin, y, size: 9, font: helveticaBold, color: colors.textMuted,
    });

    let leftY = y;
    if (clientName) {
        leftY -= 16;
        page.drawText(clientName, {
            x: margin, y: leftY, size: 11, font: helvetica, color: colors.textMain,
        });
    }
    if (clientAddress) {
        leftY -= 14;
        page.drawText(clientAddress, {
            x: margin, y: leftY, size: 9, font: helvetica, color: colors.textMuted,
        });
    }
    if (clientEmail) {
        leftY -= 14;
        page.drawText(clientEmail, {
            x: margin, y: leftY, size: 9, font: helvetica, color: colors.textMuted,
        });
    }

    // Right: "PROJECT" section
    const halfX = margin + contentWidth * 0.5;
    page.drawText('PROJECT', {
        x: halfX, y, size: 9, font: helveticaBold, color: colors.textMuted,
    });
    const projectTitle = estimate.title || '';
    let rightY = y;
    if (projectTitle) {
        rightY -= 16;
        page.drawText(projectTitle, {
            x: halfX, y: rightY, size: 11, font: helvetica, color: colors.textMain,
        });
    }

    y = Math.min(leftY, rightY) - 24;

    // --- Separator ---
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
        page.drawText('DESCRIPTION', {
            x: cols.name, y, size: 8, font: helveticaBold, color: colors.textMuted,
        });
        const qtyLabel = 'QTY';
        const qtyWidth = helveticaBold.widthOfTextAtSize(qtyLabel, 8);
        page.drawText(qtyLabel, {
            x: cols.qty - qtyWidth, y, size: 8, font: helveticaBold, color: colors.textMuted,
        });
        const ucLabel = 'UNIT PRICE';
        const ucWidth = helveticaBold.widthOfTextAtSize(ucLabel, 8);
        page.drawText(ucLabel, {
            x: cols.unitCost - ucWidth, y, size: 8, font: helveticaBold, color: colors.textMuted,
        });
        const totalLabel = 'AMOUNT';
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

        // Description (below name, word-wrapped in muted text)
        if (item.description) {
            y -= 14;
            const descWords = item.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
            let descLine = '';
            for (const word of descWords) {
                const testLine = descLine ? `${descLine} ${word}` : word;
                if (helvetica.widthOfTextAtSize(testLine, 8) > maxNameWidth && descLine) {
                    checkNewPage(14);
                    page.drawText(descLine, { x: nameX, y, size: 8, font: helvetica, color: colors.textMuted });
                    y -= 11;
                    descLine = word;
                } else {
                    descLine = testLine;
                }
            }
            if (descLine) {
                checkNewPage(14);
                page.drawText(descLine, { x: nameX, y, size: 8, font: helvetica, color: colors.textMuted });
            }
            y -= 14;
        } else {
            y -= 20;
        }
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

    const subtotal = estimate.items.reduce((sum, item) => sum + Number(item.total || 0), 0);
    const tax = subtotal * 0.088;
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
    page.drawText('Tax (8.8%)', {
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

            const schedName = sched.percentage ? `${sched.name || ''} (${sched.percentage}%)` : (sched.name || '');
            page.drawText(schedName, {
                x: margin, y, size: 9, font: helveticaBold, color: colors.textMain,
            });

            if (sched.dueDate) {
                const dateStr = new Date(sched.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
                page.drawText(dateStr, {
                    x: margin + contentWidth * 0.5, y, size: 9, font: helvetica, color: colors.textMuted,
                });
            }

            if (sched.amount) {
                const amtStr = formatCurrency(sched.amount);
                const amtWidth = helveticaBold.widthOfTextAtSize(amtStr, 9);
                page.drawText(amtStr, {
                    x: cols.total - amtWidth, y, size: 9, font: helveticaBold, color: colors.textMain,
                });
            }
            y -= 18;
        }
    }

    // --- Terms & Conditions ---
    if ((estimate as any).termsAndConditions) {
        y -= 40;
        checkNewPage(120);

        page.drawText('Terms & Conditions', {
            x: margin, y, size: 11, font: helveticaBold, color: colors.textMain,
        });
        y -= 18;

        // Strip HTML tags and pre-compute wrapped lines
        const rawTerms: string = (estimate as any).termsAndConditions;
        const plainTerms = rawTerms.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const tcPadding = 12;
        const tcWidth = contentWidth - tcPadding * 2;
        const tcLines: string[] = [];
        let tcLine = '';
        for (const word of plainTerms.split(' ')) {
            const testLine = tcLine ? `${tcLine} ${word}` : word;
            if (helvetica.widthOfTextAtSize(testLine, 9) > tcWidth && tcLine) {
                tcLines.push(tcLine);
                tcLine = word;
            } else {
                tcLine = testLine;
            }
        }
        if (tcLine) tcLines.push(tcLine);

        if (tcLines.length > 0) {
            // Draw background box
            const boxHeight = tcLines.length * 14 + tcPadding * 2;
            checkNewPage(boxHeight + 20);
            page.drawRectangle({
                x: margin, y: y - boxHeight, width: contentWidth, height: boxHeight,
                color: colors.bgLight,
                borderColor: colors.border,
                borderWidth: 1,
            });

            // Draw text inside box
            let tcY = y - tcPadding;
            for (const ln of tcLines) {
                page.drawText(ln, { x: margin + tcPadding, y: tcY, size: 9, font: helvetica, color: colors.textMuted });
                tcY -= 14;
            }
            y = tcY - tcPadding;
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

    // --- Header accent bar ---
    page.drawRectangle({
        x: 0, y: pageHeight - 6, width: pageWidth, height: 6,
        color: colors.primary, // Using primary color for header bar
    });
    y -= 34;

    // --- Company Name ---
    if (company?.companyName) {
        page.drawText(company.companyName.toUpperCase(), {
            x: margin, y, size: 11, font: helvetica, color: colors.textMuted,
        });
    }

    // --- Title ---
    y -= 30;
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

    // --- Table Rows ---
    for (const item of po.items) {
        checkNewPage(100);

        // Truncate long descriptions
        let displayName = item.description || '';
        const maxNameWidth = contentWidth * 0.5;
        while (helvetica.widthOfTextAtSize(displayName, 10) > maxNameWidth && displayName.length > 0) {
            displayName = displayName.slice(0, -1);
        }

        page.drawText(displayName, {
            x: cols.name, y, size: 10, font: helvetica, color: colors.textMain,
        });

        // Qty
        const qtyStr = String(item.quantity || 0);
        const qtyStrWidth = helvetica.widthOfTextAtSize(qtyStr, 10);
        page.drawText(qtyStr, {
            x: cols.qty - qtyStrWidth, y, size: 10, font: helvetica, color: colors.textMuted,
        });

        // Unit cost
        const ucStr = formatCurrency(item.unitCost || 0);
        const ucStrWidth = helvetica.widthOfTextAtSize(ucStr, 10);
        page.drawText(ucStr, {
            x: cols.unitCost - ucStrWidth, y, size: 10, font: helvetica, color: colors.textMuted,
        });

        // Total
        const totalStr = formatCurrency(item.total || 0);
        const totalStrWidth = helveticaBold.widthOfTextAtSize(totalStr, 10);
        page.drawText(totalStr, {
            x: cols.total - totalStrWidth, y, size: 10, font: helveticaBold, color: colors.textMain,
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
    y -= 25;

    const total = po.totalAmount || 0;

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
        page.drawText(po.notes, { x: margin, y, size: 9, font: helvetica, color: colors.textMuted });
    }
    
    if (po.terms) {
        y -= 30;
        checkNewPage(80);
        page.drawText('Terms & Conditions:', { x: margin, y, size: 10, font: helveticaBold, color: colors.textMain });
        y -= 14;
        page.drawText(po.terms, { x: margin, y, size: 9, font: helvetica, color: colors.textMuted });
    }

    const pdfBytes = await doc.save();
    return Buffer.from(pdfBytes);
}

export async function generateInvoicePdf(invoiceId: string): Promise<Buffer> {
    const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: {
            payments: { orderBy: { name: 'asc' } },
            project: { include: { client: true } },
            client: true,
        },
    });

    if (!invoice) throw new Error('Invoice not found');

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

    page.drawRectangle({ x: 0, y: pageHeight - 6, width: pageWidth, height: 6, color: colors.primary });
    y = pageHeight - 40;

    if (company?.companyName) {
        page.drawText(company.companyName.toUpperCase(), { x: margin, y, size: 11, font: helvetica, color: colors.textMuted });
    }

    y -= 30;
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

    for (const payment of invoice.payments) {
        checkNewPage(60);

        let displayName = payment.name || '';
        const maxNameWidth = contentWidth * 0.4;
        while (helvetica.widthOfTextAtSize(displayName, 10) > maxNameWidth && displayName.length > 0) displayName = displayName.slice(0, -1);

        page.drawText(displayName, { x: invCols.name, y, size: 10, font: helvetica, color: colors.textMain });

        const statusStr = payment.status || 'Pending';
        const statusW = helvetica.widthOfTextAtSize(statusStr, 10);
        page.drawText(statusStr, { x: invCols.status - statusW, y, size: 10, font: helvetica, color: payment.status === 'Paid' ? colors.primary : colors.textMuted });

        const dueDateStr = payment.dueDate ? new Date(payment.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
        const dueDateW = helvetica.widthOfTextAtSize(dueDateStr, 10);
        page.drawText(dueDateStr, { x: invCols.dueDate - dueDateW, y, size: 10, font: helvetica, color: colors.textMuted });

        const amtStr = formatCurrency(Number(payment.amount) || 0);
        const amtW = helveticaBold.widthOfTextAtSize(amtStr, 10);
        page.drawText(amtStr, { x: invCols.amount - amtW, y, size: 10, font: helveticaBold, color: colors.textMain });

        y -= 20;
    }

    // Totals
    y -= 10;
    checkNewPage(80);
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

    page.drawText('Balance Due', { x: invLabelX, y, size: 14, font: helveticaBold, color: colors.primary });
    const balStr = formatCurrency(balanceDue);
    const balW = helveticaBold.widthOfTextAtSize(balStr, 14);
    page.drawText(balStr, { x: invCols.amount - balW, y, size: 14, font: helveticaBold, color: colors.primary });

    if (invoice.notes) {
        y -= 40;
        checkNewPage(80);
        page.drawText('Notes:', { x: margin, y, size: 10, font: helveticaBold, color: colors.textMain });
        y -= 14;
        page.drawText(invoice.notes, { x: margin, y, size: 9, font: helvetica, color: colors.textMuted });
    }

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

    page.drawRectangle({ x: 0, y: pageHeight - 6, width: pageWidth, height: 6, color: colors.primary });
    y = pageHeight - 40;

    if (company?.companyName) {
        page.drawText(company.companyName.toUpperCase(), { x: margin, y, size: 11, font: helvetica, color: colors.textMuted });
    }

    y -= 30;
    page.drawText('CHANGE ORDER', { x: margin, y, size: 22, font: helveticaBold, color: colors.textMain });

    y -= 22;
    if (co.title) {
        page.drawText(co.title, { x: margin, y, size: 12, font: helvetica, color: colors.textMain });
        y -= 10;
    }

    y -= 20;
    const coClientName = co.project?.client?.name || '';
    page.drawText('CLIENT', { x: margin, y, size: 9, font: helveticaBold, color: colors.textMuted });
    if (coClientName) { y -= 16; page.drawText(coClientName, { x: margin, y, size: 11, font: helvetica, color: colors.textMain }); }

    const coRightX = pageWidth - margin;
    let coRy = y + (coClientName ? 16 : 0);

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

    y -= 20;
    page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 0.5, color: colors.border });
    y -= 20;

    if (co.description) {
        page.drawText('Description:', { x: margin, y, size: 10, font: helveticaBold, color: colors.textMain });
        y -= 14;
        page.drawText(co.description, { x: margin, y, size: 9, font: helvetica, color: colors.textMuted });
        y -= 20;
    }

    // Items table
    const coCols = { name: margin, qty: margin + contentWidth * 0.55, unitCost: margin + contentWidth * 0.75, total: pageWidth - margin };

    page.drawText('ITEM DESCRIPTION', { x: coCols.name, y, size: 8, font: helveticaBold, color: colors.textMuted });
    const coQtyLabel = 'QTY'; const coQtyW = helveticaBold.widthOfTextAtSize(coQtyLabel, 8);
    page.drawText(coQtyLabel, { x: coCols.qty - coQtyW, y, size: 8, font: helveticaBold, color: colors.textMuted });
    const coUcLabel = 'UNIT COST'; const coUcW = helveticaBold.widthOfTextAtSize(coUcLabel, 8);
    page.drawText(coUcLabel, { x: coCols.unitCost - coUcW, y, size: 8, font: helveticaBold, color: colors.textMuted });
    const coTLabel = 'TOTAL'; const coTW = helveticaBold.widthOfTextAtSize(coTLabel, 8);
    page.drawText(coTLabel, { x: coCols.total - coTW, y, size: 8, font: helveticaBold, color: colors.textMuted });

    y -= 8;
    page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 0.5, color: colors.border });
    y -= 14;

    for (const item of co.items) {
        checkNewPage(60);

        let displayName = item.name || '';
        const maxNameWidth = contentWidth * 0.5;
        while (helvetica.widthOfTextAtSize(displayName, 10) > maxNameWidth && displayName.length > 0) displayName = displayName.slice(0, -1);

        page.drawText(displayName, { x: coCols.name, y, size: 10, font: helvetica, color: colors.textMain });

        const qtyStr = String(item.quantity || 0);
        const qtyStrW = helvetica.widthOfTextAtSize(qtyStr, 10);
        page.drawText(qtyStr, { x: coCols.qty - qtyStrW, y, size: 10, font: helvetica, color: colors.textMuted });

        const ucStr = formatCurrency(Number(item.unitCost) || 0);
        const ucStrW = helvetica.widthOfTextAtSize(ucStr, 10);
        page.drawText(ucStr, { x: coCols.unitCost - ucStrW, y, size: 10, font: helvetica, color: colors.textMuted });

        const itemTotalStr = formatCurrency(Number(item.total) || 0);
        const itemTotalW = helveticaBold.widthOfTextAtSize(itemTotalStr, 10);
        page.drawText(itemTotalStr, { x: coCols.total - itemTotalW, y, size: 10, font: helveticaBold, color: colors.textMain });

        y -= 20;
    }

    // Total
    y -= 10;
    checkNewPage(80);
    page.drawLine({ start: { x: margin + contentWidth * 0.5, y }, end: { x: pageWidth - margin, y }, thickness: 0.5, color: colors.border });
    y -= 25;

    const coLabelX = coCols.unitCost - 60;
    const coTotal = Number(co.totalAmount) || 0;

    page.drawText('Change Order Total', { x: coLabelX, y, size: 14, font: helveticaBold, color: colors.primary });
    const coTotalStr = formatCurrency(coTotal);
    const coTotalW = helveticaBold.widthOfTextAtSize(coTotalStr, 14);
    page.drawText(coTotalStr, { x: coCols.total - coTotalW, y, size: 14, font: helveticaBold, color: colors.primary });

    // Signature
    if (co.status === 'Approved' && co.approvedBy) {
        y -= 50;
        checkNewPage(100);
        page.drawText('Approval', { x: margin, y, size: 11, font: helveticaBold, color: colors.textMain });
        y -= 20;
        page.drawText(`Approved By: ${co.approvedBy}`, { x: margin, y, size: 10, font: helveticaBold, color: colors.textMain });
        y -= 15;
        page.drawText(`Date: ${co.approvedAt ? new Date(co.approvedAt).toLocaleString() : '—'}`, { x: margin, y, size: 10, font: helvetica, color: colors.textMain });
    }

    const coFooterText = `Generated ${new Date().toLocaleDateString()} • ${company?.companyName || 'ProBuild'}`;
    page.drawText(coFooterText, { x: margin, y: 30, size: 7, font: helvetica, color: colors.textMuted });

    const pdfBytes = await doc.save();
    return Buffer.from(pdfBytes);
}
