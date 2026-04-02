import { NextRequest, NextResponse } from "next/server";
import { oauth2Client, saveToken } from "@/lib/gmail-client";

export async function GET(req: NextRequest) {
    const code = req.nextUrl.searchParams.get("code");
    
    if (!code) {
        // Initial request, redirect to Google Auth URL
        const { getAuthUrl } = await import("@/lib/gmail-client");
        return NextResponse.redirect(getAuthUrl());
    }

    try {
        // Exchange code for tokens
        const { tokens } = await oauth2Client.getToken(code);
        
        // Save tokens locally
        saveToken(tokens);
        
        return new NextResponse(`
            <html>
                <body>
                    <h2>Gmail Authorization Successful!</h2>
                    <p>The server has successfully received the tokens.</p>
                    <p>Refresh Token: <b>${tokens.refresh_token}</b></p>
                    <p style="color: red;">Copy the Refresh Token above and paste it securely into your Vercel Environment Variables as <code>GMAIL_REFRESH_TOKEN</code>.</p>
                    <p>You may now close this tab.</p>
                </body>
            </html>
        `, { headers: { 'Content-Type': 'text/html' }});
    } catch (error) {
        console.error("Error exchanging auth code:", error);
        return NextResponse.json({ error: "Failed to exchange auth token" }, { status: 500 });
    }
}
