import { prisma } from "@/lib/prisma";

/**
 * Staff can send an estimate or payment request to an email typed into the
 * send dialog even when the Client record has none. QuickBooks only creates a
 * pay link when the invoice has a BillEmail, and ProBuild takes that from the
 * saved client email, so a never-saved address later means no pay link. After a
 * send really goes out, this saves the typed address, but only into a blank
 * field and never over an existing email.
 */
export function normalizeFillEmail(raw: string | null | undefined): string | null {
    const email = (raw ?? "").trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !email.includes("..") ? email : null;
}

/**
 * Best-effort: never throws, never overwrites a non-blank email (the WHERE
 * enforces that atomically). Returns true only when this call filled the field.
 */
export async function fillClientEmailIfBlank(
    clientId: string | null | undefined,
    email: string | null | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: { client: { updateMany(args: any): Promise<{ count: number }> } } = prisma,
): Promise<boolean> {
    const normalized = normalizeFillEmail(email);
    if (!clientId || !normalized) return false;
    try {
        const res = await db.client.updateMany({
            where: { id: clientId, OR: [{ email: null }, { email: "" }] },
            data: { email: normalized },
        });
        return res.count === 1;
    } catch (err) {
        console.error("[fillClientEmailIfBlank] failed to save client email:", err);
        return false;
    }
}
