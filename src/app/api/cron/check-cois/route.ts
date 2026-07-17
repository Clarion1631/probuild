import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendNotification } from "@/lib/email";
import { differenceInDays, startOfDay } from "date-fns";

export async function GET(request: Request) {
    try {
        const authHeader = request.headers.get("authorization");
        if (process.env.VERCEL_ENV === "production" && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }

        const subcontractors = await prisma.subcontractor.findMany({
            where: {
                status: "ACTIVE",
                coiExpiresAt: {
                    not: null
                }
            }
        });

        if (subcontractors.length === 0) {
            return NextResponse.json({ message: "No active subcontractors with COIs to check." }, { status: 200 });
        }

        const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
        const companyName = settings?.companyName || "Your Contractor";
        const companyEmail = settings?.notificationEmail;
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

        let sentCount = 0;
        const today = startOfDay(new Date());

        for (const sub of subcontractors) {
            if (!sub.coiExpiresAt || !sub.email) continue;

            const expirationDate = startOfDay(sub.coiExpiresAt);
            const daysLeft = differenceInDays(expirationDate, today);

            // Trigger reminders at 30 days, 7 days, and exact day of expiration
            if (daysLeft === 30 || daysLeft === 7 || daysLeft === 0) {
                const isExpired = daysLeft === 0;
                const statusText = isExpired ? "EXPIRED TODAY" : `Expiring in ${daysLeft} days`;
                
                const subject = `Action Required: Certificate of Insurance ${statusText}`;
                const body = `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <h2 style="color: #333;">Certificate of Insurance Alert</h2>
                    <p style="color: #444; line-height: 1.5;">
                        Hello ${sub.contactName || sub.companyName},
                    </p>
                    <p style="color: #444; line-height: 1.5;">
                        This is an automated reminder from <strong>${companyName}</strong> that your Certificate of Insurance on file is ${isExpired ? "<strong>now expired</strong>" : `set to expire on <strong>${expirationDate.toLocaleDateString()}</strong>`}.
                    </p>
                    <p style="color: #444; line-height: 1.5;">
                        To remain eligible for active and upcoming projects, please log in to your Subcontractor Portal to upload an updated certificate.
                    </p>
                    <div style="margin: 30px 0;">
                        <a href="${appUrl}/sub-portal" style="background-color: #4c9a2a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Go to Subcontractor Portal</a>
                    </div>
                </div>
                `;

                // Send to subcontractor
                await sendNotification(sub.email, subject, body);
                sentCount++;

                // Carbon copy the internal team
                if (companyEmail) {
                    await sendNotification(
                        companyEmail,
                        `[Internal Alert] Subcontractor COI ${statusText}: ${sub.companyName}`,
                        `<p>Subcontractor <strong>${sub.companyName}</strong> has a COI that ${isExpired ? "expired today" : `expires in ${daysLeft} days`}.</p><p>An automated reminder has been sent to them at ${sub.email}.</p>`
                    );
                }
            }
        }

        return NextResponse.json({ message: "Processed COI expirations", emailsSent: sentCount }, { status: 200 });

    } catch (error) {
        console.error("[Cron-COIs] Unhandled error:", error);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
