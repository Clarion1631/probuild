# Receipt outcome audit

The existing protected `GET /api/health/pipeline` response now includes `receiptOutcomes`. `GET /api/health/pipeline?outcomes=only` collects only this database evidence, without running the operational QBO probes. Both require the existing financialReports staff permission or CRON_SECRET. The existing morning pipeline digest appends the same summary; no new schedule, destination, notification channel, or producer is introduced.

Operational `health.ok` retains its existing meaning. It is not affidavit completion. `receiptOutcomes.collectionStatus` explicitly distinguishes available evidence from an unavailable source, and the digest labels unavailable sources and unknown counts.

## Evidence and scope

The cohort is the union of current bank-line ReviewIssue targets and immutable ReceiptRequestCard item targets. Targets are counted once even if several cards refer to them. It is the complete persisted backend snapshot, not the full population of explicit Drive requests or potentially eligible purchases. No success percentage is calculated.

The server reader fetches at most 2,001 rows per table (2,000 plus an overflow sentinel), ordered by ID. If any table exceeds 2,000 rows, the entire audit is unavailable with all counts null: it never reports partial history as complete. This operational limit bounds each scheduled read to 6,003 records; it is not an eligibility or date filter. A larger population needs a separately designed scoped audit before reporting can resume. The server reader fetches narrow projections of ReviewIssue, ReceiptRequestCard, and ReceiptMemoArtifact in one RepeatableRead, READ ONLY Prisma transaction (2-second queue wait, 8-second transaction timeout). It does not fetch QBO, Drive, Chat, or secret values. Failed collection returns null counts and a static diagnostic, never empty success. Imports do not query the database.

| Metric | Evidence |
|---|---|
| observedTargets | Distinct targets in the observed backend cohort; unknown if cohort sources are incomplete |
| eligibleRequests | Unknown: no complete producer eligibility universe is observed |
| postedToChat | Valid non-future postedAt and provider message/thread names in the same Chat space |
| deliveredToPurchaser | Unknown: accepted Chat post does not prove purchaser delivery or reading |
| awaitingPurchaser | Unresolved target with positive Chat post evidence |
| signedArtifactsRecorded / filedInProbuild | Same evidence counted under two explicit labels: memo-signed resolution and one matching PDF binding on the same bank-line natural key |
| bridgeAck | Unknown: forwarding ACK state lives outside these tables |
| unresolved | All open states: pending, awaiting purchaser, uncertain delivery, and unresolved evidence conflicts |
| pending | PENDING card, without a verified post |
| retry | A retained resendQueuedAt marker; attempts alone do not count |
| error | A retained nonempty card lastError; diagnostic text is never returned |
| closedWithoutMemo | Cleared issue without backed affidavit evidence; not an affidavit completion |

Flags and stages overlap. Evidence problems are separately reported as static `evidenceErrors` and a digest count. An artifact with no current issue/card cohort target is an evidence problem, not a completed request.

`ReceiptRequestCardDelivery` is deliberately not queried: it reserves a delivery attempt before the provider call and cannot prove sending. POSTING/UNCERTAIN without positive evidence remains uncertain. A status label, successful scheduler run, or increasing attempt count cannot prove business completion.

Memo binding uses targetType/targetKey, so a recreated issue can retain an older artifact issueId. More than one current issue for the same natural key, duplicate identities, reused PDFs, mismatched PDF bindings, malformed JSON, or missing sources cannot produce a completed affidavit. An artifact alone and clearedAt alone are not a signed completion.

`elapsedMs` is now minus firstObservedAt for open targets, or artifact createdAt minus firstObservedAt for a backed filing. Missing, invalid, future, or out-of-order timestamps yield null and static flags. The pure function takes an explicit clock. This elapsed time is backend observation-to-filing, not original purchaser request-to-signature latency.

Rows expose target/issue/card identifiers for protected review, but exclude owner, vendor, amount, raw error, PDF ID, and artifact ID. The digest exposes only counts and limitations.

## Offline verification

`scripts/lib/receipt-outcome-audit.mjs` exports `auditReceiptOutcomes(snapshot, nowISO)`. A snapshot has `capturedAt`, `scope`, and `issues`, `cards`, `artifacts` arrays (or null for unavailable sources), with the narrow Prisma row fields selected in `src/lib/receipt-outcome-audit.ts`.

```
node scripts/audit-receipt-outcomes.mjs --snapshot snapshot.json --now 2026-09-09T20:00:00Z
node --test tests/receipt-outcome-audit.test.mjs
npx tsx --test tests/receipt-outcome-integration.test.ts tests/pipeline-health.test.ts tests/pipeline-digest-route.test.ts
```

The local CLI is offline-only and rejects database mode. It defaults its clock to snapshot.capturedAt for reproducibility. Production reads should use the approved authenticated endpoint after release; no workstation production database read is required.

## Limits and rollout verification

This audit does not independently re-open PDFs, validate signatures, measure purchaser access, inspect the live producer or Drive answer journal, or verify bridge ACKs. A filed memo clears a receipt chase; it does not prove a merchant receipt, QBO posting, reconciliation, or completed job costing. Full request-to-ACK measurement requires separately collected producer/journal evidence associated to the same authoritative request and charge.

Before claiming rollout success: read `?outcomes=only` through the approved authenticated API, verify source availability, inspect open/conflicting targets, and compare one real request/signature/ACK chain with the separate Drive evidence. Scheduler success alone is insufficient. This change has only local test evidence until that readback occurs.
