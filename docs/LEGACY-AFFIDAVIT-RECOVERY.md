# Administrative recovery of an existing affidavit

This path files a reviewed, pre-existing affidavit against one exact statement bank line. It does not create a new purchaser response, signature, request card, QuickBooks transaction or Expense. The provider message interpretation is an administrator attestation; the backend does not claim live Chat verification or cryptographic verification of a handwritten signature. PDF hashing proves byte identity only.

## Read-only inventory first

`GET /api/integrations/bank-ledger/legacy-affidavit-preflight` requires the exact cron credential. It reads only existing artifact fields and returns a global count plus at most 20 identifiers. `contentVerifiedCount: null` means no bytes were checked. Counts are nontransactional observations, not future completeness guarantees. A nonzero inventory requires inspection and a separately reviewed backfill plan before enabling new content bindings.

## Configuration and prepare

The server privately holds `LEGACY_AFFIDAVIT_RECOVERY_PACKET_BASE64` and independently reviewed raw-byte `LEGACY_AFFIDAVIT_RECOVERY_PACKET_SHA256`. The packet contains original provider names, quoted-message relationship, verbatim reply and timestamps, exact source identity, original PDF hash, administrator approval reference and legacy processing time. Never commit a real packet to this public repository.

`POST /api/integrations/bank-ledger/legacy-affidavit-recovery` accepts only `mode`, `bankLineId`, and (for apply) `planDigest`. It requires the cron credential; caller JSON cannot establish provenance. Prepare verifies current bounded Drive bytes, source statement/import identity, competing claims and artifact inventory. It returns an exact digest or an explicit incomplete/conflict result. Historical processing timestamps without timezone remain verbatim and are not converted to UTC.

## Rollout and apply prerequisites

1. Obtain the old-schema global inventory through the protected endpoint. Resolve any historical unverified binding before rollout; do not infer an empty global inventory from a receipt cohort.
2. Apply the reviewed additive schema script before deploying code that selects its columns. The script requires `--target prod --yes --expect-db <database> --expect-host <configured-url-host>` and the existing shared production target guard (production env file, project identity and baseline); CI uses `--target ci` with its isolated pooled URL; it performs no business backfill.
3. Deploy with `RECEIPT_MEMO_CONTENT_GUARD_ENABLED` absent or false. Verify every ordinary answer client uses the production alias, not an old pinned preview/deployment URL.
4. Enable the shared guard on the current deployment, wait for READY, and allow the platform's maximum old in-flight request duration to drain. Keep recovery unapplied during this interval. An old process still running guard-disabled code can otherwise create a hashless binding.
5. Repeat global inventory under the enabled deployment and prepare recovery again. Any new unknown binding must be reviewed; the guard independently refuses new bindings while unknown content exists. Do not treat a pre-deployment inventory as proof of future uniqueness.
6. Review the exact fresh prepare digest and apply it once. Apply requires the shared guard enabled and repeats current checks, then re-reads under evidence, bank identity, content-hash and PDF locks. A changed snapshot refuses the write. No unsafe retries after an unknown response: read evidence and repeat the same request only to obtain its idempotent outcome.

The normal answer path retains its exact card association and filename checks. The enabled guard adds byte identity and durable uniqueness. An exact previously bound retry remains functional even with unrelated unknown artifacts, without retroactively backfilling its hash; positively proven content reuse elsewhere is refused. A new binding, issue update, immutable provenance and evidence epoch commit together. Administrative `recoveredBy` is the machine identity, not the purchaser; `recoveredAt` is separate from original human and processing timestamps.

## Verification

The unit runner includes pure proof, bounded byte verifier, content guard, prepare/apply, store, handler and schema tests. The existing answers-route tests cover both unchanged default behavior and enabled content protection, including concurrent reuse, card association, historical idempotence and epoch rollback. Isolated fixtures are fictional. Authentic evidence validation belongs in the private operational packet and does not by itself prove a live filed result.
