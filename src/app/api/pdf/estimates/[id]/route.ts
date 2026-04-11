import { NextRequest, NextResponse } from "next/server";

/**
 * Redirects to the portal estimate page where the client can use the
 * "Download PDF" button — which produces a portal-quality html-to-image PDF.
 *
 * Kept as a route for backward compatibility (e.g. any links that point here).
 * The portal page handles both browser users and the capture-mode iframe.
 */
export async function GET(
    req: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    const { id } = await context.params;

    if (!id) {
        return NextResponse.json({ error: "Missing ID" }, { status: 400 });
    }

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `${req.nextUrl.protocol}//${req.nextUrl.host}`;
    return NextResponse.redirect(`${baseUrl}/portal/estimates/${id}`, { status: 302 });
}
