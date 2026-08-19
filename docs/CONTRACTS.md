# Contracts — System Status

_Last updated: 2026-08-13 (auth/dead-surface pass — #360, #367 and the caller-less-export deletion below). The capability, verification and deployment sections further down are still the 2026-06-23 snapshot and have NOT been re-verified since._

## TL;DR

The full contract lifecycle is **live in production** (commit `412a5d4`, deployed 2026-06-23):
**author → send (magic link) → customer signs in the portal → (optional) company countersigns → executed PDF lands in the customer portal.**

The **same screen serves leads and projects** — both `/leads/[id]/contracts` and `/projects/[id]/contracts` render the shared `src/components/EntityContractsClient.tsx`.

> **Money-path note:** contract signing is **money-path-inert** — `approveContract` does NOT auto-convert estimates or touch invoices/payment schedules. The sign→convert→invoice money chain is driven by *estimate* signing, not contracts. Do **not** wire auto-conversion into `approveContract`.

## End-to-end flow & state machine

```
Draft ──send──▶ Sent ──client opens──▶ Viewed ──client signs──▶ Signed ─┐
                                                                         │
   requiresCountersign = false ──▶ client browser builds PDF ──▶ Finalized (executed PDF archived, both emailed)
                                                                         │
   requiresCountersign = true  ──▶ client PDF held privately (signedPdfPath), stays "Signed"
                                   └─ ADMIN/MANAGER countersigns ──▶ Finalized (cert page appended, executed PDF archived, both emailed)
```

- Optional **contractor pre-sign** (`{{CONTRACTOR_SIGNATURE_BLOCK}}`): company signs *before* sending; sending + client-signing are blocked until done. Orthogonal to countersign-after — both can coexist.
- Recurring contracts (lien releases) cycle `Signed → Sent` each period and force `requiresCountersign = false`.

| Status | Meaning |
|---|---|
| `Draft` | created, not sent |
| `Sent` / `Viewed` | sent / opened by client |
| `Signed` | client signed; if countersign required, held here until the company signs |
| `Finalized` | fully executed; PDF archived (shared) + emailed |
| `Declined` | defined in schema, unused |

## Capabilities (what works today)

| Area | Status | Notes |
|---|---|---|
| Authoring | ✅ | From template, blank WYSIWYG, or AI draft (`api/ai/draft-contract`) |
| Signing fields | ✅ (placeholder model) | `{{SIGNATURE_BLOCK}}`/`{{INITIAL_BLOCK}}`/`{{DATE_BLOCK}}` typed into the body via the editor toolbar. **No drag-and-drop / DocuSign-style positioning.** |
| Author preview | ✅ | "Preview" highlights merge values + blue dashed chips marking where the customer signs |
| Send + portal link | ✅ | Stable magic-link token, passwordless; **send dialog with editable CC** prefilled with the client's additional email + assigned manager |
| Customer signing | ✅ | Portal, canvas signature, atomic transition, audit record (`ContractSigningRecord`) |
| Contractor pre-sign | ✅ | ADMIN/MANAGER, before send |
| **Company countersignature** | ✅ (new) | Per-contract "Countersign required" toggle (defaults from `CompanySettings.requireContractCountersign`); admin "Countersign as Company" button → pdf-lib "Certificate of Execution" page with both signatures |
| Executed PDF in portal | ✅ | Archived as shared `ProjectFile`; shown on the contract page, Files tab, dashboard. Portal shows an "awaiting countersignature" state while pending. |
| Signer IP capture | ✅ | `ipAddress` on every signing record (client, contractor, company) via `next/headers` |
| Save-time field guard | ✅ | `normalizeContractBody` keeps signing fields as `{{KEY}}` so the portal can't silently lose them |
| E-signature storage | ✅ | New signatures stored as Supabase Storage URLs (`persistSignature`); old inline data-URLs still render |

## Key files

| File | Role |
|---|---|
| `src/lib/actions.ts` | `createContract*`, `updateContract`, `sendContractToClient`, `getContractSendDefaults`, `signContractAsContractor`, `approveContract`, **`countersignContractAsCompany`** |
| `src/lib/contract-files-core.ts` | `executedContractPdfFor` — session-free executed-PDF lookup, called directly by the client portal and by `countersignContractAsCompany`. The staff `getExecutedContractPdf` wrapper was deleted as caller-less dead surface (see note below) |
| `src/lib/contract-finalize.ts` | shared `archiveExecutedContractPdf` + `sendExecutedContractEmails` (one writer for archive/email) |
| `src/lib/pdf.ts` | `appendContractCountersignaturePage` (pdf-lib cert page), `embedSignatureImage` |
| `src/lib/signature-storage.ts` | `persistSignature` (data-URL → Storage URL, graceful fallback) |
| `src/app/api/portal/contracts/[id]/finalize/route.ts` | client-PDF finalize; countersign branch holds the PDF privately |
| `src/components/EntityContractsClient.tsx` | internal UI (shared by leads + projects) |
| `src/app/portal/contracts/[id]/PortalContractClient.tsx` | customer signing UI + awaiting-countersign state |
| `prisma/schema.prisma` | `Contract` (+ `requiresCountersign`, `companySigned*`, `signedPdfPath`), `ContractSigningRecord`, `CompanySettings.requireContractCountersign` |

## Caller-less server actions are still endpoints (2026-08-13)

`getContracts` and `getExecutedContractPdf` were gated by #367 and then deleted, because a
caller survey found neither had a single call site — no static import, no `await import(...)`,
nothing in the MCP route, `e2e/`, `scripts/`, or the mobile app.

That does not make such an export inert. Next.js documents that unused actions *may* be
eliminated, so this is stated as **measured ProBuild behaviour, not a universal rule**: on
Next 16.2.11, `.next/server/server-reference-manifest.json` from a clean `npm run build`
registered **360** server-action endpoints from `src/lib/actions.ts`, including 37 exports with
no reference anywhere in `src/`. `getContracts` appears in that manifest before the deletion and
is absent after it. A caller-less export is therefore live POST surface whose auth gate nothing
exercises — worse than dead code, because it looks covered.

Blast radius of removing them was effectively nil: both were only ever called from Server
Components (server-render calls), never imported into a Client Component or bound to a
`<form action>`, so no shipped browser bundle carries their action ids and no stale tab can
call them. Deleting an action that *had* been serialized to clients is a different matter — stale
tabs get "Failed to find Server Action" unless Vercel Skew Protection is on. That is a Vercel
project setting rather than repo config, so `next.config.ts` says nothing either way about it —
its dashboard state has not been checked.

`e2e/financial-action-auth.spec.ts` keeps both deleted, reading the export list off the
TypeScript AST rather than by regex.

## Related: Change Orders (dual-signature)

Same mirror-pair shape, shipped in the same commit/deploy:
- `approveChangeOrder` = **customer** approval (writes `approvedBy`/`approvedAt`/`clientSignatureUrl`, flips `status`→Approved).
- `countersignChangeOrderAsCompany` = **company** countersignature (writes `companySigned*` only, leaves status). Disjoint field sets — never cross-write.
- Fixed a real bug where the editor's "Sign Now" used to call `approveChangeOrder` and clobber the client's approval.

## Verification status

| Check | Result |
|---|---|
| `npm run build` | ✅ 0 errors |
| `tsc --noEmit` | ✅ 0 errors |
| DB columns present (Contract/CompanySettings/ChangeOrder) | ✅ verified |
| Codex peer review | ✅ 2 rounds; all blockers + real issues fixed |
| Production smoke test | ✅ 307 (auth redirect) / `/portal` 200, no 500s |
| e2e `money-pipeline.spec.ts` | ⏳ runs in PR CI — not yet run for this change |
| Manual happy-path (real sign → countersign → executed PDF) | ⏳ not yet exercised against a live signer |

## Open items / not built

- **No drag-and-drop field placement.** Signing fields are text placeholders, not positioned boxes. "Import Contract" is still a "coming soon" toast. A DocuSign-style designer would be its own project (`pdf-lib`/`pdfjs` are installed).
- **Browser-PDF dependency.** Countersign relies on the customer's browser having successfully POSTed its signed PDF (`signedPdfPath`). If that POST failed, the admin can't countersign until it's re-submitted — a pre-existing fragility of the client-side PDF step.
- **Concurrent-countersign minor leak.** Two admins countersigning the same contract at the exact same instant can orphan one small signature image in storage. Accepted as low-severity.
- **`approveChangeOrder` idempotency follow-up.** A replayed portal submit can overwrite the customer's approval — give it the same `updateMany({approvedAt:null})` guard `approveContract` has.
- **Full signature → Storage backfill.** New signatures go to Storage; existing inline data-URL rows can be migrated via `scripts/backfill-signature-storage.mjs` (optional — they still render).
- **Uncommitted hardening tweak.** `signContractAsContractor`'s guard+audit insert is being wrapped in a `prisma.$transaction` (matches the countersign pattern) — currently uncommitted in `src/lib/actions.ts`, so **not yet in production**.

## Deployment & git

- **Production:** live, commit `412a5d4` ("dual-party countersignatures for change orders + contracts; e-signatures to Supabase Storage"). Deployed via `vercel --prod --archive=tgz`. Rollback available via Vercel's previous deployment.
- **Working tree:** one uncommitted change in `src/lib/actions.ts` (the contractor-transaction tweak above) + helper scripts in `scripts/` (`apply-countersign-schema.mjs`, `apply-co-countersign-schema.mjs`, `backfill-signature-storage.mjs`, `probe-deploy-columns.mjs`).
- **Schema migrations** were applied additively to the live DB (not via `prisma db push`/`migrate dev`, which don't work here).
