/** The server PDF as a Blob only when the server answered 200 with a PDF; else null (the caller keeps the screenshot).
 *  A 15 second deadline covers the headers and the body; on abort the answer is null so the screenshot runs. */
export async function fetchExactServerPdf(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15000): Promise<Blob | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetchImpl(url, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
        if (!res.ok) return null;
        if (!(res.headers.get("content-type") || "").toLowerCase().includes("application/pdf")) return null;
        return await res.blob();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Save a Blob through a temporary link (same steps as the portal estimate page). */
export function saveBlobAs(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
