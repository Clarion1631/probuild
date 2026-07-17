import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { sendNotification } from '@/lib/email';

export async function GET(req: Request) {
    try {
        const cronSecret = process.env.CRON_SECRET;
        if (!cronSecret) {
            console.error("CRON_SECRET is not configured");
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const authHeader = req.headers.get('authorization');
        if (authHeader !== `Bearer ${cronSecret}`) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const now = new Date();

        // 1. Find all active Contracts that have a recurring component due for signature
        const dueContracts = await prisma.contract.findMany({
            where: {
                status: "Signed", // Has been initially accepted
                recurringDays: { not: null },
                OR: [
                    { nextDueDate: null }, // Never generated
                    { nextDueDate: { lte: now } } // Past due
                ]
            },
            include: {
                project: { select: { name: true, client: { select: { email: true, name: true } } } },
                lead: { select: { name: true, client: { select: { email: true, name: true } } } }
            }
        });

        const createdRecords = [];

        // 2. Spawn Signing Records & Email Clients
        for (const contract of dueContracts) {
            if (!contract.recurringDays) continue;

            const clientEmail = contract.project?.client?.email || contract.lead?.client?.email;
            const clientName = contract.project?.client?.name || contract.lead?.client?.name || "Client";
            
            // Generate a secure one-time period record
            const periodStart = contract.nextDueDate || now;
            const periodEnd = new Date(periodStart);
            periodEnd.setDate(periodEnd.getDate() + contract.recurringDays);

            // Keep historical archive of current signature
            if (contract.approvedBy) {
                await prisma.contractSigningRecord.create({
                    data: {
                        contractId: contract.id,
                        signedBy: contract.approvedBy,
                        signedAt: contract.approvedAt || now,
                        signatureUrl: contract.signatureUrl,
                        userAgent: contract.approvalUserAgent,
                        notes: `Archived automatically for period ending ${now.toLocaleDateString()}`
                    }
                });
            }

            // Atomic first-mint of accessToken — the read-then-update pattern is racy
            // with `sendContractToClient`. `updateMany` gated on `accessToken IS NULL`
            // ensures only the first writer mints; subsequent writers re-read the
            // canonical value. See matching logic in `sendContractToClient`.
            if (!contract.accessToken) {
                const candidate = crypto.randomUUID();
                await prisma.contract.updateMany({
                    where: { id: contract.id, accessToken: null },
                    data: { accessToken: candidate },
                });
            }
            const minted = await prisma.contract.findUnique({
                where: { id: contract.id },
                select: { accessToken: true },
            });
            const cycleToken = minted?.accessToken;
            if (!cycleToken) {
                console.error(`[recurring-docs] Failed to mint access token for contract ${contract.id}`);
                continue;
            }

            // Reset Contract for next signature period (does NOT touch accessToken —
            // the atomic mint above handles that so no writer can clobber another).
            await prisma.contract.update({
                where: { id: contract.id },
                data: {
                    status: "Sent",
                    approvedBy: null,
                    approvedAt: null,
                    signatureUrl: null,
                    nextDueDate: periodEnd,
                }
            });

            // Dispatch Notification Email only if we have an email
            if (clientEmail) {
                const portalUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/portal/contracts/${contract.id}?token=${cycleToken}`;
                const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                const companyLogo = settings?.logoUrl || "";
                const companyLicense = settings?.licenseNumber || "";
                const companyName = settings?.companyName || 'ProBuild';

                const brandHeader = `
                    <div style="text-align: center; margin-bottom: 32px;">
                        ${companyLogo
                            ? `<img src="${companyLogo}" alt="${companyName}" style="max-height: 64px; width: auto; margin: 0 auto 12px; display: block;" />`
                            : ""}
                        <h1 style="font-size: 22px; font-weight: 700; margin: 0; color: #0f172a;">${companyName}</h1>
                        ${companyLicense
                            ? `<p style="font-size: 12px; color: #64748b; margin: 4px 0 0;">Lic# ${companyLicense}</p>`
                            : ""}
                    </div>`;

                await sendNotification(
                    clientEmail,
                    `Action Required: Monthly Document Ready to Sign - ${contract.title}`,
                    `<!DOCTYPE html>
                    <html>
                    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333;">
                        ${brandHeader}
                        <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px;">
                            <h2 style="font-size: 20px; margin: 0 0 8px;">Action Required: Signature Needed</h2>
                            <p style="color: #666; margin: 0 0 24px;">Hi ${clientName},</p>
                            <p style="color: #666; line-height: 1.6;">
                                It's time to sign your upcoming <strong>${contract.title}</strong> for the current billing period.
                            </p>
                            <div style="text-align: center; margin: 32px 0;">
                                <a href="${portalUrl}" style="display: inline-block; background: #222; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                                    View in Portal
                                </a>
                            </div>
                            <p style="color: #999; font-size: 13px; text-align: center;">
                                Or copy this link: ${portalUrl}
                            </p>
                        </div>
                    </body>
                    </html>`,
                    undefined,
                    { fromName: companyName, replyTo: settings?.email || undefined }
                );
            }

            createdRecords.push(contract.id);
        }

        return NextResponse.json({
            status: "success",
            processedRecordsCount: dueContracts.length,
            createdRecords
        });
    } catch (error) {
        console.error("CRON Error processing recurring docs:", error);
        const msg = error instanceof Error ? error.message : "Unknown error";
        return NextResponse.json({ error: msg }, { status: 500 });
    }
}
