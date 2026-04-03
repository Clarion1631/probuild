import { NextRequest, NextResponse } from "next/server";
import { exchangeQBCode } from "@/lib/quickbooks";
import { saveQBSettings } from "@/lib/integration-store";

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");
    const realmId = searchParams.get("realmId");
    const error = searchParams.get("error");

    if (error) {
        return NextResponse.redirect(`/settings/integrations/quickbooks?error=${encodeURIComponent(error)}`);
    }

    if (!code || !realmId) {
        return NextResponse.redirect("/settings/integrations/quickbooks?error=missing_code");
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

        return NextResponse.redirect(`${baseUrl}/settings/integrations/quickbooks?success=1`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        const baseUrl = process.env.NEXTAUTH_URL || "https://probuild-amber.vercel.app";
        return NextResponse.redirect(`${baseUrl}/settings/integrations/quickbooks?error=${encodeURIComponent(msg)}`);
    }
}
