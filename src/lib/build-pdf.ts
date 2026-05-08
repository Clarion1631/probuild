export interface BuildPdfOptions {
    bannerText?: string;
    pixelRatio?: number;
    quality?: number;
}

export async function buildPdf(
    element: HTMLElement,
    options: BuildPdfOptions = {}
): Promise<import("jspdf").jsPDF> {
    const { toJpeg } = await import("html-to-image");
    const { jsPDF } = await import("jspdf");

    const { bannerText, pixelRatio = 2, quality = 0.95 } = options;

    const pdf = new jsPDF("p", "mm", "a4");
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const marginBottom = 6;
    const bannerH = 8;
    const usableH = pageH - marginBottom;
    const effectiveH = usableH - bannerH;

    // Step 1: Measure row positions BEFORE rendering. Filter rules:
    // - Skip elements with [data-pdf-skip] (e.g. action buttons not meant to be captured)
    // - Skip elements whose ancestor is also marked as a row (prevents nested-row
    //   shrinkage: a paragraph fits, then its child button shows a smaller bottom
    //   and breaks land inside the paragraph)
    const elTop = element.getBoundingClientRect().top + window.scrollY;
    const cssToMm = pageW / element.offsetWidth;
    const totalHeightMm = element.offsetHeight * cssToMm;

    const allRowEls = Array.from(element.querySelectorAll("[data-pdf-row]")) as HTMLElement[];
    const rowEls = allRowEls.filter(el => {
        if (el.closest("[data-pdf-skip]")) return false;
        let parent = el.parentElement;
        while (parent && parent !== element) {
            if (parent.hasAttribute("data-pdf-row")) return false;
            parent = parent.parentElement;
        }
        return true;
    });
    const rowsMm = rowEls.map(row => {
        const r = row.getBoundingClientRect();
        return {
            top:    (r.top    + window.scrollY - elTop) * cssToMm,
            bottom: (r.bottom + window.scrollY - elTop) * cssToMm,
        };
    });

    // Step 2: Find safe page-break points (always between rows)
    const breaks: number[] = [0];
    let cursor = 0;
    while (cursor < totalHeightMm) {
        const limit = cursor + effectiveH;
        if (limit >= totalHeightMm) break;

        let safeBreak = limit;
        let lastFitBottom = cursor;
        let anyRowFit = false;
        for (const row of rowsMm) {
            if (row.top <= cursor) continue;
            if (row.bottom <= limit) {
                lastFitBottom = Math.max(lastFitBottom, row.bottom);
                anyRowFit = true;
            } else {
                // Row overflows. If any row fit on this page, break after the last
                // one. If none fit (oversized first row), fall back to the fixed
                // page advance to avoid 1mm-at-a-time pathological pagination.
                safeBreak = anyRowFit ? lastFitBottom : limit;
                break;
            }
        }
        if (safeBreak <= cursor) safeBreak = limit;
        breaks.push(safeBreak);
        cursor = safeBreak;
    }
    breaks.push(totalHeightMm);

    // Step 3: Render full element at high resolution. Filter excludes
    // [data-pdf-skip] subtrees from the captured image.
    const imgData = await toJpeg(element, {
        quality,
        pixelRatio,
        filter: (node: HTMLElement) =>
            !(node.nodeType === 1 && node.hasAttribute && node.hasAttribute("data-pdf-skip")),
    });

    const img = new Image();
    img.src = imgData;
    await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("img load failed"));
    });

    const pxPerMm = img.width / pageW;
    const totalPages = breaks.length - 1;

    // Step 4: Slice at safe break points and add pages
    for (let page = 0; page < totalPages; page++) {
        if (page > 0) pdf.addPage();

        const startMm = breaks[page];
        const sliceHMm = breaks[page + 1] - startMm;
        const srcY = Math.round(startMm * pxPerMm);
        const srcH = Math.round(sliceHMm * pxPerMm);

        const slice = document.createElement("canvas");
        slice.width  = img.width;
        slice.height = Math.max(1, srcH);
        const ctx = slice.getContext("2d")!;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(img, 0, srcY, img.width, srcH, 0, 0, img.width, srcH);

        const contentY = page > 0 ? bannerH : 0;
        pdf.addImage(slice.toDataURL("image/jpeg", 0.92), "JPEG", 0, contentY, pageW, sliceHMm);

        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(7);
        pdf.setTextColor(180, 180, 180);
        pdf.text(`Page ${page + 1} of ${totalPages}`, pageW / 2, pageH - 1.5, { align: "center" });

        if (page > 0 && bannerText) {
            pdf.setFillColor(248, 249, 250);
            pdf.rect(0, 0, pageW, 8, "F");
            pdf.setDrawColor(220, 220, 220);
            pdf.line(0, 8, pageW, 8);
            pdf.setFont("helvetica", "bold");
            pdf.setFontSize(7);
            pdf.setTextColor(110, 110, 110);
            pdf.text(bannerText, pageW / 2, 5, { align: "center" });
        }
    }

    return pdf;
}
