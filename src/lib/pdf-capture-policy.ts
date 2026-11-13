/** A4 page width at 96 dpi. A browser screenshot of anything narrower gets magnified onto the page. */
export const PDF_CAPTURE_MIN_WIDTH_PX = 794;

/**
 * True when the estimate view is too narrow (a phone) for a browser screenshot to make a good PDF,
 * so the server-made PDF should be used instead. Unknown or zero widths keep the screenshot path.
 */
export function shouldUseServerPdf(elementWidth: number): boolean {
    return Number.isFinite(elementWidth) && elementWidth > 0 && elementWidth < PDF_CAPTURE_MIN_WIDTH_PX;
}
