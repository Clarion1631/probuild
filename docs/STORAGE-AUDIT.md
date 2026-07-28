# Supabase Storage — Public Bucket Audit & Private-Doc Migration

**Audited:** 2026-07-27 · **Project:** `ghzdbzdnwjxazvmcefbh`

## Finding

Both storage buckets are **public**:

| Bucket | `public` | Size limit | MIME allowlist |
|---|---|---|---|
| `project-files` | **true** | none | none |
| `room-designer-assets` | **true** | 10 MB | images + gltf + json |

**Exposure is confirmed, not theoretical.** An unauthenticated GET (no `apikey`, no `Authorization`) to a real client e-signature object returned **HTTP 200, 6,260 bytes, `image/png`** — the actual signature. Object paths are hard to guess (cuid + timestamp + uuid), but URLs leak through emails, the Google Drive mirror, portal HTML, and browser history, so path secrecy is not an access control.

## What lives in `project-files`

| Prefix | Contents | Sensitivity |
|---|---|---|
| `signatures/contracts/`, `signatures/change-orders/` | Client / contractor / company e-signature PNGs | **High** |
| `projects/{id}/signed/`, `leads/{id}/signed/` | Signed estimate PDFs (`*_Signed_Estimate_*.pdf`) | **High** |
| `projects/{id}/`, `leads/{id}/` — **flat** | Executed contract PDFs (`*_Executed_Contract_*.pdf`), interleaved with ordinary project files | **High** |
| `projects/{id}/intermediate/` | Client-signed contract PDFs awaiting countersign | **High** |
| `tax-certs/{clientId}/` | WA reseller / exemption certificates | **High** |
| `subcontractors/{id}/coi/` | Certificates of Insurance | Medium |
| `receipts/` | Vendor receipt images | Medium |
| `projects/{id}/`, `leads/{id}/` | Project & lead files, AI room renders | Medium |
| `estimate-pdfs/`, `estimates/{id}/` | Estimate PDFs + attachments | Medium |
| `vendors/` (purchase orders), `takeoffs/{id}/` | PO attachments, takeoff photos | Low–Medium |
| `task-comments/{proj}/{task}/` | Field progress photos | Low–Medium |
| `company/letterhead_*` | Letterhead image | Low |
| `rooms/`, `*/rooms/*.usdz` | USDZ room exports for AR | Low |

`room-designer-assets` holds only the code-seeded studio catalog (`manifest.json`, `models/`, `textures/`, `thumbnails/`) — shared, non-customer, procedurally generated. **Stays public by design.**

## Decision (2026-07-27)

Owner call: most of this content does not justify a migration. Scope is narrowed to the three categories that carry legal/PII liability:

- **In scope:** `signatures/` (contracts + change orders), signed estimate PDFs (`*/signed/`), executed contract PDFs (`*_Executed_Contract_*.pdf`, flat in the project/lead prefix), intermediate signed contracts (`*/intermediate/`), and `tax-certs/`
- **Out of scope, staying public:** letterhead, task photos, takeoffs, room USDZ/renders, receipts, COIs, general project/lead files, and all of `room-designer-assets`

**Explicit non-goal: no new login for clients.** The `public` flag is per-bucket, so the in-scope prefixes move to a **separate private bucket**; `project-files` keeps serving everything else unchanged. Signed URLs are minted server-side by the page already rendering the document, so the client experience is identical — magic-link contract links and `/share/room/[token]` keep working with no account, no password. The auth gating a signed URL is the auth that already exists (magic link / portal session / NextAuth), not new auth.

## Complication: the signed PDFs live in a shared table

Executed contract PDFs and signed estimate PDFs are **not** held in dedicated columns — each is a row in **`ProjectFile.url`**, the same table that holds all the ordinary, deliberately-public project files. Two consequences:

1. **Migration is row-selected, not prefix-selected.** Executed contracts sit flat in `projects/{id}/` next to ordinary uploads, so they can only be identified by the `_Executed_Contract_*.pdf` name our own code generates. A coincidental client filename match is a benign false positive (the file merely becomes private), which is the right way to err. Signed estimates are cleaner — they live under a dedicated `signed/` prefix and are filed into a "Signed Documents" folder.
2. **The file browser is in the blast radius.** Because one table now mixes secure refs and public URLs, every `ProjectFile.url` read site must resolve **per row** rather than pass the value straight through.

The `secure:` scheme prefix is what makes this safe: a row is self-describing, so mixed state inside one table (and mid-migration state generally) is unambiguous.

## Why signed URLs and not storage RLS

Supabase storage RLS evaluates the **Supabase Auth JWT**. ProBuild authenticates end users via NextAuth + Prisma, so a storage policy would have no end-user identity to key on. Correct tools here are short-lived server-minted signed URLs (`createSignedUrl`), or a service-key download for server-side consumers that need bytes rather than a URL (PDF generation, Drive mirror).

## Migration shape

Ordering matters: the public bucket is never flipped, and originals are deleted only after the new path is verified in production.

1. **New private bucket** — additive, nothing reads it yet.
2. **Resolution layer** — a helper that accepts any of the three stored shapes (legacy inline `data:` URL, absolute public URL, relative path) and returns something renderable. Server-side consumers download bytes via the service key instead of fetching a URL.
3. **Writers** store a relative path in the private bucket; readers resolve at render time.
4. **Copy** existing in-scope objects into the private bucket (originals left in place).
5. **Backfill** the in-scope columns to relative paths.
6. **Deploy + verify** on prod.
7. **Only then delete** the public-bucket originals — this is the step that actually closes the exposure, and the only destructive one.

Rollback before step 7 is a code revert; the public originals are still serving.

## Production runbook

Run in this order. Steps 1–3 are reversible; step 6 is not.

1. **Create the private bucket** — `secure-docs`, `public: false`, 25 MB limit, no MIME allowlist (a MIME allowlist would add a new upload-rejection failure mode without adding privacy). *Done 2026-07-27.* Verified: anonymous read → HTTP 400, server-minted signed URL → HTTP 200.
2. **Deploy the code** — `npm run build` clean, then `vercel --prod` from the main checkout (not a worktree). Safe to deploy BEFORE migrating: every reader accepts legacy shapes, so untouched rows keep resolving against the still-public originals. New documents start landing in the private bucket immediately.
3. **Dry-run the migration** — `node scripts/migrate-secure-docs.mjs` (dry run is the default). Read the per-column summary. Investigate any `missing-object` or `corruptDestination` count before proceeding.
4. **Migrate** — `node scripts/migrate-secure-docs.mjs --apply`. Copies only; never deletes. Idempotent, CAS-guarded, and verifies destination size matches source before updating a row.
5. **Verify on prod** — walk each surface: portal contract signing page renders signatures; a generated/countersigned contract PDF still embeds signatures; the Signing History modal; project + portal file browsers; a client tax-exempt cert link; change-order signature display; an executed-contract email (PDF arrives as an attachment — the public download link was deliberately removed). Then re-run the exposure probe: an unauthenticated GET of a migrated signature URL must now fail.
6. **Purge the public originals** — `node scripts/purge-migrated-public-docs.mjs --apply --i-understand-this-deletes-public-originals`. **This is the step that actually closes the exposure**, and the only destructive one. It refuses to delete any original whose secure copy is missing, zero-byte, or size-mismatched. Do not run it until step 5 is signed off.

Rollback before step 6 is a code revert — the public originals are still serving, so nothing is lost.

7. **Sweep orphans** — `node scripts/sweep-orphaned-public-signatures.mjs --dest "<backup dir>" --apply`. The migration only moves objects a DB row points at, so it is blind to **orphans**: sensitive objects in storage that nothing references. These stay public forever otherwise. See below.

## Executed 2026-07-27

All steps ran against production. Result: **0 sensitive objects remain in the public bucket.**

| Step | Outcome |
|---|---|
| Migration (`--apply`) | 32 rows → 26 unique objects copied, 0 failed, 0 corrupt |
| Backup to Drive | 26 files / 9.3 MB + manifest, sha256-verified against live objects |
| Purge of originals | 26 deleted, 0 refused, 0 failed |
| Orphan sweep | **202 orphans** swept (14 signatures + 188 PDFs, 52.5 MB), 0 referenced, 0 failed |

Backups live in Google Drive at `Claude/ProBuild-Storage-Backup-2026-07-27` (folder id `1AYDAB4toyYGv8s5nCoL0bPqhgg_bPe9j`), with `MANIFEST.json`, `MANIFEST-orphans.json` and `MANIFEST-orphans-signatures.json` recording table/column/row-id/path/size/sha256 per file. Restore maps 1:1 back to bucket paths.

## Orphans: why the migration alone was not enough

The migration is DB-driven, so it never sees objects that no row references. Sweeping found **202** such objects still world-readable after the purge:

- **14 signature PNGs.** One contract had *five* near-identical 8,502-byte client signatures — the signing action uploads *before* its guarded DB write, so losing an idempotency race or hitting the already-signed retry leaves the upload behind. Re-signing also supersedes an earlier object.
- **188 sensitive PDFs**, 52 MB. Mostly e2e test artifacts (`EST-MPTEST`, `Automated_Test_Lien_Release`), but including real-looking executed contracts whose `ProjectFile` rows had since been deleted.

**The upstream orphan-generating bug still exists** (upload precedes the guarded write). It is no longer a *privacy* problem, because `persistSignature` now writes to the private bucket, so future orphans are wasted storage rather than exposed documents. A periodic sweep or cleanup-on-throw would close it properly.

## Caveat: CDN cache lag

Supabase serves public objects through Cloudflare with `cacheControl: max-age=3600`. **Deleting an object does not purge edge caches**, so a previously-fetched URL can keep returning the file for up to an hour. This was observed directly during verification: a deleted signature returned HTTP 200 from cache, then 400 once the cache was bypassed. Anyone who fetched a specific URL shortly before the purge may retain access briefly; there is no permanent exposure.

## Gotchas carried in from prior work

- `isOwnSignatureStorageUrl()` in `src/lib/signature-storage.ts` is an **SSRF allowlist** gating the server-side signature fetch in `pdf.ts`. It is pinned to `project-files`; moving buckets requires updating it. Do not remove it.
- Legacy **inline `data:` URL signatures still exist in prod** — `scripts/backfill-signature-storage.mjs` was never run. Any resolver must pass data-URLs through untouched.
- `Estimate.signatureUrl` stores a raw client-supplied data-URL and was deliberately never moved to Storage, so estimate signatures are not in the bucket at all.
- `persistSignature()` fails loud (throws) when Storage is unconfigured on the pgbouncer pooler, and falls back to a data-URL off-pooler so e2e/CI stay green. Preserve that behavior.
