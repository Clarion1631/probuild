# Receipt outcome audit: association evidence

Each row from `auditReceiptOutcomes` (scripts/lib/receipt-outcome-audit.mjs) carries an `associations` object.
It is evidence only. It never changes `counts`, `stage`, or any flag.

```
associations: {
  cards: [{ cardId, requestId, threadName, messageName, postedAt, itemNumber, fingerprint }] | null,
  cardEvidence: 'absent' | 'conflict' | 'unavailable' | 'verified',
  filedArtifact: { pdfId, createdAt } | null,
  artifactEvidence: 'absent' | 'conflict' | 'unavailable' | 'verified',
}
```

## Cards
- A card is listed only when the provider accepted the post (valid non-future `postedAt`, message and thread in the same Chat space) and its item for this target is well formed.
- Well formed means: `n` is a positive safe integer, `fingerprint` equals `pb-` + targetKey, and the card names each targetKey and each `n` at most once.
- `requestId` is derived server side (`receiptRequestId` in src/lib/receipt-outcome-audit.ts) from `owner` + `pacificDate` as `receipt-req-${owner}-${pacificDate}`. After validation it calls the same `requestIdFor` helper used by the bridge. Owner and date never reach the summariser; a raw `requestId` on a row is ignored.
- `verified`: at least one listed card. All valid cards are kept, sorted by cardId; none is chosen arbitrarily.
- `absent`: no card, or only pending cards without provider post evidence. An unposted card never claims delivery.
- `conflict`: any card for this target has a malformed item or a mis-shaped requestId. The list is `null`.
- `unavailable`: card sources are unknown, a card lacks a derivable requestId, or a non-pending card lacks valid provider post evidence. `cards` is `null`, never a partial list.

## Artifact
- `verified`: the existing filed evaluator accepted exactly one artifact on the natural key (targetType/targetKey) whose pdfId equals the memo-signed resolution pdfId. Issue recreation is tolerated. `createdAt` is `null` if unparseable or future; no time validity is ever inferred from bad data.
- `absent`: no artifact on the key. A memo-signed resolution with no artifact is absent, not conflict.
- `conflict`: several artifacts, pdf mismatch, artifact without resolution or issue, or identity conflicts. `filedArtifact` is `null`.
- `unavailable`: issues or artifacts source unknown, or issue details unparseable.

## Privacy
No separate owner field, email, vendor, amount, card tail, raw error, or artifact row id is emitted. `pdfId` appears only inside an accepted `filedArtifact`. The daily digest text prints counts only and never rows.

Read these fields only through the existing protected `GET /api/health/pipeline?outcomes=only` (financialReports staff session or existing CRON_SECRET bearer). No targetKey filter is implemented; filter the bounded response locally. The read-only transaction and overflow failure are unchanged. These fields describe only the persisted cohort, not complete eligibility, delivery or bridge ACK coverage. Join the journal through exact fingerprint, request ID, thread and item number; compare journal pdf_id to filedArtifact.pdfId. The answer message differs from the original card message. Do not claim the historical card caused filing solely because both are present; require the matching journal and durable same-hash ACK.
