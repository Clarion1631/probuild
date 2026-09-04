import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withPayrollUserWrite } from "@/lib/payroll-period";
import bcrypt from "bcryptjs";
import { signMobileToken } from "@/lib/mobile-auth";

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { email, pinCode } = body;

        if (!email || !pinCode) {
            return NextResponse.json({ error: "Email and PIN are required" }, { status: 400 });
        }

        const user = await prisma.user.findFirst({
            where: { email: email.toLowerCase() }
        });

        // Constant-time PIN verification (only meaningful when user.pinCode is set)
        const pinValid = user?.pinCode ? await bcrypt.compare(pinCode, user.pinCode) : false;
        if (!user || !pinValid || user.status === "DISABLED") {
            return NextResponse.json({ error: "Invalid email or PIN" }, { status: 401 });
        }

        // Mirror /api/mobile/google-login + NextAuth signIn callback: a successful first
        // sign-in flips PENDING -> ACTIVATED. Without this the PIN path is inconsistent
        // with Google and PENDING users would be silently auth'd without activation.
        if (user.status === "PENDING") {
            // ACTIVATION IS A PAYROLL WRITE. The Gusto roster is
            // "ACTIVATED and HOURLY" or "punched in the period", so this line
            // can ADD somebody to a pay period's file — and lockPayrollPeriod
            // hashes that file and freezes it. A transaction is opened purely
            // so the advisory lock has something to live in: outside one it
            // would be released before the update ran.
            await prisma.$transaction(async (tx) => {
                const data = { status: "ACTIVATED" };
                await withPayrollUserWrite(tx, data, () => tx.user.update({ where: { id: user.id }, data }));
            });
        }

        const token = await signMobileToken(user, "pin");

        return NextResponse.json({
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role
            },
            token
        });
    } catch (error: any) {
        console.error("Mobile login error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
