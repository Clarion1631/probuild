import { NextRequest } from "next/server";
import { getSessionOrDev } from "@/lib/auth";
import { verifyClientPortalToken } from "@/lib/client-portal-auth";
import { resolveSessionClientId } from "@/lib/portal-auth";
import { isStaffAccountEnabled } from "@/lib/staff-status";

// Shared auth for the /api/pdf/* document routes. The proxy gates most of them,
// but these handlers must not rely on that boundary alone: /api/pdf/invoices is
// proxy-bypassed for portal clients, and NODE_ENV=development skips the proxy
// entirely. Each route decides its own entitlement rule from these two facts.
// getSessionOrDev keeps local `npm run dev` (which has no real session) working;
// in production it is getServerSession.

export async function isStaffRequest(): Promise<boolean> {
    const session = await getSessionOrDev();
    const email = session?.user?.email;
    return Boolean(email && await isStaffAccountEnabled(email));
}

export async function getPortalClientId(req: NextRequest): Promise<string | null> {
    const token = req.nextUrl.searchParams.get("token") || req.cookies.get("client_portal_token")?.value;
    if (token) {
        const payload = await verifyClientPortalToken(token);
        if (payload?.clientId) return payload.clientId;
    }
    // Google-login clients carry a NextAuth session instead of a portal token;
    // resolveSessionClientId identifies them the same way the portal pages do.
    // Fail closed (404 upstream) rather than 500 if session resolution throws.
    try {
        return await resolveSessionClientId();
    } catch {
        return null;
    }
}
