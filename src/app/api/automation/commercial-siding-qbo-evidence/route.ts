import { NextResponse } from "next/server";
import { getCurrentUserWithPermissions, hasPermission } from "@/lib/permissions";
import { getQBSettings } from "@/lib/integration-store";
import { QBNotConnectedError } from "@/lib/quickbooks-payments";
import {
    buildCommercialSidingQboEvidence,
    createQboEvidenceRuntime,
    type QboEvidenceInvoice,
    type QboEvidencePayment,
} from "@/lib/commercial-siding-qbo-evidence";
import type { QBTokens } from "@/lib/quickbooks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type EvidenceUser = { role: string; permissions?: { financialReports?: boolean } | null };

export interface CommercialSidingQboEvidenceHandlerDependencies {
    getCurrentUser(): Promise<EvidenceUser | null>;
    canReadFinancialEvidence: (...args: [EvidenceUser]) => boolean;
    /** Reads an already-stored access token only. This route never refreshes or persists OAuth tokens. */
    getReadOnlyTokens(): Promise<QBTokens>;
    queryInvoices: (...args: [QBTokens, string]) => Promise<QboEvidenceInvoice[]>;
    readPayment: (...args: [QBTokens, string]) => Promise<QboEvidencePayment | null>;
    now(): Date;
}

function methodNotAllowed() {
    return new Response(null, { status: 405, headers: { Allow: "GET" } });
}

export function createCommercialSidingQboEvidenceHandlers(
    dependencies: CommercialSidingQboEvidenceHandlerDependencies,
) {
    return {
        async GET() {
            const user = await dependencies.getCurrentUser();
            if (!user) {
                return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
            }
            if (!dependencies.canReadFinancialEvidence(user)) {
                return NextResponse.json({ ok: false, reason: "forbidden" }, { status: 403 });
            }

            try {
                const tokens = await dependencies.getReadOnlyTokens();
                const evidence = await buildCommercialSidingQboEvidence({
                    queryInvoices: (docNumber) => dependencies.queryInvoices(tokens, docNumber),
                    readPayment: (paymentId) => dependencies.readPayment(tokens, paymentId),
                    now: dependencies.now,
                });
                return NextResponse.json({ ok: true, evidence });
            } catch (error) {
                if (error instanceof QBNotConnectedError) {
                    return NextResponse.json({ ok: false, reason: "quickbooks-not-connected" }, { status: 503 });
                }
                // Do not serialize upstream OAuth/QBO diagnostics; they can contain
                // credentials or request metadata and are not evidence for staff.
                console.error("Commercial Siding QBO evidence read failed", error instanceof Error ? error.name : "UnknownError");
                return NextResponse.json({ ok: false, reason: "qbo-evidence-unavailable" }, { status: 502 });
            }
        },
        async HEAD() {
            return methodNotAllowed();
        },
        async OPTIONS() {
            return methodNotAllowed();
        },
    };
}

async function getStoredReadOnlyQboTokens(): Promise<QBTokens> {
    const settings = await getQBSettings();
    if (!settings.connected || !settings.accessToken || !settings.refreshToken || !settings.realmId) {
        throw new QBNotConnectedError();
    }
    // Deliberately no refreshQBToken/saveQBSettings call here. A stale access
    // token yields an unavailable-evidence response; this investigation surface
    // must not mutate credentials or any QBO business record.
    return {
        accessToken: settings.accessToken,
        refreshToken: settings.refreshToken,
        realmId: settings.realmId,
    };
}

const handlers = createCommercialSidingQboEvidenceHandlers({
    getCurrentUser: getCurrentUserWithPermissions,
    canReadFinancialEvidence: (user) => hasPermission(user, "financialReports"),
    getReadOnlyTokens: getStoredReadOnlyQboTokens,
    queryInvoices: async (tokens, docNumber) => createQboEvidenceRuntime(tokens).queryInvoices(docNumber),
    readPayment: async (tokens, paymentId) => createQboEvidenceRuntime(tokens).readPayment(paymentId),
    now: () => new Date(),
});

/**
 * Authenticated, fixed-scope, read-only evidence endpoint. It intentionally
 * accepts no filters or mutation commands.
 */
export async function GET() {
    return handlers.GET();
}

// Next otherwise maps HEAD to GET and supplies an automatic OPTIONS response.
// Neither method may trigger an authenticated QBO evidence read.
export async function HEAD() {
    return handlers.HEAD();
}

export async function OPTIONS() {
    return handlers.OPTIONS();
}
