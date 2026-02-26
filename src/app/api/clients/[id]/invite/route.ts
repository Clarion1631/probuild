import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || 're_dummy');

export async function POST(
    request: Request,
    props: { params: Promise<{ id: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session || !session.user?.email) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const params = await props.params;
        const clientId = params.id;

        const client = await prisma.client.findUnique({
            where: { id: clientId }
        });

        if (!client) {
            return NextResponse.json({ error: "Client not found" }, { status: 404 });
        }

        if (!client.email) {
            return NextResponse.json({ error: "Client has no email address" }, { status: 400 });
        }

        const emailToInvite = client.email.toLowerCase();

        // Check if user already exists
        let user = await prisma.user.findUnique({
            where: { email: emailToInvite }
        });

        if (!user) {
            // Create user with CLIENT role
            user = await prisma.user.create({
                data: {
                    email: emailToInvite,
                    name: client.name,
                    role: "CLIENT",
                }
            });
        }

        const appUrl = process.env.NEXTAUTH_URL || 'https://probuild-amber.vercel.app';
        const loginUrl = `${appUrl}/login`;

        // Try to send email
        if (process.env.RESEND_API_KEY) {
            try {
                // Ensure the 'from' email is verified in Resend for the user's domain.
                // If not, we just catch the error and continue.
                const { data, error } = await resend.emails.send({
                    from: 'ProBuild <notifications@goldentouchremodeling.com>',
                    to: emailToInvite,
                    subject: 'Invitation to Customer Portal',
                    html: `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>Join ProBuild</title>
                        <style>
                            body { font-family: -apple-system, BlinkMacMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol"; background-color: #f8fafc; margin: 0; padding: 0; color: #0f172a; }
                            .container { padding: 40px 20px; max-width: 600px; margin: 0 auto; }
                            .card { background-color: #ffffff; border-radius: 12px; padding: 40px; text-align: center; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); border: 1px solid #e2e8f0; }
                            .logo { width: 48px; height: 48px; background-color: #0f172a; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 24px; }
                            .logo svg { display: block; margin: auto; padding-top: 12px; }
                            h1 { font-size: 24px; font-weight: 700; margin: 0 0 16px; color: #0f172a; letter-spacing: -0.025em; }
                            p { font-size: 16px; line-height: 1.6; margin: 0 0 32px; color: #475569; }
                            .button { display: inline-block; background-color: #2563eb; color: #ffffff !important; font-weight: 600; font-size: 16px; text-decoration: none; padding: 14px 28px; border-radius: 8px; transition: background-color 0.2s; }
                            .button:hover { background-color: #1d4ed8; }
                            .footer { margin-top: 32px; font-size: 14px; color: #94a3b8; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="card">
                                <div class="logo">
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>
                                </div>
                                <h1>Welcome to ProBuild</h1>
                                <p>Hello ${client.name},<br><br>You have been invited to view your project portal. Please click the button below to sign in instantly with your Google account.</p>
                                <a href="${loginUrl}" class="button">Access Customer Portal</a>
                            </div>
                            <div class="footer text-center">
                                &copy; ${new Date().getFullYear()} ProBuild. All rights reserved.
                            </div>
                        </div>
                    </body>
                    </html>
                    `
                });

                if (error) {
                    console.error("Resend API returned error:", error);
                    return NextResponse.json({ error: "Failed to send email: " + error.message }, { status: 400 });
                }
            } catch (emailError: any) {
                console.error("Failed to send Resend email:", emailError);
                return NextResponse.json({ error: "Exception sending email: " + emailError.message }, { status: 500 });
            }
        } else {
            console.log(`[DEV MODE] Invite email would be sent to ${emailToInvite}: Login at ${appUrl}`);
        }

        return NextResponse.json({ success: true, user });

    } catch (error: any) {
        console.error("Invite Error:", error);
        return NextResponse.json({ error: "Internal Server Error", details: error.message }, { status: 500 });
    }
}
