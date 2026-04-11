import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";
import { sendNotification } from "@/lib/email";
import { resolveSessionClientId } from "@/lib/portal-auth";

// Allow larger uploads (50MB) and longer processing times for PDF Generation
export const maxDuration = 60;

export async function POST(
    req: NextRequest,
    context: { params: Promise<{ id: string }> }
) {
    try {
        const resolvedParams = await context.params;
        const { id } = resolvedParams;

        if (!id) {
            return NextResponse.json({ error: "Missing contract ID" }, { status: 400 });
        }

        const supabase = getSupabase();
        if (!supabase) {
            return NextResponse.json({ error: "Storage not configured." }, { status: 500 });
        }

        // Ownership gate — caller must present either a matching accessToken (magic-link
        // path, no session required) or a portal session whose email resolves to exactly
        // one Client row that owns the lead/project. Missing/mismatched auth collapses
        // into 404 so we don't leak existence. Duplicate-email collisions are refused
        // by resolveSessionClientId returning null.
        const tokenFromQuery = req.nextUrl.searchParams.get("token");
        const sessionClientId = await resolveSessionClientId();

        const ownershipClauses: any[] = [];
        if (tokenFromQuery) ownershipClauses.push({ accessToken: tokenFromQuery });
        if (sessionClientId) {
            ownershipClauses.push({ lead: { clientId: sessionClientId } });
            ownershipClauses.push({ project: { clientId: sessionClientId } });
        }
        if (ownershipClauses.length === 0) {
            return NextResponse.json({ error: "Contract not found" }, { status: 404 });
        }

        const contract = await prisma.contract.findFirst({
            where: {
                id,
                OR: ownershipClauses,
            },
            include: {
                project: { select: { id: true, name: true, client: { select: { name: true, email: true } } } },
                lead: { select: { id: true, name: true, client: { select: { name: true, email: true } } } }
            }
        });

        if (!contract) {
            return NextResponse.json({ error: "Contract not found" }, { status: 404 });
        }

        // Only accept finalization for contracts that have been signed
        if (contract.status !== "Signed") {
            return NextResponse.json({ error: "Contract has not been signed" }, { status: 403 });
        }

        let formData;
        try {
            formData = await req.formData();
        } catch (parseErr: any) {
            console.error("FormData parse error:", parseErr);
            return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
        }

        const pdfBlob = formData.get("pdf") as File | null;
        if (!pdfBlob) {
            return NextResponse.json({ error: "No PDF file attached" }, { status: 400 });
        }

        const bytes = await pdfBlob.arrayBuffer();
        const buffer = Buffer.from(bytes);

        // Upload to Supabase Bucket.
        // Filename embeds the contractId so lookups can unambiguously map a PDF back
        // to its contract even when titles collide. `getExecutedContractPdf` matches
        // on `contains: "_Executed_Contract_{id}."`.
        const prefix = contract.projectId ? `projects/${contract.projectId}` : `leads/${contract.leadId}`;
        const safeName = `Executed_Contract_${contract.id}.pdf`;
        const storagePath = `${prefix}/${Date.now()}_${safeName}`;

        const { data: uploadData, error: uploadError } = await supabase.storage
            .from(STORAGE_BUCKET)
            .upload(storagePath, buffer, {
                contentType: "application/pdf",
                upsert: false,
            });

        if (uploadError) {
            console.error("Supabase upload error:", uploadError);
            return NextResponse.json({ error: `Storage upload failed: ${uploadError.message}` }, { status: 500 });
        }

        // Generate public URL
        const { data: urlData } = supabase.storage
            .from(STORAGE_BUCKET)
            .getPublicUrl(storagePath);

        const publicUrl = urlData?.publicUrl || storagePath;

        // Mark contract as Finalized to prevent duplicate submissions
        await prisma.contract.update({
            where: { id },
            data: { status: "Finalized" }
        });

        // Archive as a Project File in the database
        const record = await prisma.projectFile.create({
            data: {
                name: safeName,
                url: publicUrl,
                size: buffer.length,
                mimeType: "application/pdf",
                ...(contract.projectId && { projectId: contract.projectId }),
                ...(contract.leadId && { leadId: contract.leadId }),
            }
        });

        // Resolve client/company details for email
        const clientEmail = contract.project?.client?.email || contract.lead?.client?.email;
        const clientName = contract.project?.client?.name || contract.lead?.client?.name || "Client";
        const companySettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
        const companyEmail = companySettings?.notificationEmail || companySettings?.email;
        const companyName = companySettings?.companyName || "ProBuild";

        // Construct standard receipt HTML
        const emailHtml = `
            <!DOCTYPE html>
            <html>
            <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333 text-align: center;">
                <div style="text-align: center; margin-bottom: 32px;">
                    <h1 style="font-size: 24px; font-weight: 700; margin: 0;">${companyName}</h1>
                </div>
                <div style="background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px; text-align: left;">
                    <h2 style="font-size: 20px; margin: 0 0 8px; color: #16a34a;">✓ Document Executed</h2>
                    <p style="color: #666; margin: 0 0 24px;">Hi ${clientName},</p>
                    <p style="color: #666; line-height: 1.6;">
                        Thank you! <strong>${contract.title}</strong> has been successfully electronically signed and finalized.
                    </p>
                    <p style="color: #666; line-height: 1.6;">
                        A permanent PDF copy has been attached to this email and archived securely for your records.
                    </p>
                    <div style="text-align: center; margin: 32px 0;">
                        <a href="${publicUrl}" target="_blank" style="display: inline-block; background: #222; color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px;">
                            Download PDF Receipt
                        </a>
                    </div>
                </div>
            </body>
            </html>
        `;

        // Send Email to Client
        if (clientEmail) {
            await sendNotification(
                clientEmail,
                `Document Executed: ${contract.title}`,
                emailHtml,
                [{
                    filename: safeName,
                    content: buffer
                }],
                {
                    fromName: companyName,
                    replyTo: companyEmail || undefined,
                }
            );
        }

        // Send Email to Company
        if (companyEmail) {
            await sendNotification(
                companyEmail,
                `Client Signed Document: ${contract.title}`,
                emailHtml,
                [{
                    filename: safeName,
                    content: buffer
                }],
                {
                    fromName: "ProBuild Alerts",
                }
            );
        }

        return NextResponse.json({ success: true, file: record }, { status: 200 });

    } catch (err: any) {
        console.error("Finalize Contract Error:", err);
        return NextResponse.json({ error: err.message || "Failed to finalize contract" }, { status: 500 });
    }
}
