import { jsPDF } from 'jspdf';
import { prisma } from './prisma';

export async function generateEstimatePdf(estimateId: string): Promise<Buffer> {
    const estimate = await prisma.estimate.findUnique({
        where: { id: estimateId },
        include: {
            items: { orderBy: { order: 'asc' } },
            paymentSchedules: { orderBy: { order: 'asc' } },
            project: {
                include: {
                    client: true,
                },
            },
            lead: true,
        },
    });

    if (!estimate) throw new Error('Estimate not found');

    // Fetch company info for header
    const company = await prisma.companyInfo.findFirst();

    const doc = new jsPDF({ unit: 'pt', format: 'letter' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 50;
    const contentWidth = pageWidth - margin * 2;
    let y = margin;

    // Colors
    const primaryColor: [number, number, number] = [79, 70, 229]; // indigo-600
    const textMain: [number, number, number] = [15, 23, 42]; // slate-900
    const textMuted: [number, number, number] = [100, 116, 139]; // slate-500
    const borderColor: [number, number, number] = [226, 232, 240]; // slate-200

    // --- Header accent bar ---
    doc.setFillColor(...primaryColor);
    doc.rect(0, 0, pageWidth, 6, 'F');
    y = 40;

    // --- Company Name ---
    if (company?.name) {
        doc.setFontSize(11);
        doc.setTextColor(...textMuted);
        doc.text(company.name.toUpperCase(), margin, y);
    }

    // --- Title ---
    y += 30;
    doc.setFontSize(26);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textMain);
    doc.text(estimate.title || 'Estimate', margin, y);

    // --- Estimate Info Box ---
    y += 30;
    doc.setFontSize(9);
    doc.setTextColor(...textMuted);

    // Left: Client info
    const clientName = estimate.project?.client?.name || estimate.lead?.name || '';
    const clientEmail = estimate.project?.client?.email || estimate.lead?.email || '';
    doc.setFont('helvetica', 'bold');
    doc.text('ESTIMATE TO', margin, y);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(...textMain);
    if (clientName) { y += 16; doc.text(clientName, margin, y); }
    if (clientEmail) { y += 14; doc.setFontSize(9); doc.setTextColor(...textMuted); doc.text(clientEmail, margin, y); }

    // Right: Estimate # and Date
    const rightX = pageWidth - margin;
    let ry = y - (clientEmail ? 30 : 16);
    doc.setFontSize(9);
    doc.setTextColor(...textMuted);
    doc.text('Estimate No.', rightX - 140, ry);
    doc.setTextColor(...textMain);
    doc.setFont('helvetica', 'bold');
    doc.text(estimate.code || '', rightX, ry, { align: 'right' });
    ry += 16;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...textMuted);
    doc.text('Date', rightX - 140, ry);
    doc.setTextColor(...textMain);
    doc.text(new Date(estimate.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }), rightX, ry, { align: 'right' });
    ry += 16;
    doc.setTextColor(...textMuted);
    doc.text('Status', rightX - 140, ry);
    doc.setTextColor(...textMain);
    doc.text(estimate.status || 'Draft', rightX, ry, { align: 'right' });

    // --- Line Items Table ---
    y += 30;

    // Separator
    doc.setDrawColor(...borderColor);
    doc.setLineWidth(0.5);
    doc.line(margin, y, pageWidth - margin, y);
    y += 20;

    // Table header
    const cols = {
        name: margin,
        qty: margin + contentWidth * 0.55,
        unitCost: margin + contentWidth * 0.68,
        total: pageWidth - margin,
    };

    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...textMuted);
    doc.text('ITEM DESCRIPTION', cols.name, y);
    doc.text('QTY', cols.qty, y, { align: 'right' });
    doc.text('UNIT COST', cols.unitCost + 40, y, { align: 'right' });
    doc.text('TOTAL', cols.total, y, { align: 'right' });

    y += 8;
    doc.setDrawColor(...borderColor);
    doc.line(margin, y, pageWidth - margin, y);
    y += 14;

    // Table rows — client-facing: only show unitCost (sell price), not baseCost/markup
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);

    for (const item of estimate.items) {
        // Check if we need a new page
        if (y > doc.internal.pageSize.getHeight() - 100) {
            doc.addPage();
            y = margin;
        }

        const isSubItem = !!item.parentId;
        const nameX = isSubItem ? cols.name + 16 : cols.name;

        doc.setTextColor(...textMain);
        doc.setFont('helvetica', isSubItem ? 'normal' : 'bold');
        doc.text(item.name || '', nameX, y, { maxWidth: contentWidth * 0.5 });

        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...textMuted);
        doc.text(String(item.quantity || 0), cols.qty, y, { align: 'right' });

        doc.text(
            `$${(item.unitCost || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            cols.unitCost + 40, y, { align: 'right' }
        );

        doc.setTextColor(...textMain);
        doc.setFont('helvetica', 'bold');
        doc.text(
            `$${(item.total || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            cols.total, y, { align: 'right' }
        );
        doc.setFont('helvetica', 'normal');

        y += 20;
    }

    // --- Totals ---
    y += 10;
    doc.setDrawColor(...borderColor);
    doc.line(margin + contentWidth * 0.5, y, pageWidth - margin, y);
    y += 20;

    const subtotal = estimate.items.reduce((sum, item) => sum + (item.total || 0), 0);
    const tax = subtotal * 0.087;
    const total = subtotal + tax;

    // Subtotal
    doc.setFontSize(10);
    doc.setTextColor(...textMuted);
    doc.text('Subtotal', cols.unitCost - 20, y);
    doc.setTextColor(...textMain);
    doc.text(`$${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, cols.total, y, { align: 'right' });
    y += 18;

    // Tax
    doc.setTextColor(...textMuted);
    doc.text('Estimated Tax (8.7%)', cols.unitCost - 20, y);
    doc.setTextColor(...textMain);
    doc.text(`$${tax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, cols.total, y, { align: 'right' });
    y += 22;

    // Total line
    doc.setDrawColor(...borderColor);
    doc.line(cols.unitCost - 30, y - 6, pageWidth - margin, y - 6);

    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...primaryColor);
    doc.text('Total', cols.unitCost - 20, y + 8);
    doc.text(`$${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, cols.total, y + 8, { align: 'right' });

    // --- Payment Schedule ---
    if (estimate.paymentSchedules.length > 0) {
        y += 50;
        if (y > doc.internal.pageSize.getHeight() - 120) { doc.addPage(); y = margin; }

        doc.setFontSize(11);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...textMain);
        doc.text('Payment Schedule', margin, y);
        y += 20;

        doc.setFontSize(9);
        for (const sched of estimate.paymentSchedules) {
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(...textMain);
            doc.text(sched.name || '', margin, y);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(...textMuted);
            const schedAmount = sched.amount ? `$${sched.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '';
            const schedPct = sched.percentage ? `${sched.percentage}%` : '';
            doc.text(`${schedPct}  ${schedAmount}`, margin + contentWidth * 0.5, y);
            if (sched.dueDate) {
                doc.text(new Date(sched.dueDate).toLocaleDateString(), cols.total, y, { align: 'right' });
            }
            y += 18;
        }
    }

    // --- Footer ---
    const footerY = doc.internal.pageSize.getHeight() - 30;
    doc.setFontSize(7);
    doc.setTextColor(...textMuted);
    doc.text(`Generated ${new Date().toLocaleDateString()} • ${company?.name || 'ProBuild'}`, margin, footerY);
    doc.text('Page 1', pageWidth - margin, footerY, { align: 'right' });

    // Convert to Buffer
    const arrayBuffer = doc.output('arraybuffer');
    return Buffer.from(arrayBuffer);
}
