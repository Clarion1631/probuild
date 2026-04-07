import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Resend } from "resend";
import bcrypt from "bcryptjs";

const resend = new Resend(process.env.RESEND_API_KEY || "re_dummy");

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const currentUser = await prisma.user.findUnique({ where: { email: session.user.email } });
        if (!currentUser || !["MANAGER", "ADMIN"].includes(currentUser.role)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const users = await prisma.user.findMany({
            orderBy: [{ role: "asc" }, { name: "asc" }],
            select: {
                id: true, name: true, email: true, role: true, status: true,
                hourlyRate: true, burdenRate: true, pinCode: true, invitedAt: true,
                permissions: true,
                projectAccess: { select: { projectId: true } },
            },
        });

        // Never expose PIN hash to clients; replace with a boolean indicator
        const safeUsers = users.map(({ pinCode, ...u }) => ({ ...u, hasPin: !!pinCode }));
        return NextResponse.json(safeUsers);
    } catch (error: any) {
        console.error("GET /api/users error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const currentUser = await prisma.user.findUnique({ where: { email: session.user.email } });
        if (!currentUser || !["MANAGER", "ADMIN"].includes(currentUser.role)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const body = await req.json();
        const { name, email, role, hourlyRate, burdenRate, pinCode } = body;

        if (!email) return NextResponse.json({ error: "Email is required" }, { status: 400 });

        const exactEmailLower = email.toLowerCase().trim();
        const existingUser = await prisma.user.findUnique({ where: { email: exactEmailLower } });
        if (existingUser) return NextResponse.json({ error: "User with this email already exists" }, { status: 400 });

        const newUser = await prisma.user.create({
            data: {
                name: name || null,
                email: exactEmailLower,
                role: role || "FIELD_CREW",
                status: "PENDING",
                hourlyRate: Number(hourlyRate) || 0,
                burdenRate: Number(burdenRate) || 0,
                pinCode: pinCode ? await bcrypt.hash(pinCode, 10) : null,
                invitedAt: new Date(),
            },
        });

        // Create default permissions record
        await prisma.userPermission.create({ data: { userId: newUser.id } });

        // Auto-grant access to all existing projects if autoGrantNewProjects is default
        const allProjects = await prisma.project.findMany({ select: { id: true } });
        if (allProjects.length > 0) {
            await prisma.projectAccess.createMany({
                data: allProjects.map(p => ({ userId: newUser.id, projectId: p.id })),
                skipDuplicates: true,
            });
        }

        // Send invite email
        const appUrl = process.env.NEXTAUTH_URL || "https://probuild-amber.vercel.app";
        const loginUrl = `${appUrl}/login`;

        if (process.env.RESEND_API_KEY) {
            try {
                await resend.emails.send({
                    from: "ProBuild <notifications@goldentouchremodeling.com>",
                    to: exactEmailLower,
                    subject: "Invitation to ProBuild Team",
                    html: `
                    <!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; margin: 0; color: #0f172a; }
                        .container { padding: 40px 20px; max-width: 600px; margin: 0 auto; }
                        .card { background: #fff; border-radius: 12px; padding: 40px; text-align: center; box-shadow: 0 4px 6px -1px rgba(0,0,0,.1); border: 1px solid #e2e8f0; }
                        h1 { font-size: 24px; font-weight: 700; margin: 0 0 16px; }
                        p { font-size: 16px; line-height: 1.6; margin: 0 0 32px; color: #475569; }
                        .button { display: inline-block; background: #2563eb; color: #fff !important; font-weight: 600; font-size: 16px; text-decoration: none; padding: 14px 28px; border-radius: 8px; }
                    </style></head><body><div class="container"><div class="card">
                        <h1>Welcome to ProBuild</h1>
                        <p>Hello${name ? " " + name : ""},<br><br>You've been invited as a <strong>${role || "Field Crew"}</strong> member. Sign in with your Google account to get started.</p>
                        <a href="${loginUrl}" class="button">Access ProBuild</a>
                    </div></div></body></html>`,
                });
            } catch (e: any) {
                console.error("Email error:", e);
            }
        }

        return NextResponse.json(newUser, { status: 201 });
    } catch (error: any) {
        console.error("POST /api/users error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

// PATCH: update a user's role, status, or basic info
export async function PATCH(req: Request) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.email) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

        const currentUser = await prisma.user.findUnique({ where: { email: session.user.email } });
        if (!currentUser || !["MANAGER", "ADMIN"].includes(currentUser.role)) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const body = await req.json();
        const { id, name, role, status, hourlyRate, burdenRate, pinCode } = body;

        if (!id) return NextResponse.json({ error: "User id required" }, { status: 400 });

        const data: any = {};
        if (name !== undefined) data.name = name;
        if (role !== undefined) data.role = role;
        if (status !== undefined) data.status = status;
        if (hourlyRate !== undefined) data.hourlyRate = Number(hourlyRate);
        if (burdenRate !== undefined) data.burdenRate = Number(burdenRate);
        if (pinCode !== undefined) data.pinCode = pinCode ? await bcrypt.hash(pinCode, 10) : null;

        const { pinCode: _pin, ...user } = await prisma.user.update({
            where: { id },
            data,
            include: { permissions: true, projectAccess: { select: { projectId: true } } },
        });

        return NextResponse.json({ ...user, hasPin: !!_pin });
    } catch (error: any) {
        console.error("PATCH /api/users error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
