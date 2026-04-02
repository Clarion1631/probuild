import { NextRequest, NextResponse } from "next/server";
import { gmail } from "@/lib/gmail-client";
import { prisma } from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export async function POST(
    req: NextRequest,
    context: { params: Promise<{ id: string; poId: string }> }
) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { poId } = await context.params;

    try {
        const bodyJSON = await req.json();
        const { body } = bodyJSON;

        if (!body) return NextResponse.json({ error: "Body missing" }, { status: 400 });

        const po = await prisma.purchaseOrder.findUnique({
            where: { id: poId },
            include: { vendor: true }
        });

        if (!po || !po.vendor || !po.vendor.email) {
            return NextResponse.json({ error: "PO or Vendor Email not found" }, { status: 404 });
        }

        // Send via Gmail
        const subject = `Purchase Order Update: ${po.code}`;
        const to = po.vendor.email;
        const from = `Purchase Orders <purchaseorders@goldentouchremodeling.com>`;

        const messageParts = [
            `From: ${from}`,
            `To: ${to}`,
            `Content-Type: text/plain; charset=utf-8`,
            `MIME-Version: 1.0`,
            `Subject: ${subject}`,
            '',
            body,
            '',
            `--`,
            `Project: ${po.projectId}`,
        ];
        
        const message = messageParts.join('\n');
        // The body needs to be base64url encoded
        const encodedMessage = Buffer.from(message)
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

        await gmail.users.messages.send({
            userId: 'me',
            requestBody: {
                raw: encodedMessage,
            },
        });

        // Add to our DB
        await prisma.purchaseOrderMessage.create({
            data: {
                purchaseOrderId: poId,
                body: body,
                senderEmail: session.user.email,
                senderName: session.user.name || "Team Member",
                senderType: "TEAM",
            }
        });
        
        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error("Send Message Route Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
