import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

const colors = {
    primary: rgb(76 / 255, 154 / 255, 42 / 255),     // hui-primary #4c9a2a
    textMain: rgb(34 / 255, 34 / 255, 34 / 255),      // #222
    textMuted: rgb(102 / 255, 102 / 255, 102 / 255),  // #666
    border: rgb(225 / 255, 228 / 255, 232 / 255),     // #e1e4e8
    bgLight: rgb(248 / 255, 249 / 255, 250 / 255),    // #f8f9fa
    white: rgb(1, 1, 1),
    blue: rgb(59 / 255, 130 / 255, 246 / 255),
    red: rgb(239 / 255, 68 / 255, 68 / 255),
    amber: rgb(245 / 255, 158 / 255, 11 / 255),
};

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ projectId: string }> }
) {
    const { projectId } = await params;

    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { name: true, client: { select: { name: true } } },
    });

    if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const logs = await prisma.dailyLog.findMany({
        where: { projectId },
        orderBy: { date: "desc" },
        include: {
            createdBy: { select: { name: true, email: true } },
            photos: true,
        },
    });

    const company = await prisma.companySettings.findUnique({ where: { id: "singleton" } });

    const doc = await PDFDocument.create();
    const helvetica = await doc.embedFont(StandardFonts.Helvetica);
    const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);

    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 50;
    const contentWidth = pageWidth - margin * 2;

    let page = doc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;
    let pageNum = 1;

    function checkNewPage(needed: number = 80) {
        if (y < needed) {
            // Footer on current page
            drawFooter();
            page = doc.addPage([pageWidth, pageHeight]);
            y = pageHeight - margin;
            pageNum++;
        }
    }

    function drawFooter() {
        const footerText = `Generated ${new Date().toLocaleDateString()} • ${company?.companyName || "ProBuild"}`;
        page.drawText(footerText, {
            x: margin, y: 30, size: 7, font: helvetica, color: colors.textMuted,
        });
        const pageLabel = `Page ${pageNum}`;
        const labelWidth = helvetica.widthOfTextAtSize(pageLabel, 7);
        page.drawText(pageLabel, {
            x: pageWidth - margin - labelWidth, y: 30, size: 7, font: helvetica, color: colors.textMuted,
        });
    }

    function drawWrappedText(text: string, x: number, startY: number, maxWidth: number, fontSize: number, font: typeof helvetica, color: typeof colors.textMain): number {
        const words = text.split(/\s+/);
        let currentLine = "";
        let currentY = startY;

        for (const word of words) {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            const testWidth = font.widthOfTextAtSize(testLine, fontSize);
            if (testWidth > maxWidth && currentLine) {
                checkNewPage(60);
                page.drawText(currentLine, { x, y: currentY, size: fontSize, font, color });
                currentY -= fontSize + 4;
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        }
        if (currentLine) {
            checkNewPage(60);
            page.drawText(currentLine, { x, y: currentY, size: fontSize, font, color });
            currentY -= fontSize + 4;
        }
        return currentY;
    }

    // === Cover header ===
    page.drawRectangle({
        x: 0, y: pageHeight - 6, width: pageWidth, height: 6,
        color: colors.primary,
    });
    y -= 10;

    if (company?.companyName) {
        page.drawText(company.companyName.toUpperCase(), {
            x: margin, y, size: 11, font: helvetica, color: colors.textMuted,
        });
        y -= 24;
    }

    page.drawText("DAILY LOG REPORT", {
        x: margin, y, size: 24, font: helveticaBold, color: colors.textMain,
    });
    y -= 22;

    page.drawText(project.name, {
        x: margin, y, size: 14, font: helvetica, color: colors.primary,
    });
    y -= 18;

    if (project.client?.name) {
        page.drawText(`Client: ${project.client.name}`, {
            x: margin, y, size: 10, font: helvetica, color: colors.textMuted,
        });
        y -= 16;
    }

    page.drawText(`${logs.length} log entries • Generated ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`, {
        x: margin, y, size: 9, font: helvetica, color: colors.textMuted,
    });

    y -= 20;
    page.drawLine({
        start: { x: margin, y }, end: { x: pageWidth - margin, y },
        thickness: 1, color: colors.primary,
    });
    y -= 30;

    // === Log entries ===
    for (const log of logs) {
        checkNewPage(160);

        // Date header bar
        page.drawRectangle({
            x: margin, y: y - 2, width: contentWidth, height: 22,
            color: colors.bgLight,
        });
        page.drawRectangle({
            x: margin, y: y - 2, width: 4, height: 22,
            color: colors.primary,
        });

        const dateStr = new Date(log.date).toLocaleDateString("en-US", {
            weekday: "long", year: "numeric", month: "long", day: "numeric",
        });
        page.drawText(dateStr, {
            x: margin + 12, y: y + 3, size: 11, font: helveticaBold, color: colors.textMain,
        });

        // Right-aligned author
        const authorStr = `by ${log.createdBy.name || log.createdBy.email}`;
        const authorWidth = helvetica.widthOfTextAtSize(authorStr, 8);
        page.drawText(authorStr, {
            x: pageWidth - margin - authorWidth - 8, y: y + 4, size: 8, font: helvetica, color: colors.textMuted,
        });

        y -= 30;

        // Weather & Crew row
        if (log.weather || log.crewOnSite) {
            const parts: string[] = [];
            if (log.weather) parts.push(`Weather: ${log.weather}`);
            if (log.crewOnSite) {
                const crewCount = log.crewOnSite.split(",").filter((s: string) => s.trim()).length;
                parts.push(`Crew (${crewCount}): ${log.crewOnSite}`);
            }
            y = drawWrappedText(parts.join("  |  "), margin + 4, y, contentWidth - 8, 9, helvetica, colors.blue);
            y -= 4;
        }

        // Work Performed
        checkNewPage(60);
        page.drawText("WORK PERFORMED", {
            x: margin + 4, y, size: 8, font: helveticaBold, color: colors.textMuted,
        });
        y -= 14;
        y = drawWrappedText(log.workPerformed, margin + 4, y, contentWidth - 8, 9, helvetica, colors.textMain);
        y -= 6;

        // Materials
        if (log.materialsDelivered) {
            checkNewPage(60);
            page.drawText("MATERIALS DELIVERED", {
                x: margin + 4, y, size: 8, font: helveticaBold, color: colors.amber,
            });
            y -= 14;
            y = drawWrappedText(log.materialsDelivered, margin + 4, y, contentWidth - 8, 9, helvetica, colors.textMain);
            y -= 6;
        }

        // Issues
        if (log.issues) {
            checkNewPage(60);
            page.drawText("⚠ ISSUES / DELAYS", {
                x: margin + 4, y, size: 8, font: helveticaBold, color: colors.red,
            });
            y -= 14;
            y = drawWrappedText(log.issues, margin + 4, y, contentWidth - 8, 9, helvetica, colors.textMain);
            y -= 6;
        }

        // Photos count
        if (log.photos.length > 0) {
            checkNewPage(40);
            page.drawText(`📷 ${log.photos.length} photo(s) attached`, {
                x: margin + 4, y, size: 8, font: helvetica, color: colors.textMuted,
            });
            y -= 14;
        }

        // Separator
        y -= 6;
        page.drawLine({
            start: { x: margin, y }, end: { x: pageWidth - margin, y },
            thickness: 0.5, color: colors.border,
        });
        y -= 20;
    }

    // Footer on last page
    drawFooter();

    const pdfBytes = await doc.save();
    const buffer = Buffer.from(pdfBytes);

    return new NextResponse(buffer, {
        headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="daily-logs-${project.name.replace(/\s+/g, "-")}.pdf"`,
        },
    });
}
