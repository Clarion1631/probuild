import { NextResponse } from "next/server";

const GUSTO_AUTH_URL = "https://api.gusto.com/oauth/authorize";
const SCOPES = "employees:read payrolls:read";

export async function GET() {
    const clientId = process.env.GUSTO_CLIENT_ID;
    if (!clientId) {
        return NextResponse.json({ error: "GUSTO_CLIENT_ID not configured in Vercel" }, { status: 500 });
    }

    const baseUrl = process.env.NEXTAUTH_URL || "https://probuild-amber.vercel.app";
    const redirectUri = `${baseUrl}/api/gusto/callback`;

    const url = new URL(GUSTO_AUTH_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");

    return NextResponse.redirect(url.toString());
}
