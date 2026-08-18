import { approveChangeOrderCore } from "./change-order-core";
import { prisma } from "./prisma";
import { persistOwnedSignature } from "./signature-storage";

export type ChangeOrderSignatureCleanupEvent = {
    operation: "discard-rejected-change-order-signature";
    changeOrderId: string;
    errorType: string;
    errorCode?: string;
    status?: number;
};

export type ChangeOrderApprovalDependencies = {
    persistSignature: typeof persistOwnedSignature;
    approveCore: typeof approveChangeOrderCore;
    isSignatureReferenced: (changeOrderId: string, signatureUrl: string) => Promise<boolean>;
    reportCleanupFailure: (event: ChangeOrderSignatureCleanupEvent) => void;
};

type ChangeOrderApprovalInput = {
    signatureName: string;
    signatureDataUrl: string;
    approvedAt: Date;
    expectedRevision: number;
    expectedTaxFingerprint: string;
};

function safeIdentifier(value: unknown): string | undefined {
    return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
        ? value
        : undefined;
}

function cleanupEvent(changeOrderId: string, error: unknown): ChangeOrderSignatureCleanupEvent {
    const record = typeof error === "object" && error !== null
        ? error as Record<string, unknown>
        : {};
    const errorType = error instanceof Error
        ? safeIdentifier(error.name) ?? "Error"
        : typeof error;
    const errorCode = safeIdentifier(record.code);
    const status = typeof record.status === "number"
        && Number.isInteger(record.status)
        && record.status >= 100
        && record.status <= 599
        ? record.status
        : undefined;
    return {
        operation: "discard-rejected-change-order-signature",
        changeOrderId,
        errorType,
        ...(errorCode ? { errorCode } : {}),
        ...(status ? { status } : {}),
    };
}

const defaultDependencies: ChangeOrderApprovalDependencies = {
    persistSignature: persistOwnedSignature,
    approveCore: approveChangeOrderCore,
    isSignatureReferenced: async (changeOrderId, signatureUrl) => {
        const hit = await prisma.changeOrder.findFirst({
            where: { id: changeOrderId, clientSignatureUrl: signatureUrl },
            select: { id: true },
        });
        return !!hit;
    },
    reportCleanupFailure: (event) => {
        console.error("[approveChangeOrder] signature cleanup failed", event);
    },
};

export async function approveChangeOrderWithSignature(
    id: string,
    input: ChangeOrderApprovalInput,
    overrides: Partial<ChangeOrderApprovalDependencies> = {},
) {
    const dependencies = { ...defaultDependencies, ...overrides };
    const owned = await dependencies.persistSignature(
        input.signatureDataUrl,
        `change-orders/${id}/client`,
    );

    const discard = async () => {
        try {
            await owned.discard();
        } catch (error) {
            try {
                dependencies.reportCleanupFailure(cleanupEvent(id, error));
            } catch (reporterError) {
                try {
                    console.error("[approveChangeOrder] cleanup telemetry failed", {
                        operation: "report-signature-cleanup-failure",
                        changeOrderId: id,
                        errorType: reporterError instanceof Error
                            ? safeIdentifier(reporterError.name) ?? "Error"
                            : typeof reporterError,
                    });
                } catch {
                    // Telemetry must never replace the primary approval error.
                }
            }
        }
    };

    const discardIfDefinitelyUnreferenced = async () => {
        if (!owned.url) return;
        let referenced: unknown;
        try {
            referenced = await dependencies.isSignatureReferenced(id, owned.url);
        } catch {
            // A failed probe leaves the database outcome unknown. Keep the upload:
            // an orphan can be swept later, but a committed signature is irreplaceable.
            return;
        }
        // Fail closed even if a future override returns a non-boolean value.
        if (referenced !== false) return;
        await discard();
    };

    try {
        const approval = await dependencies.approveCore(id, {
            signatureName: input.signatureName,
            clientSignatureUrl: owned.url,
            approvedAt: input.approvedAt,
            expectedRevision: input.expectedRevision,
            expectedTaxFingerprint: input.expectedTaxFingerprint,
        });
        if (!approval) {
            await discard();
            return null;
        }
        return approval;
    } catch (error) {
        // A rejected Prisma call can still have committed before the connection
        // failed. Probe the canonical row before compensating the uploaded object.
        await discardIfDefinitelyUnreferenced();
        throw error;
    }
}
