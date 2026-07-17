# PR 209 Production Security Follow-up Design

**Date:** 2026-07-17

**Status:** Approved design; awaiting written-spec review

**Base:** `origin/main` at `74a69c0b0a616ca30ee6dda9b659a0a84da33241`

**Production merge under review:** `f4ad332928c0100acde331d0e9fd06d1e0546d9b`

## Context

PR 209 strengthened change-order approval invariants, but its production follow-up identified two remaining contract gaps:

1. `approveChangeOrder` persists the client's drawn signature before `approveChangeOrderCore` performs its locked transactional validation. Any rejected or losing approval attempt can therefore leave a storage object that no committed change order owns.
2. `/api/health` implements the response described by `.specs/PB-health-001-health-endpoint.md`, but `src/proxy.ts` intercepts unauthenticated requests and redirects them to login. `/api/version` is already public, but it reports deployment identity rather than application readiness.

The release transcript also exposed a Vercel access token. That incident is resolved operationally: a replacement token was stored as the Windows User `VERCEL_TOKEN`, it can read the exact ProBuild project and READY production deployments, and the exposed token ID is absent from Vercel's token inventory. No repository or GitHub Actions token reference required an update, and no deployment was performed during rotation.

## Goals

1. Every signature storage object created by a rejected, replayed, failed, or concurrent losing client-approval attempt is compensating-deleted.
2. A successful exactly-once approval retains precisely the signature URL committed by the winning transaction.
3. The existing Sent-state, non-empty-items, positive stored/rendered subtotal, subtotal-equality, and row-lock invariants remain inside `approveChangeOrderCore`.
4. `/api/health` is the documented unauthenticated production deployment probe and exposes no sensitive state.
5. Focused and full money-path coverage, production-proxy coverage, typecheck, build, peer review, independent QAS, and independent security review provide evidence before handoff.
6. The unrelated dirty canonical checkout and its checked-out merged feature branch remain untouched.

## Non-goals

- Deploying or promoting a build.
- Changing the change-order schema, RLS policies, subtotal calculations, or approval state machine.
- Adding deep database or third-party dependency checks to `/api/health`.
- Moving signatures to private storage or changing existing signature URL compatibility.
- Cleaning any local or remote branch during this work.
- Refactoring other contract, company-signature, or project-file upload flows.

## Pattern discovery

The selected design reuses the repository's upload-compensation pattern rather than introducing a new storage transaction abstraction:

- `src/app/api/portal/contracts/[id]/finalize/route.ts` tracks the uploaded path and removes it when the database transition does not commit, including concurrent losers.
- `src/lib/contract-finalize.ts` and `src/lib/project-files.ts` remove a just-uploaded object when the following database write fails.
- `src/lib/change-order-core.ts` already serializes approvals with a row lock and owns all approval invariants. Those checks stay there.
- `src/lib/signature-storage.ts` uploads with `upsert: false`, which gives each attempt a unique object and makes attempt-local compensation safe.
- `.specs/PB-health-001-health-endpoint.md` explicitly defines `/api/health` as lightweight and unauthenticated.

Supabase Storage deletion will use the Storage API's `remove([path])` operation. Direct SQL deletion is not acceptable because it can orphan the underlying object.

## Signature ownership design

### Storage boundary

`src/lib/signature-storage.ts` will add an owned-persistence API while retaining the existing `persistSignature` wrapper for unaffected callers.

The owned API returns a small handle with:

- `url`: the value passed to the database transaction.
- `discard()`: an idempotent, attempt-local cleanup operation.

When this invocation creates a Supabase object, `discard()` removes that exact path from the existing signatures bucket and reports a storage removal error to its caller. When the input is an already-persisted application-owned URL or the development fallback remains an inline data URL, `discard()` is a no-op because this invocation created no object.

If upload succeeds but public-URL construction unexpectedly fails, the storage function removes the uploaded path before propagating the error. It must never return a handle that has lost the path needed for compensation.

### Approval coordinator

A focused, server-only coordinator in `src/lib/change-order-approval.ts` will own the cross-resource lifecycle:

1. Persist the signature and receive its ownership handle.
2. Call `approveChangeOrderCore` with the handle's URL.
3. If the core throws for any reason, call `discard()` and then rethrow the original approval error.
4. If the core commits, return its result without calling `discard()`. Ownership has transferred to the committed change-order row.

`approveChangeOrder` in `src/lib/actions.ts` will continue to perform authentication, project ownership, signature-name, and drawn-signature validation before calling the coordinator. Its post-commit automation and cache revalidation remain outside the coordinator. Consequently, a failure after the transaction commits cannot delete the winning signature.

The coordinator accepts narrow dependency overrides for tests. Production uses the real storage function and real transaction core; tests can use a tracked in-memory object store while still exercising the real database core.

### Error handling

The transaction/business error remains the primary error returned to the caller. If compensating deletion also fails, the coordinator emits a sanitized server-side event containing a stable operation label, the change-order identifier, and only a normalized error type/code/status. It must not log the raw error object or message, signature data URL, bearer credentials, customer-entered signature name, storage path, or public URL. It then rethrows the original approval error.

This choice preserves current client-visible validation behavior while making cleanup failure observable for operations. Storage and PostgreSQL cannot participate in one atomic transaction, so compensating deletion is necessarily best-effort at the infrastructure boundary.

### Concurrency behavior

Each concurrent request uploads a unique object. The existing `FOR UPDATE` approval transaction admits one winner. After the winner commits, every waiter sees a non-Sent row and rejects. Each rejected coordinator deletes only its own upload. The retained object set therefore contains exactly one object, and its URL equals the committed `clientSignatureUrl`.

## Health-check contract

`GET /api/health` will be the supported public production deployment probe. It establishes that the deployed web process can serve the application contract; because it deliberately performs no dependency checks, it does not attest to database, storage, or third-party readiness.

- Response: HTTP 200 and `{ "status": "ok", "ts": "<ISO 8601>" }`.
- Dependencies: no authentication, database query, storage call, or third-party request.
- Caching: `dynamic = "force-dynamic"` plus an explicit `Cache-Control: no-store` response header.
- Exposure: no build identifiers, environment variables, database state, dependency details, or exception text.

`src/proxy.ts` will exclude exactly `/api/health` from both proxy authorization paths. The exclusion must not make `/api/health/*` or another `/api/*` namespace public. `/api/version` remains public for stale-client deployment identity but is not documented as readiness.

`.specs/PB-health-001-health-endpoint.md` will be updated from draft to implemented contract, record the proxy exception, distinguish readiness/liveness from version identity, and document the production URL `https://probuild.goldentouchremodeling.com/api/health`.

## Test design

### Money-pipeline coverage

`e2e/money-pipeline.spec.ts` will add storage-lifecycle assertions around the coordinator:

1. **Invalid status:** a non-Sent change order rejects and the attempt's tracked object count returns to zero.
2. **Invalid subtotal:** a Sent change order with a non-positive or inconsistent subtotal rejects and the tracked object count returns to zero.
3. **Replay:** the first approval commits one object; a replay rejects and removes only the replay upload, leaving the original object and committed URL unchanged.
4. **Transaction failure:** an injected failure at the approval-core boundary removes the attempt's object and preserves the original error.
5. **Concurrent losers:** multiple simultaneous approvals produce one fulfilled result; all rejected attempts remove their objects; one object remains; and that object's URL equals the database row's `clientSignatureUrl`.
6. **Cleanup failure:** a simulated removal failure preserves the original approval error and records only the sanitized cleanup event fields.

The existing exactly-once, concurrent-writer, item, state, and subtotal tests remain and must continue to pass.

### Proxy/health coverage

`e2e/auth-status.spec.ts` will add an unauthenticated request assertion that:

- `/api/health` returns 200 rather than 307 under the production `next start` proxy path used in CI.
- The body contains only `status` and `ts`, with `status === "ok"` and a valid recent ISO timestamp.
- The response is `no-store`.
- A neighboring path such as `/api/health/private` is not covered by the exact public exception.
- An existing protected API route still redirects or denies unauthenticated access, guarding against an overbroad matcher edit.

## Validation and review gates

The implementation is not ready for handoff until all applicable gates pass:

1. Focused storage-cleanup tests in `e2e/money-pipeline.spec.ts`.
2. Full `npx playwright test e2e/money-pipeline.spec.ts`.
3. `npx playwright test e2e/auth-status.spec.ts` in the production-server configuration used by CI.
4. `npm run typecheck`.
5. `npm run build`.
6. A separate Codex peer-review pass over the final diff. The repository has no executable `codex-peer-review` command, so this gate will be performed by an independent reviewer agent and recorded under that name.
7. Independent QAS verification of acceptance criteria and test evidence.
8. Independent security review of storage ownership, cleanup scope, proxy allowlisting, logging, and credential hygiene.

Review findings must be resolved and the affected checks rerun before completion is claimed.

## Expected files

- `src/lib/signature-storage.ts`
- `src/lib/change-order-approval.ts` (new)
- `src/lib/actions.ts`
- `src/proxy.ts`
- `src/app/api/health/route.ts`
- `e2e/money-pipeline.spec.ts`
- `e2e/auth-status.spec.ts`
- `.specs/PB-health-001-health-endpoint.md`
- This design document and the subsequent implementation plan

## Repository and release safety

All work is isolated at `C:\tmp\probuild-pr209-security-followup` on `codex/pr-209-security-followup`, based on current `origin/main`. The canonical checkout at `C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-site` is not an implementation target and its unrelated modifications and untracked files must remain unchanged.

No branch is deleted locally or remotely as part of this follow-up. Cleanup of the merged PR branch is a separate decision that requires a final read-only comparison and explicit confirmation that the canonical changes are preserved.

No deployment is authorized by this design. A future deployment requires its own target, rollback, CI, and smoke-test confirmation.

## Rollback

The code change can be reverted without a migration:

1. Revert the coordinator/storage ownership commit to restore the previous approval call path.
2. Revert the proxy and health-contract commit to restore authentication interception.
3. Run the money-pipeline, auth-status, typecheck, and build gates again.

Objects already retained by successful approvals are never deleted by rollback. No data backfill is required.
