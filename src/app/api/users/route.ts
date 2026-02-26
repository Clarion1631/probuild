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

        // Try to send email
        if (process.env.RESEND_API_KEY) {
            try {
                const { data, error } = await resend.emails.send({
                    from: 'ProBuild <notifications@goldentouchremodeling.com>',
                    to: exactEmailLower,
                    subject: 'Invitation to ProBuild Team',
                    html: `<p>Hello${name ? ' ' + name : ''},</p><p>You have been invited to join the ProBuild team as a ${role}. Click <a href="${appUrl}">here</a> to log in with your Google account.</p>`
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
