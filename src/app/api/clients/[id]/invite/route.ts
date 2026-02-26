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

        // Try to send email
        if (process.env.RESEND_API_KEY) {
            try {
                // Ensure the 'from' email is verified in Resend for the user's domain.
                // If not, we just catch the error and continue.
                await resend.emails.send({
                    from: 'ProBuild <notifications@goldentouchremodeling.com>',
                    to: emailToInvite,
                    subject: 'Invitation to Customer Portal',
                    html: `<p>Hello ${client.name},</p><p>You have been invited to view your project portal. Click <a href="${appUrl}">here</a> to log in with your Google account.</p>`
                });
            } catch (emailError) {
                console.error("Failed to send Resend email:", emailError);
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
