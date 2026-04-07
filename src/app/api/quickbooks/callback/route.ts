import { NextRequest, NextResponse } from "next/server";
import { exchangeQBCode } from "@/lib/quickbooks";
import { saveQBSettings } from "@/lib/integration-store";

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");
    const realmId = searchParams.get("realmId");
    const state = searchParams.get("state");
    const error = searchParams.get("error");
    const baseUrl = process.env.NEXTAUTH_URL || "https://probuild-amber.vercel.app";

    if (error) {
        return NextResponse.redirect(`${baseUrl}/settings/integrations/quickbooks?error=${encodeURIComponent(error)}`);
    }

    if (!code || !realmId) {
        return NextResponse.redirect(`${baseUrl}/settings/integrations/quickbooks?error=missing_code`);
    }

    // Validate CSRF state
    const expectedState = req.cookies.get("qb_oauth_state")?.value;
    if (!state || !expectedState || state !== expectedState) {
        return NextResponse.redirect(`${baseUrl}/settings/integrations/quickbooks?error=invalid_state`);
    }

    try {
        const baseUrl = process.env.NEXTAUTH_URL || "https://probuild-amber.vercel.app";
        const redirectUri = `${baseUrl}/api/quickbooks/callback`;

        const tokens = await exchangeQBCode(code, redirectUri);

        await saveQBSettings({
            connected: true,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            realmId,
            connectedAt: new Date().toISOString(),
        });

        const successResponse = NextResponse.redirect(`${baseUrl}/settings/integrations/quickbooks?success=1`);
        successResponse.cookies.delete("qb_oauth_state");
        return successResponse;
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        const baseUrl = process.env.NEXTAUTH_URL || "https://probuild-amber.vercel.app";
        return NextResponse.redirect(`${baseUrl}/settings/integrations/quickbooks?error=${encodeURIComponent(msg)}`);
    }
}
