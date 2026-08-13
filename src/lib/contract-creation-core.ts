import { revalidatePath as nextRevalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

// Session-free core of contract creation, shared by the permission-gated
// `createContractFromTemplate` / `createContractBlank` server actions in
// actions.ts and by the MCP `create_contract` tool
// (src/app/api/mcp/[transport]/route.ts), which authenticates callers via a
// shared secret rather than a NextAuth session. actions.ts is a server-action
// module, so every export there is a remotely invokable endpoint — auth-free
// logic must live here, NOT there, or the MCP tool would have to be forced
// through a session gate it can never satisfy. (This file deliberately
// carries no server-action directive.)
//
// The bodies of createContractFromTemplateCore and createContractBlankCore are
// moved verbatim from actions.ts; behavior is unchanged for every existing
// path.

// Cache revalidation is best-effort: it throws outside a Next request context
// (e.g. the MCP route's dynamic import path can run outside a render), and a
// stale cache page is never worth failing a contract creation whose row
// already committed. Failures are logged rather than silently dropped, so a
// real invalidation outage still shows up somewhere.
function revalidatePath(path: string) {
    try {
        nextRevalidatePath(path);
    } catch (err) {
        console.warn(`[Contract creation] revalidatePath(${path}) failed:`, err);
    }
}

export function resolveMergeFields(template: string, data: Record<string, string>): string {
    // Handle TipTap <span data-merge-field="key">...</span> nodes first
    let result = template.replace(/<span[^>]*data-merge-field="(\w+)"[^>]*>[\s\S]*?<\/span>/g,
        (match, key) => key in data ? data[key] : match);
    // Then handle raw {{key}} placeholders
    result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => key in data ? data[key] : match);
    return result;
}

// Save-time guard for the author↔portal signing-field handshake.
// The portal and PDF rendering locate signing blocks by grepping for the raw {{KEY}} form.
// If an un-normalized TipTap <span data-merge-field="KEY">…</span> ever reaches the saved
// body (editor bug, pasted content, template drift), the portal would find nothing and the
// signature fields would silently vanish for the customer. Normalizing any remaining
// merge-field spans back to {{KEY}} on save closes that failure class. (Data merge fields are
// already resolved to values before this runs; only unresolved/signing keys remain as spans.)
export function normalizeContractBody(body: string): string {
    return (body || "").replace(/<span[^>]*data-merge-field=["'](\w+)["'][^>]*>[\s\S]*?<\/span>/g, "{{$1}}");
}

export async function buildContractMergeData(projectId?: string | null, leadId?: string | null): Promise<Record<string, string>> {
    const settings = await prisma.companySettings.findUnique({ where: { id: "singleton" } });
    const data: Record<string, string> = {
        company_name: settings?.companyName || "Our Company",
        company_address: settings?.address || "",
        company_phone: settings?.phone || "",
        company_email: settings?.email || "",
        company_license: settings?.licenseNumber || "",
        company_website: settings?.website || "",
        date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
        year: new Date().getFullYear().toString(),
    };

    const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const populateFromEntity = (
        entity: { name: string; location?: string | null; number?: number; type?: string | null; projectType?: string | null },
        client: { name: string; email?: string | null; primaryPhone?: string | null; additionalEmail?: string | null; additionalPhone?: string | null; addressLine1?: string | null; city?: string | null; state?: string | null; zipCode?: string | null },
        estimates: { code: string; totalAmount: any; balanceDue: any; paymentSchedules?: { name: string; percentage?: number | null; amount: any; order: number }[] }[]
    ) => {
        data.project_name = entity.name;
        data.location = entity.location || "";
        if (!data.location) {
            const stateZip = [client.state, client.zipCode].filter(Boolean).join(" ");
            data.location = [client.addressLine1, client.city, stateZip].filter(Boolean).join(", ");
        }
        if (entity.number) data.project_number = `P-${entity.number}`;
        const entityType = entity.type || entity.projectType || null;
        if (entityType) data.project_type = entityType;

        data.client_name = client.name;
        data.client_email = client.email || "";
        data.client_phone = client.primaryPhone || "";
        const clientStateZip = [client.state, client.zipCode].filter(Boolean).join(" ");
        data.client_address = [client.addressLine1, client.city, clientStateZip].filter(Boolean).join(", ");
        data.client_additional_email = client.additionalEmail || "";
        data.client_additional_phone = client.additionalPhone || "";

        const est = estimates[0];
        if (est) {
            data.estimate_total = `$${Number(est.totalAmount).toLocaleString("en-US")}`;
            data.estimate_number = est.code;
            data.estimate_balance_due = `$${Number(est.balanceDue).toLocaleString("en-US")}`;
            if (est.paymentSchedules && est.paymentSchedules.length > 0) {
                const rows = est.paymentSchedules
                    .sort((a, b) => a.order - b.order)
                    .map((ps) => `<tr><td style="padding:4px 12px 4px 0;border-bottom:1px solid #e5e7eb;">${escHtml(ps.name)}</td><td style="padding:4px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${ps.percentage ? `${ps.percentage}%` : ""}</td><td style="padding:4px 0 4px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">$${Number(ps.amount).toLocaleString("en-US")}</td></tr>`)
                    .join("");
                data.payment_schedule = `<table style="width:100%;border-collapse:collapse;font-size:14px;"><thead><tr style="border-bottom:2px solid #333;"><th style="text-align:left;padding:4px 12px 4px 0;">Milestone</th><th style="text-align:right;padding:4px 12px;">%</th><th style="text-align:right;padding:4px 0 4px 12px;">Amount</th></tr></thead><tbody>${rows}</tbody></table>`;
            }
        }
        if (!est) {
            data.estimate_total = "$0.00";
            data.estimate_number = "";
            data.estimate_balance_due = "$0.00";
        }
    };

    const estimateInclude = { orderBy: { createdAt: "desc" as const }, take: 1, include: { paymentSchedules: { orderBy: { order: "asc" as const } } } };

    if (projectId) {
        const project = await prisma.project.findUnique({
            where: { id: projectId },
            include: { client: true, estimates: estimateInclude },
        });
        if (project) populateFromEntity(project, project.client, project.estimates);
    } else if (leadId) {
        const lead = await prisma.lead.findUnique({
            where: { id: leadId },
            include: { client: true, estimates: estimateInclude },
        });
        if (lead) populateFromEntity(lead, lead.client, lead.estimates);
    }

    return data;
}

export async function createContractFromTemplateCore(
    templateId: string,
    context: { type: "project" | "lead"; id: string },
    titleOverride?: string,
    recurringDays?: number
) {
    const template = await prisma.documentTemplate.findUnique({ where: { id: templateId } });
    if (!template) throw new Error("Template not found");

    const mergeData = await buildContractMergeData(
        context.type === "project" ? context.id : null,
        context.type === "lead" ? context.id : null
    );

    const resolvedBody = normalizeContractBody(resolveMergeFields(template.body, mergeData));
    const coSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" }, select: { requireContractCountersign: true } });

    const contract = await prisma.contract.create({
        data: {
            title: titleOverride || template.name,
            body: resolvedBody,
            // Recurring docs (e.g. lien releases) cycle status back to "Sent" each period and never
            // reach a stable "Signed" state, so they can't support countersign — force it off.
            requiresCountersign: (recurringDays && recurringDays > 0) ? false : (coSettings?.requireContractCountersign ?? false),
            ...(context.type === "project" ? { projectId: context.id } : { leadId: context.id }),
            ...(recurringDays && recurringDays > 0 ? {
                recurringDays,
                nextDueDate: new Date(Date.now() + recurringDays * 86400000),
            } : {}),
        }
    });

    if (context.type === "project") revalidatePath(`/projects/${context.id}`);
    if (context.type === "lead") revalidatePath(`/leads/${context.id}`);

    return contract;
}

export async function createContractBlankCore(
    context: { type: "project" | "lead"; id: string },
    title: string,
    body: string
) {
    const mergeData = await buildContractMergeData(
        context.type === "project" ? context.id : null,
        context.type === "lead" ? context.id : null
    );

    const resolvedBody = normalizeContractBody(resolveMergeFields(body, mergeData));
    const coSettings = await prisma.companySettings.findUnique({ where: { id: "singleton" }, select: { requireContractCountersign: true } });

    const contract = await prisma.contract.create({
        data: {
            title,
            body: resolvedBody,
            requiresCountersign: coSettings?.requireContractCountersign ?? false,
            ...(context.type === "project" ? { projectId: context.id } : { leadId: context.id }),
        }
    });

    if (context.type === "project") revalidatePath(`/projects/${context.id}`);
    if (context.type === "lead") revalidatePath(`/leads/${context.id}`);

    return contract;
}
