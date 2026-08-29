export type MaterialStatus =
  | "REQUESTED"
  | "QUOTED"
  | "APPROVED"
  | "ORDERED"
  | "SHIPPED"
  | "RECEIVED"
  | "DELAYED";

export type MaterialEvidenceKind =
  | "SOURCE_IMPORT"
  | "VENDOR_QUOTE"
  | "APPROVAL_DECISION"
  | "PURCHASE_ORDER"
  | "SHIPMENT_NOTICE"
  | "DELIVERY_RECEIPT"
  | "RICHARD_CONFIRMATION";

export type MaterialEvidence = {
  id?: string;
  kind: MaterialEvidenceKind;
  current: boolean;
  provenance: "VENDOR" | "CARRIER" | "ADMIN" | "MANUAL" | "SYSTEM";
  approvedQuoteEvidenceId?: string | null;
};

export type TransitionInput = {
  target: MaterialStatus;
  evidence: MaterialEvidence[];
  receivedAt?: Date | string | null;
  isManual: boolean;
  hasCurrentRichardConfirmation: boolean;
};

export type TransitionDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export type StagedProjectDecision =
  | { state: "READY"; materialProjectId: string }
  | { state: "DATA_GAP" | "PROJECT_CONFLICT"; materialProjectId: null };

/**
 * Procurement V1 deliberately refuses to infer project assignment. A blank
 * source project is reviewable data gap; a different source project is a hold.
 */
export function evaluateStagedProject({
  selectedProjectId,
  rowProjectId,
}: {
  selectedProjectId: string;
  rowProjectId: string | null | undefined;
}): StagedProjectDecision {
  if (!rowProjectId) return { state: "DATA_GAP", materialProjectId: null };
  if (rowProjectId !== selectedProjectId) {
    return { state: "PROJECT_CONFLICT", materialProjectId: null };
  }
  return { state: "READY", materialProjectId: selectedProjectId };
}

/** Canonical, unsuffixed source identities. Row/item suffixes are added in persistence. */
export const ingestIdentity = {
  directXlsx(requestKey: string) {
    return `xlsx:${requestKey}`;
  },
  gmail(messageId: string, attachmentId: string) {
    return `gmail:${messageId}:${attachmentId}`;
  },
  drive(fileId: string, immutableRevisionIdOrHash: string) {
    return `drive:${fileId}:${immutableRevisionIdOrHash}`;
  },
  manualRichard(requestKey: string) {
    return `richard-manual:${requestKey}`;
  },
  purchaseOrder(purchaseOrderId: string, immutableRevisionIdOrHash: string) {
    return `po:${purchaseOrderId}:${immutableRevisionIdOrHash}`;
  },
};

function hasCurrent(evidence: MaterialEvidence[], kind: MaterialEvidenceKind) {
  return evidence.some((item) => item.kind === kind && item.current);
}

/**
 * This is the UI/API preflight only. The transaction layer repeats this check
 * against immutable evidence rows, role gates, and the configured Richard ID.
 */
export function transitionDecision(input: TransitionInput): TransitionDecision {
  const { target, evidence, receivedAt, isManual, hasCurrentRichardConfirmation } = input;

  if (isManual && !hasCurrentRichardConfirmation) {
    return { allowed: false, reason: "RICHARD_CONFIRMATION_REQUIRED" };
  }

  if (target === "QUOTED" && !hasCurrent(evidence, "VENDOR_QUOTE")) {
    return { allowed: false, reason: "CURRENT_VENDOR_QUOTE_REQUIRED" };
  }

  if (target === "APPROVED") {
    const decision = evidence.find((item) => item.kind === "APPROVAL_DECISION" && item.current);
    const quote = evidence.find((item) => item.kind === "VENDOR_QUOTE" && item.current);
    if (!decision) return { allowed: false, reason: "CURRENT_APPROVAL_DECISION_REQUIRED" };
    if (!quote || !decision.approvedQuoteEvidenceId || decision.approvedQuoteEvidenceId !== quote.id) {
      return { allowed: false, reason: "APPROVED_QUOTE_VERSION_MISMATCH" };
    }
  }

  if (target === "ORDERED" && !hasCurrent(evidence, "PURCHASE_ORDER")) {
    return { allowed: false, reason: "CURRENT_PURCHASE_ORDER_REQUIRED" };
  }

  if (target === "SHIPPED" && !hasCurrent(evidence, "SHIPMENT_NOTICE")) {
    return { allowed: false, reason: "CURRENT_SHIPMENT_NOTICE_REQUIRED" };
  }

  if (target === "RECEIVED") {
    if (!hasCurrent(evidence, "DELIVERY_RECEIPT")) {
      return { allowed: false, reason: "CURRENT_DELIVERY_RECEIPT_REQUIRED" };
    }
    if (!receivedAt) return { allowed: false, reason: "RECEIVED_AT_REQUIRED" };
  }

  return { allowed: true };
}
