import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";
import { sendNotification } from "@/lib/email";
import { resolveSessionClientId } from "@/lib/portal-auth";
import { archiveExecutedContractPdf, sendExecutedContractEmails } from "@/lib/contract-finalize";
import { PDFDocument } from "pdf-lib";
import { appendContractCountersignaturePage } from "@/lib/pdf";

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
                project: { select: { id: true, name: true, client: { select: { name: true, email: true, additionalEmail: true } }, manager: { select: { email: true } } } },
                lead: { select: { id: true, name: true, client: { select: { name: true, email: true, additionalEmail: true } }, manager: { select: { email: true } } } }
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

        // ─── PDF Contract Flow ───
        if (contract.originalPdfPath) {
            if (contract.requiresCountersign) {
                if (contract.companySignedAt) {
                    return NextResponse.json({ success: true, awaitingCountersign: true });
                }
                if (contract.signedPdfPath) {
                    return NextResponse.json({ success: true, awaitingCountersign: true });
                }

                await prisma.contract.update({
                    where: { id: contract.id },
                    data: { signedPdfPath: contract.originalPdfPath },
                });

                try {
                    const cSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                    const notifyEmail = cSettings?.notificationEmail || cSettings?.email;
                    if (notifyEmail) {
                        const cClientName = contract.project?.client?.name || contract.lead?.client?.name || "The client";
                        const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
                        const directUrl = contract.projectId
                            ? `${appUrl}/projects/${contract.projectId}/contracts`
                            : `${appUrl}/leads/${contract.leadId}/contracts`;
                        await sendNotification(
                            notifyEmail,
                            `Ready to countersign: ${contract.title}`,
                            `<p><strong>${cClientName}</strong> has signed "<strong>${contract.title}</strong>". It's ready for your countersignature to finalize.</p><p><a href="${directUrl}">Open ProBuild to countersign</a></p>`,
                            undefined,
                            { fromName: "ProBuild Alerts" }
                        );
                    }
                } catch (notifyErr) {
                    console.error("[finalize] countersign-ready notification failed (non-fatal):", notifyErr);
                }
                return NextResponse.json({ success: true, awaitingCountersign: true });
            }

            let record: any = null;
            let committed = false;
            let storagePathUploaded: string | null = null;
            try {
                const { data: dl, error: dlErr } = await supabase.storage.from(STORAGE_BUCKET).download(contract.originalPdfPath);
                if (dlErr || !dl) throw new Error("Could not load original PDF contract");
                const originalBuffer = Buffer.from(await dl.arrayBuffer());

                const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                const ip = contract.approvalIp || "0.0.0.0";
                const clientOnlyPdf = await appendContractCountersignaturePage(originalBuffer, {
                    companyName: settings?.companyName || "Company",
                    contractTitle: contract.title,
                    clientSignedBy: contract.approvedBy,
                    clientSignedAt: contract.approvedAt,
                    clientIp: ip,
                    clientSignatureValue: contract.signatureUrl,
                    companySignedBy: contract.contractorSignedBy || undefined,
                    companySignedAt: contract.contractorSignedAt || undefined,
                    companyIp: contract.contractorSignedAt ? "Stored" : undefined,
                    companySignatureValue: contract.contractorSignatureUrl || undefined,
                });

                const archived = await archiveExecutedContractPdf(
                    { id: contract.id, title: contract.title, projectId: contract.projectId, leadId: contract.leadId },
                    clientOnlyPdf
                );
                record = archived.record;
                storagePathUploaded = archived.storagePath;
                
                await prisma.contract.update({
                    where: { id: contract.id },
                    data: { status: "Finalized" },
                });
                committed = true;

                const clientEmail = contract.project?.client?.email || contract.lead?.client?.email;
                const clientAdditionalEmail = contract.project?.client?.additionalEmail || contract.lead?.client?.additionalEmail;
                const clientName = contract.project?.client?.name || contract.lead?.client?.name || "Client";
                const managerEmail = contract.project?.manager?.email || contract.lead?.manager?.email || null;
                const companySettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                const companyEmail = companySettings?.notificationEmail || companySettings?.email;
                const companyName = companySettings?.companyName || "ProBuild";

                const ccMap = new Map<string, string>();
                for (const e of [clientAdditionalEmail, managerEmail]) {
                    const t = e?.trim();
                    if (t && t.toLowerCase() !== (clientEmail || "").toLowerCase()) ccMap.set(t.toLowerCase(), t);
                }
                const ccList = ccMap.size ? [...ccMap.values()] : undefined;

                try {
                    await sendExecutedContractEmails({
                        contractTitle: contract.title,
                        buffer: clientOnlyPdf,
                        fileName: archived.fileName,
                        publicUrl: archived.publicUrl,
                        clientEmail,
                        clientName,
                        cc: ccList,
                        companyName,
                        companyEmail,
                        replyTo: companySettings?.email,
                    });
                } catch (emailErr) {
                    console.error("[finalize] executed-doc email failed (non-fatal):", emailErr);
                }

                return NextResponse.json({ success: true, file: record }, { status: 200 });

            } catch (err: any) {
                console.error("Finalize PDF Contract Error:", err);
                if (!committed && storagePathUploaded) {
                    try {
                        await supabase.storage.from(STORAGE_BUCKET).remove([storagePathUploaded]);
                    } catch {}
                }
                return NextResponse.json({ error: err.message || "Failed to finalize PDF contract" }, { status: 500 });
            }
        }

        // ─── Countersign-required branch (plan B.5) ───
        // If this contract needs a company countersignature and the company hasn't signed
        // yet, do NOT finalize. Store the client-signed PDF privately and leave status
        // "Signed" so countersignContractAsCompany can later append the company signature and
        // produce the executed copy. The customer sees an "awaiting countersignature" state.
        if (contract.requiresCountersign) {
            // The company has already countersigned (or countersign is mid-flight). Producing the
            // executed PDF is countersignContractAsCompany's job — NEVER fall through to the normal
            // archive below, which would finalize a client-only copy missing the company signature.
            if (contract.companySignedAt) {
                return NextResponse.json({ success: true, awaitingCountersign: true });
            }
            let cFormData;
            try { cFormData = await req.formData(); }
            catch { return NextResponse.json({ error: "Invalid form data" }, { status: 400 }); }
            const cPdf = cFormData.get("pdf") as File | null;
            if (!cPdf) return NextResponse.json({ error: "No PDF file attached" }, { status: 400 });
            const cBuffer = Buffer.from(await cPdf.arrayBuffer());

            // Validate the PDF is loadable NOW, so the later countersign step (which appends a page
            // via pdf-lib) can never be permanently blocked by a corrupt stored intermediate.
            try { await PDFDocument.load(cBuffer); }
            catch { return NextResponse.json({ error: "The signed PDF could not be read. Please try again." }, { status: 400 }); }

            const cPrefix = contract.projectId ? `projects/${contract.projectId}` : `leads/${contract.leadId}`;
            const intermediatePath = `${cPrefix}/intermediate/${Date.now()}_Signed_Contract_${contract.id}.pdf`;
            const { error: cUpErr } = await supabase.storage
                .from(STORAGE_BUCKET)
                .upload(intermediatePath, cBuffer, { contentType: "application/pdf", upsert: false });
            if (cUpErr) {
                return NextResponse.json({ error: `Storage upload failed: ${cUpErr.message}` }, { status: 500 });
            }

            // Atomically claim the slot — only the first POST (signedPdfPath still null) wins.
            // A concurrent double-submit loses here: it removes its just-uploaded object and skips
            // the company notification, so we never orphan storage or double-notify.
            let claim;
            try {
                claim = await prisma.contract.updateMany({
                    where: { id: contract.id, signedPdfPath: null },
                    data: { signedPdfPath: intermediatePath },
                });
            } catch (claimErr) {
                // DB threw between upload and claim — remove the orphaned upload before bubbling up.
                try { await supabase.storage.from(STORAGE_BUCKET).remove([intermediatePath]); } catch {}
                throw claimErr;
            }
            if (claim.count === 0) {
                try { await supabase.storage.from(STORAGE_BUCKET).remove([intermediatePath]); } catch {}
                return NextResponse.json({ success: true, awaitingCountersign: true });
            }

            // Nudge the company that a contract is ready to countersign (best-effort).
            try {
                const cSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
                const notifyEmail = cSettings?.notificationEmail || cSettings?.email;
                if (notifyEmail) {
                    const cClientName = contract.project?.client?.name || contract.lead?.client?.name || "The client";
                    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
                    const directUrl = contract.projectId
                        ? `${appUrl}/projects/${contract.projectId}/contracts`
                        : `${appUrl}/leads/${contract.leadId}/contracts`;
                    await sendNotification(
                        notifyEmail,
                        `Ready to countersign: ${contract.title}`,
                        `<p><strong>${cClientName}</strong> has signed "<strong>${contract.title}</strong>". It's ready for your countersignature to finalize.</p><p><a href="${directUrl}">Open ProBuild to countersign</a></p>`,
                        undefined,
                        { fromName: "ProBuild Alerts" }
                    );
                }
            } catch (notifyErr) {
                console.error("[finalize] countersign-ready notification failed (non-fatal):", notifyErr);
            }
            return NextResponse.json({ success: true, awaitingCountersign: true });
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

            // Archive the executed PDF (upload + shared ProjectFile) via the shared helper —
            // the same code path countersignContractAsCompany uses, so there is one writer.
            const archived = await archiveExecutedContractPdf(
                { id: contract.id, title: contract.title, projectId: contract.projectId, leadId: contract.leadId },
                buffer
            );
            record = archived.record;
            publicUrl = archived.publicUrl;
            storagePathUploaded = archived.storagePath;
            safeName = archived.fileName;
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

        // Resolve client/company details for the executed-doc emails.
        const clientEmail = contract.project?.client?.email || contract.lead?.client?.email;
        const clientAdditionalEmail = contract.project?.client?.additionalEmail || contract.lead?.client?.additionalEmail;
        const clientName = contract.project?.client?.name || contract.lead?.client?.name || "Client";
        const managerEmail = contract.project?.manager?.email || contract.lead?.manager?.email || null;
        const companySettings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
        const companyEmail = companySettings?.notificationEmail || companySettings?.email;
        const companyName = companySettings?.companyName || "ProBuild";

        // CC the durable stakeholders (client's additional email + assigned manager), deduped
        // against the primary recipient.
        const ccMap = new Map<string, string>();
        for (const e of [clientAdditionalEmail, managerEmail]) {
            const t = e?.trim();
            if (t && t.toLowerCase() !== (clientEmail || "").toLowerCase()) ccMap.set(t.toLowerCase(), t);
        }
        const ccList = ccMap.size ? [...ccMap.values()] : undefined;

        // Best-effort — the contract is already finalized + archived; an email hiccup must not
        // turn that into a 500 (the retry path would skip resending against a Finalized contract).
        try {
            await sendExecutedContractEmails({
                contractTitle: contract.title,
                buffer,
                fileName: safeName,
                publicUrl,
                clientEmail,
                clientName,
                cc: ccList,
                companyName,
                companyEmail,
                replyTo: companySettings?.email,
            });
        } catch (emailErr) {
            console.error("[finalize] executed-doc email failed (non-fatal):", emailErr);
        }

        return NextResponse.json({ success: true, file: record }, { status: 200 });

    } catch (err: any) {
        console.error("Finalize Contract Error:", err);
        return NextResponse.json({ error: err.message || "Failed to finalize contract" }, { status: 500 });
    }
}
