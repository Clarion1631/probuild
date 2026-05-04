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
                project: { select: { id: true, name: true, client: { select: { name: true, email: true, additionalEmail: true } } } },
                lead: { select: { id: true, name: true, client: { select: { name: true, email: true, additionalEmail: true } } } }
            }
        });

        if (!contract) {
            return NextResponse.json({ error: "Contract not found" }, { status: 404 });
        }

        // Only accept finalization for contracts that have been signed
        if (contract.status !== "Signed") {
            // Already finalized? Return the existing file so a stuck retry from the
            // client browser (e.g. a second submit before navigation) doesn't fail.
            if (contract.status === "Finalized") {
                const existingFile = await prisma.projectFile.findFirst({
                    where: {
                        ...(contract.projectId ? { projectId: contract.projectId } : { leadId: contract.leadId! }),
                        name: `Executed_Contract_${contract.id}.pdf`,
                        mimeType: "application/pdf",
                    },
                    orderBy: { createdAt: "desc" },
                });
                if (existingFile) {
                    return NextResponse.json({ success: true, file: existingFile, alreadyFinalized: true });
                }
            }
            return NextResponse.json({ error: "Contract has not been signed" }, { status: 403 });
        }

        // ─── Atomic Signed → Finalized transition (Codex peer review blocker #2) ───
        // Before this guard, two concurrent finalize POSTs could both pass the
        // `status !== "Signed"` check above, both upload PDFs to Supabase, both
        // create ProjectFile rows, then both flip status to Finalized — leaving
        // orphan files and duplicate DB records. Fix: race on a conditional
        // `updateMany` BEFORE any side effects. Only the caller whose update
        // actually matches a `Signed` row proceeds. Losers fall through to the
        // idempotent existing-file response.
        const transition = await prisma.contract.updateMany({
            where: { id, status: "Signed" },
            data: { status: "Finalized" },
        });
        if (transition.count === 0) {
            const existingFile = await prisma.projectFile.findFirst({
                where: {
                    ...(contract.projectId ? { projectId: contract.projectId } : { leadId: contract.leadId! }),
                    name: `Executed_Contract_${contract.id}.pdf`,
                    mimeType: "application/pdf",
                },
                orderBy: { createdAt: "desc" },
            });
            if (existingFile) {
                return NextResponse.json({ success: true, file: existingFile, alreadyFinalized: true });
            }
            return NextResponse.json({ error: "Contract is not in a signable state" }, { status: 409 });
        }

        // ─── Codex round-2 blocker: uncaught post-transition paths ───
        // Before this wrapper, operations between the state flip and the
        // ProjectFile.create could throw in ways the explicit-try blocks didn't
        // catch (e.g. `pdfBlob.arrayBuffer()` on a corrupt stream, an aborted
        // request surfacing mid-upload, Supabase client panics). The outer
        // function-level catch at the bottom returns 500 but does NOT roll back
        // status, so the contract wedges `Finalized` with no file. Fix: wrap the
        // whole post-transition pipeline in one try/catch; only mark `committed`
        // after ProjectFile.create returns, and in `catch` unconditionally roll
        // back status + best-effort remove any uploaded storage object.
        let record: any = null;
        let buffer: Buffer = Buffer.alloc(0);
        let safeName = `Executed_Contract_${contract.id}.pdf`;
        let publicUrl = "";
        let committed = false;
        let storagePathUploaded: string | null = null;
        try {
            let formData;
            try {
                formData = await req.formData();
            } catch (parseErr: any) {
                console.error("FormData parse error:", parseErr);
                // Rollback in finally via `committed === false`.
                throw new Error("Invalid form data");
            }

            const pdfBlob = formData.get("pdf") as File | null;
            if (!pdfBlob) {
                throw new Error("No PDF file attached");
            }

            const bytes = await pdfBlob.arrayBuffer();
            buffer = Buffer.from(bytes);

            // Upload to Supabase Bucket.
            // Filename embeds the contractId so lookups can unambiguously map a PDF back
            // to its contract even when titles collide. `getExecutedContractPdf` matches
            // on exact-equality with `Executed_Contract_{id}.pdf`.
            const prefix = contract.projectId ? `projects/${contract.projectId}` : `leads/${contract.leadId}`;
            const storagePath = `${prefix}/${Date.now()}_${safeName}`;

            const { error: uploadError } = await supabase.storage
                .from(STORAGE_BUCKET)
                .upload(storagePath, buffer, {
                    contentType: "application/pdf",
                    upsert: false,
                });

            if (uploadError) {
                console.error("Supabase upload error:", uploadError);
                throw new Error(`Storage upload failed: ${uploadError.message}`);
            }
            storagePathUploaded = storagePath;

            // Generate public URL
            const { data: urlData } = supabase.storage
                .from(STORAGE_BUCKET)
                .getPublicUrl(storagePath);

            publicUrl = urlData?.publicUrl || storagePath;

            // Archive as a Project File in the database. Status is ALREADY Finalized
            // from the conditional transition above — do not update it again here.
            record = await prisma.projectFile.create({
                data: {
                    name: safeName,
                    url: publicUrl,
                    size: buffer.length,
                    mimeType: "application/pdf",
                    ...(contract.projectId && { projectId: contract.projectId }),
                    ...(contract.leadId && { leadId: contract.leadId }),
                }
            });
            committed = true;
        } catch (pipelineErr: any) {
            console.error("Finalize pipeline error:", pipelineErr);
            if (!committed) {
                // Roll the contract back to Signed so the user can retry.
                await prisma.contract.updateMany({
                    where: { id, status: "Finalized" },
                    data: { status: "Signed" },
                });
                // Best-effort cleanup of any uploaded storage object so a retry
                // doesn't leave orphans.
                if (storagePathUploaded) {
                    try {
                        await supabase.storage.from(STORAGE_BUCKET).remove([storagePathUploaded]);
                    } catch {}
                }
            }
            const msg = pipelineErr?.message ?? String(pipelineErr);
            // Map the sentinel strings we threw above back to their status codes.
            if (msg === "Invalid form data") {
                return NextResponse.json({ error: msg }, { status: 400 });
            }
            if (msg === "No PDF file attached") {
                return NextResponse.json({ error: msg }, { status: 400 });
            }
            return NextResponse.json({ error: `Failed to finalize contract: ${msg}` }, { status: 500 });
        }

        // Resolve client/company details for email
        const clientEmail = contract.project?.client?.email || contract.lead?.client?.email;
        const clientAdditionalEmail = contract.project?.client?.additionalEmail || contract.lead?.client?.additionalEmail;
        const clientName = contract.project?.client?.name || contract.lead?.client?.name || "Client";
        const ccList = clientAdditionalEmail ? [clientAdditionalEmail] : undefined;
        const companySettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
        const companyEmail = companySettings?.notificationEmail || companySettings?.email;
        const companyName = companySettings?.companyName || "ProBuild";

        // Construct standard receipt HTML
        const emailHtml = `
            <!DOCTYPE html>
            <html>
            <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #333; text-align: center;">
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
                    cc: ccList,
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
