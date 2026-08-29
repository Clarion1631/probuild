import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateStagedProject,
  ingestIdentity,
  transitionDecision,
} from "../src/lib/procurement-contract";

test("staging keeps blank-project rows as DATA GAP without a material assignment", () => {
  assert.deepEqual(
    evaluateStagedProject({ selectedProjectId: "project-a", rowProjectId: null }),
    { state: "DATA_GAP", materialProjectId: null },
  );
});

test("staging blocks a source project that conflicts with the selected project", () => {
  assert.deepEqual(
    evaluateStagedProject({ selectedProjectId: "project-a", rowProjectId: "project-b" }),
    { state: "PROJECT_CONFLICT", materialProjectId: null },
  );
});

test("staging assigns only the selected project when the source agrees", () => {
  assert.deepEqual(
    evaluateStagedProject({ selectedProjectId: "project-a", rowProjectId: "project-a" }),
    { state: "READY", materialProjectId: "project-a" },
  );
});

test("direct-upload identities are stable request UUID keys", () => {
  assert.equal(ingestIdentity.directXlsx("7d303e53-6c84-4b44-b3df-1e5f56e9a010"), "xlsx:7d303e53-6c84-4b44-b3df-1e5f56e9a010");
});

test("RECEIVED rejects a receipt without the authoritative delivery date", () => {
  assert.deepEqual(
    transitionDecision({
      target: "RECEIVED",
      evidence: [{ kind: "DELIVERY_RECEIPT", current: true, provenance: "CARRIER" }],
      receivedAt: null,
      isManual: false,
      hasCurrentRichardConfirmation: false,
    }),
    { allowed: false, reason: "RECEIVED_AT_REQUIRED" },
  );
});

test("manual APPROVED requires Richard's current principal-bound confirmation", () => {
  assert.deepEqual(
    transitionDecision({
      target: "APPROVED",
      evidence: [{ kind: "APPROVAL_DECISION", current: true, provenance: "MANUAL", approvedQuoteEvidenceId: "quote-1" }, { kind: "VENDOR_QUOTE", current: true, provenance: "VENDOR", id: "quote-1" }],
      isManual: true,
      hasCurrentRichardConfirmation: false,
    }),
    { allowed: false, reason: "RICHARD_CONFIRMATION_REQUIRED" },
  );
});

test("APPROVED binds its decision to the exact current quote evidence version", () => {
  assert.deepEqual(
    transitionDecision({
      target: "APPROVED",
      evidence: [{ kind: "APPROVAL_DECISION", current: true, provenance: "ADMIN", approvedQuoteEvidenceId: "quote-old" }, { kind: "VENDOR_QUOTE", current: true, provenance: "VENDOR", id: "quote-new" }],
      isManual: false,
      hasCurrentRichardConfirmation: false,
    }),
    { allowed: false, reason: "APPROVED_QUOTE_VERSION_MISMATCH" },
  );
});
