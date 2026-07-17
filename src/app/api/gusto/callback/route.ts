import { NextRequest, NextResponse } from "next/server";
import { saveGustoSettings } from "@/lib/integration-store";

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const error = searchParams.get("error");
    const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";

    if (error) {
        return NextResponse.redirect(`${baseUrl}/settings/integrations/gusto?error=${encodeURIComponent(error)}`);
    }
    if (!code) {
        return NextResponse.redirect(`${baseUrl}/settings/integrations/gusto?error=missing_code`);
    }

    // Validate CSRF state
    const expectedState = req.cookies.get("gusto_oauth_state")?.value;
    if (!state || !expectedState || state !== expectedState) {
        return NextResponse.redirect(`${baseUrl}/settings/integrations/gusto?error=invalid_state`);
    }

    try {
        const clientId = process.env.GUSTO_CLIENT_ID!;
        const clientSecret = process.env.GUSTO_CLIENT_SECRET!;
        const redirectUri = `${baseUrl}/api/gusto/callback`;

        const res = await fetch("https://api.gusto.com/oauth/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
            }),
        });

        if (!res.ok) throw new Error("Token exchange failed");
        const data = await res.json();

        // Fetch company ID
        const meRes = await fetch("https://api.gusto.com/v1/me", {
            headers: { Authorization: `Bearer ${data.access_token}` },
        });
        const me = meRes.ok ? await meRes.json() : {};
        const companyId = me.roles?.payroll_admin?.companies?.[0]?.id || "";

        await saveGustoSettings({
            connected: true,
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            companyId: String(companyId),
            connectedAt: new Date().toISOString(),
        });

        const successResponse = NextResponse.redirect(`${baseUrl}/settings/integrations/gusto?success=1`);
        successResponse.cookies.delete("gusto_oauth_state");
        return successResponse;
    } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return NextResponse.redirect(`${baseUrl}/settings/integrations/gusto?error=${encodeURIComponent(msg)}`);
    }
}
