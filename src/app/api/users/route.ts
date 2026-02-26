import { NextResponse } from "next/server";
export const dynamic = 'force-dynamic';
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || 're_dummy');

export async function GET(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // Must be manager or admin to see all users
        const currentUser = await prisma.user.findUnique({
            where: { email: session.user.email }
        });

        if (!currentUser || (currentUser.role !== 'MANAGER' && currentUser.role !== 'ADMIN')) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const users = await prisma.user.findMany({
            orderBy: { name: 'asc' },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                hourlyRate: true,
                burdenRate: true,
                pinCode: true,
            }
        });

        return NextResponse.json(users);
    } catch (error: any) {
        console.error("GET /api/users error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        // Must be manager or admin to add users
        const currentUser = await prisma.user.findUnique({
            where: { email: session.user.email }
        });

        if (!currentUser || (currentUser.role !== 'MANAGER' && currentUser.role !== 'ADMIN')) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const body = await req.json();
        const { name, email, role, hourlyRate, burdenRate, pinCode } = body;

        if (!email) {
            return NextResponse.json({ error: "Email is required" }, { status: 400 });
        }

        const exactEmailLower = email.toLowerCase().trim();

        // Check if user already exists
        const existingUser = await prisma.user.findUnique({
            where: { email: exactEmailLower }
        });

        if (existingUser) {
            return NextResponse.json({ error: "User with this email already exists" }, { status: 400 });
        }

        const newUser = await prisma.user.create({
            data: {
                name: name || null,
                email: exactEmailLower,
                role: role || 'EMPLOYEE',
                hourlyRate: Number(hourlyRate) || 0,
                burdenRate: Number(burdenRate) || 0,
                pinCode: pinCode || null
            }
        });

        const appUrl = process.env.NEXTAUTH_URL || 'https://probuild-amber.vercel.app';
        const loginUrl = `${appUrl}/login`;

        // Try to send email
        if (process.env.RESEND_API_KEY) {
            try {
                const { data, error } = await resend.emails.send({
                    from: 'ProBuild <notifications@goldentouchremodeling.com>',
                    to: exactEmailLower,
                    subject: 'Invitation to ProBuild Team',
                    html: `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="utf-8">
                        <meta name="viewport" content="width=device-width, initial-scale=1.0">
                        <title>Join ProBuild</title>
                        <style>
                            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol"; background-color: #f8fafc; margin: 0; padding: 0; color: #0f172a; }
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
                                <p>Hello${name ? ' ' + name : ''},<br><br>You have been invited to join the ProBuild team as a <strong>${role}</strong>. Please click the button below to sign in instantly with your Google account.</p>
                                <a href="${loginUrl}" class="button">Access Your Portal</a>
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
                    // We still return 201 because the user was created, but we can pass the error warning
                    return NextResponse.json({ ...newUser, warning: "User created but email failed to send: " + error.message }, { status: 201 });
                }
            } catch (emailError: any) {
                console.error("Failed to send Resend email:", emailError);
            }
        } else {
            console.log(`[DEV MODE] Team Invite email would be sent to ${exactEmailLower}: Login at ${appUrl}`);
        }

        return NextResponse.json(newUser, { status: 201 });
    } catch (error: any) {
        console.error("POST /api/users error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
