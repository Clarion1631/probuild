// Shared executed-contract finalization helpers.
//
// Used by BOTH the customer-facing finalize route
// (src/app/api/portal/contracts/[id]/finalize/route.ts) and the company
// countersignature action (countersignContractAsCompany in actions.ts) so the
// "archive the executed PDF" and "email the executed PDF" steps have exactly one
// implementation each — never a second writer for the same lifecycle event.
import { prisma } from "./prisma";
import { getSupabase, STORAGE_BUCKET } from "./supabase";
import { sendNotification } from "./email";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Canonical DB `name` of the executed-contract ProjectFile (matched exactly by getExecutedContractPdf). */
export function executedContractFileName(contractId: string): string {
  return `Executed_Contract_${contractId}.pdf`;
}

type ContractRef = { id: string; title: string; projectId: string | null; leadId: string | null };

/**
 * Upload an executed-contract PDF buffer to Storage and create the shared ProjectFile row.
 * The caller owns the contract status transition + rollback. Throws on failure so the
 * caller can roll back and best-effort remove the returned storagePath.
 */
export async function archiveExecutedContractPdf(
  contract: ContractRef,
  buffer: Buffer
): Promise<{ record: any; publicUrl: string; storagePath: string; fileName: string }> {
  const supabase = getSupabase();
  if (!supabase) throw new Error("Storage not configured.");

  const fileName = executedContractFileName(contract.id);
  const prefix = contract.projectId ? `projects/${contract.projectId}` : `leads/${contract.leadId}`;
  const storagePath = `${prefix}/${Date.now()}_${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, { contentType: "application/pdf", upsert: false });
  if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

  const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
  const publicUrl = urlData?.publicUrl || storagePath;

  let record;
  try {
    record = await prisma.projectFile.create({
      data: {
        name: fileName,
        url: publicUrl,
        size: buffer.length,
        mimeType: "application/pdf",
        visibility: "shared",
        ...(contract.projectId && { projectId: contract.projectId }),
        ...(contract.leadId && { leadId: contract.leadId }),
      },
    });
  } catch (e) {
    // The upload succeeded but the DB row failed — remove the orphaned storage object so a
    // retry doesn't leave a dangling executed PDF in the bucket.
    try { await supabase.storage.from(STORAGE_BUCKET).remove([storagePath]); } catch {}
    throw e;
  }
  return { record, publicUrl, storagePath, fileName };
}

/**
 * Send the "document executed" emails to the client (with CC + internal copy) and the company.
 * Identical body for both, mirroring the original inline implementation in the finalize route.
 */
export async function sendExecutedContractEmails(opts: {
  contractTitle: string;
  buffer: Buffer;
  fileName: string;
  publicUrl: string;
  clientEmail?: string | null;
  clientName?: string | null;
  cc?: string[];
  companyName: string;
  companyEmail?: string | null;
  replyTo?: string | null;
}): Promise<void> {
  const emailHtml = [
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head>',
    '<body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">',
    `<div style="text-align:center;margin-bottom:24px;"><h1 style="font-size:20px;font-weight:700;margin:0;">${esc(opts.companyName)}</h1></div>`,
    '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;">',
    `<h2 style="font-size:18px;margin:0 0 8px;color:#16a34a;">&#10003; Document Executed</h2>`,
    `<p style="color:#666;margin:0 0 16px;">Hi ${esc(opts.clientName || "Client")},</p>`,
    `<p style="color:#666;margin:0 0 16px;line-height:1.5;">Thank you! <strong>${esc(opts.contractTitle)}</strong> has been fully signed and executed. A PDF copy is attached and archived for your records.</p>`,
    `<div style="text-align:center;margin:0 0 16px;"><a href="${encodeURI(opts.publicUrl)}" target="_blank" style="display:inline-block;background:#222;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:15px;">Download PDF</a></div>`,
    '</div></body></html>',
  ].join('');

  if (opts.clientEmail) {
    await sendNotification(
      opts.clientEmail,
      `Document Executed: ${opts.contractTitle}`,
      emailHtml,
      [{ filename: opts.fileName, content: opts.buffer }],
      { fromName: opts.companyName, replyTo: opts.replyTo || undefined, cc: opts.cc, copyToInternal: true }
    );
  }

  if (opts.companyEmail) {
    await sendNotification(
      opts.companyEmail,
      `Executed Document: ${opts.contractTitle}`,
      emailHtml,
      [{ filename: opts.fileName, content: opts.buffer }],
      { fromName: "ProBuild Alerts" }
    );
  }
}
