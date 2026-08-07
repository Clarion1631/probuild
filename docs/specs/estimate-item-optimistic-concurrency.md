# Spec: optimistic concurrency for estimate line-item saves

Raised by Codex peer review 2026-08-07 during the purchase-order stale-write fix (deferred to
keep that PR surgical).

## Problem

`saveEstimate` (`src/lib/actions.ts`, the `toItemData` closure) writes every mutable line-item
column from whatever the browser held in local state when the editor loaded, with no version or
`updatedAt` precondition:

`quantity`, `unitCost`, `total`, `baseCost`, `markupPercent`, `budgetQuantity`, `budgetUnit`,
`budgetRate`, `costCodeId`, `costTypeId`, `order`, `parentId`, `name`, `description`, `type`.

Two people with the same estimate open ⇒ the second save silently reverts the first person's
edits. `approvalStatus`/`approvalNote` are already safe (omitted from `toItemData`), and
`purchaseOrderId` was removed from the payload on 2026-08-07 (links are owned solely by
`linkPOToEstimateItem` / `unlinkPOFromEstimateItem` / `quickCreatePOAndLink`).

## REVISION 2 (2026-08-07, after Codex round 1) — read this before the sections below

Round 1 implemented per-row `EstimateItem.version`. Codex peer review found that granularity to be
both insufficient and pointless, and it is right on both counts:

- **Pointless:** `saveEstimate` rewrites *every* item row on every save (even when only the title
  or tax changed). So two people editing two different line items conflict anyway. Per-row
  versions buy no per-row independence — only per-row bookkeeping, and a conflict toast that
  would falsely name every row.
- **Insufficient:** the guard only covered *updates*. Deletes are computed from "ids absent from
  the payload" and creates are id-specifying, so a stale editor could still silently (a) delete
  rows another actor added and (b) resurrect rows another actor deleted. Worst case: the AI
  wholesale rewrite in `src/lib/gpt-estimate.ts` replaces every item with new ids, then a stale
  editor save deletes all of those and recreates its own old ids — reverting the entire rewrite
  with every per-row CAS passing, because none of those rows were *updated*.
- Codex also correctly flagged that the `version === undefined` escape hatch was a permanent
  OCC bypass (not a deploy-window allowance), that a conflict raised during the `safeOnly` P2022
  retry escaped as a thrown-and-redacted server-action error, and that the schema-drift read
  fallback omitted the column so the editor fabricated version 0.

**The mechanism is therefore a single estimate-level revision, not per-row versions.**

- `Estimate.itemsRevision Int @default(0)` guards the whole line-item collection: updates,
  deletes, creates, reorders, and wholesale rewrites, in one compare-and-set.
- One CAS statement, taken immediately after `lockMoneyParents` (which already holds the Estimate
  row `FOR UPDATE`, so the CAS is airtight rather than merely probable):
  `updateMany({ where: { id: estimateId, itemsRevision: expected }, data: { itemsRevision: { increment: 1 } } })`
  — `count === 0` ⇒ stale ⇒ throw the sentinel, whole transaction rolls back.
- **No escape hatch.** A payload without a numeric `itemsRevision` is rejected as stale. The sole
  caller is the editor, which always has one.
- Every *other* writer that adds, deletes, or rewrites the item collection of an existing estimate
  must bump `itemsRevision` too — otherwise a stale editor still reverts it. Find them all
  (`gpt-estimate.ts` item rewrites, server-side item creates in `actions.ts`, the takeoff
  convert route) and bump each. Approval-only writers and `auto-assign-phases` are the two
  documented exceptions — see the non-goals below.
- The conflict message drops the row names (they were never meaningful): *"This estimate was
  changed by someone else since you opened it. Your changes were not saved. Reload to get the
  latest version."*

Everything below is the round-1 text, kept for the rationale it still carries. Where it says
per-row `EstimateItem.version`, read estimate-level `Estimate.itemsRevision`; the "Deliberate
non-goals", the return-don't-throw decision, and Goals 3 and 4 all stand as written.

## Chosen mechanism: an integer revision, checked-and-incremented (see REVISION 2)

An integer revision is preferred over an `updatedAt` precondition because:

- No clock/precision semantics (Postgres timestamp round-tripping through JSON, `Decimal`-style
  precision loss, pooler clock skew).
- Compare-and-set is a single `updateMany({ where: { id, version }, data: { …, version: { increment: 1 } } })`
  — the row lock the UPDATE itself takes is the whole guard, no extra `SELECT … FOR UPDATE` needed
  (and the surrounding tx already holds the canonical `Estimate` lock via `lockMoneyParents`).
- The conflict this fixes is between *browser sessions minutes apart*, not concurrent
  transactions — exactly what OCC is for. The existing `FOR UPDATE` locks stay as-is for the
  intra-transaction races they already cover.

### Deliberate non-goals

- **No merge UI.** A conflict rejects the whole save (the transaction rolls back — nothing
  partially applies) and tells the user which rows changed underneath them and to reload. Merging
  two people's line-item edits is not a problem this codebase needs to solve today.
- **`approvalStatus` writers do not bump `version`.** `updateItemApproval` /
  `bulkUpdateItemApproval` write only approval columns, which `toItemData` never sends. Bumping
  there would make every approval click conflict the next estimate save for no benefit.
- **`autoAssignPhasesForEstimate` does not bump `version`.** It writes `costCodeId` via
  `updateMany` from `after()` on *every* save. Bumping there would wedge the editor into a
  permanent conflict loop after each save. (It can still silently overwrite a stale `costCodeId`
  from the editor — pre-existing behavior, unchanged by this work, noted here so the next reader
  doesn't think it regressed.)
- ~~**Server-side item creators** are untouched.~~ **Superseded by REVISION 2:** server-side
  creators that add rows to an *existing* estimate now bump `itemsRevision` inside the same
  transaction as the insert (`addVoiceEstimateItem`, `gpt-estimate`'s rewrite), so a stale editor
  save is rejected instead of deleting the new rows as "removed by the user". Creators that build
  a brand-new estimate need no bump. Known remaining gap: `scripts/import-houzz.mjs` can append
  items to an existing estimate without locking or bumping — it is an operator-run offline import,
  not live traffic, and is deliberately left alone here rather than widening this PR.

## Goal 1 — schema

1. `prisma/schema.prisma`, `model EstimateItem`: add

   ```prisma
   /// Optimistic-concurrency guard for the editor save path. Bumped by saveEstimate on every
   /// line-item write; a save carrying a stale version is rejected instead of silently winning.
   version Int @default(0)
   ```

2. `scripts/apply-estimate-item-version.mjs` — additive + idempotent, same shape as the existing
   `scripts/apply-*.mjs` (raw `$executeRawUnsafe` over the pooler):

   ```sql
   ALTER TABLE "EstimateItem" ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 0;
   ```

   Per CLAUDE.md this must run against prod **before** the deploy that ships the new Prisma
   client, or every page selecting items throws P2022.

## Goal 2 — `saveEstimate` compare-and-set

In the item upsert loop (both the parent and child pass):

- `toItemData` keeps its current shape; the update path must send the data **without `id`**
  (`updateMany.data` cannot set the primary key).
- Existing row (`item.id && existingItemsMap.has(item.id)`):
  - `const expected = typeof item.version === "number" ? item.version : null`
  - `expected === null` (row unknown to this editor session — a stale bundle, or a row this
    session never loaded): fall back to today's unchecked `update`, still incrementing `version`.
    Documented as the compatibility escape hatch for the rolling-deploy window, not as a
    supported path.
  - `expected !== null`: `updateMany({ where: { id, version: expected }, data: { …itemData, version: { increment: 1 } } })`.
    `count === 0` ⇒ push `{ id, name: existing.name }` onto a `conflicts` array. Do **not** throw
    inside the loop — collect them all so the user sees every conflicting row, not just the first.
- New row: `create` as today (no explicit `version`; the default 0 applies). The create path must
  stay id-specifying — undo-of-delete depends on re-creating rows under their original ids.
- Collect `itemVersions: Record<string, number>` inside the transaction: `expected + 1` for
  checked updates, `existing.version + 1` for unchecked ones, `0` for creates.
- After both passes, if `conflicts.length > 0`, throw a module-local sentinel
  (`class EstimateItemConflictError extends Error { constructor(public conflicts: {id,name}[]) }`)
  so the whole transaction rolls back. `withTxRetry` only retries P2034/P2028/40P01/40001, and the
  outer fallback only catches P2022, so a sentinel propagates cleanly through both — verify this
  in review, it is the load-bearing assumption.

Return shape (`saveEstimate`'s existing `{ success: true }` becomes):

- success: `{ success: true, itemVersions }`
- conflict: caught outside the transaction, returned as
  `{ success: false, conflict: { items: [{ id, name }] } }`

**Return, don't throw, for the conflict.** Prod redacts thrown server-action messages, so a
thrown error reaches the client as a generic failure and the editor could not name the rows.

Skip the `revalidatePath` calls and the `after(autoAssignPhasesForEstimate)` scheduling on the
conflict path — nothing was written.

## Goal 3 — editor: track versions, surface conflicts

`src/app/projects/[id]/estimates/[estimateId]/EstimateEditor.tsx`

- `const itemVersionsRef = useRef<Record<string, number>>(...)` seeded from
  `initialEstimate.items` (`id → version ?? 0`).

  **Versions live in a ref, not in the item objects.** Item objects flow through
  `getEstimateSnapshot` (change detection), `captureHistory` (deep-cloned undo snapshots), and
  `spliceBackByIndex`. A `version` field inside them would (a) make every post-save version merge
  look like a local edit and start an autosave loop, and (b) restore *stale* versions on an
  undo/history revert, conflicting the save against a row this same session wrote. A ref keyed by
  id sidesteps both.

- In `runSave`, stamp the payload:
  `serializeEstimateItemsForSave(sourceItems).map(it => it.id ? { ...it, version: itemVersionsRef.current[it.id] } : it)`
  (leave `version` absent when there is no id or no tracked version — the server's escape hatch).
- On `{ success: true, itemVersions }`: `Object.assign(itemVersionsRef.current, itemVersions)`
  before `lastSavedStateRef.current` is updated. Autosave depends on this: without it the second
  autosave from the same open editor conflicts with the first one's own write.
- On `{ success: false, conflict }`:
  - Do **not** update `lastSavedStateRef` (state stays dirty).
  - Do **not** run the pending-association restore and do **not** show the success toast.
  - Set a `saveConflictRef` / state flag that suppresses further **autosaves** (a manual save may
    still be attempted, and will fail the same way) so the editor doesn't retry the doomed payload
    on a timer.
  - Surface a persistent (`duration: Infinity`) `toast.error` naming the rows:
    `Someone else changed "Tile" and "Demo" since you opened this estimate. Your changes were not saved.`
    with a `Reload` action that does `window.location.reload()`. Blunt but honest — reloading
    discards local edits, and that is stated in the toast copy.
  - `runSave` must return/short-circuit such that callers relying on its resolution (the undo
    toast's retry path, `retryAssociationRestore`) do not treat a conflict as success. Prefer
    throwing a client-side `Error` after the toast is shown, so the existing `catch` semantics of
    every caller hold — but suppress the generic "Failed to save" toast for this case (the
    conflict toast already said it better).

## Goal 4 — `updateItem` keyed by stable id + patch object

Same file, `updateItem(index, field, value)` (~line 1543) becomes:

```ts
function updateItem(itemId: string, patch: Record<string, any>) {
    setItems(prev => {
        const next = prev.map(it => (it.id === itemId ? { ...it, ...patch } : it));
        itemsRef.current = next;
        return next;
    });
}
```

Functional updater + in-updater `itemsRef` sync, matching `applyPoLinkChange` (same reasoning:
rapid-fire handlers each hold their own render closure).

Every row created client-side already gets an id from `generateId()` via `makeBlankItem` /
`addCategoryAfter`, so id-keying covers new rows too.

Update all call sites (~12) including `BudgetStrip`'s `updateItem` prop and its `BudgetStripProps`
type; `BudgetStrip` should receive `item.id` instead of `index` for this purpose (its `index` prop
may still be needed elsewhere — check before removing it).

The two categories of caller that were actually broken (index captured before an `await`, so a
reorder or delete mid-flight applied the edit to the wrong row):

- `suggestDescription(itemIndex)` (~line 493) — awaits `/api/ai-estimate/suggest`.
- the four approval callbacks (~2674/2679/2685/2688) — `await updateItemApproval(...)` then
  `updateItem(index, "approvalStatus", …)`.

`suggestDescription`/`suggestSubitems` should capture `item.id` up front and use that after the
await.

## Already fixed — verify, don't reimplement

The two "related items" from the review are both closed:

1. **PO link/unlink/create callbacks keyed by index** — already fixed. `applyPoLinkChange`,
   `handleSelectPO`, `handleUnlinkPO`, `handlePOCreated` all key by `itemId` through a functional
   updater.
2. **`quickCreatePOAndLink` non-transactional** — already fixed. It creates the PO, the join row,
   and resyncs the legacy mirror inside one `withTxRetry(prisma.$transaction(...))`, under
   `lockEstimateItemLinks` (PurchaseOrder → Estimate → EstimateItem, sorted ids), with a P2002
   retry loop for the `code` TOCTOU. Its own comment records the orphan-PO bug this spec cites as
   the prior behavior.

Confirm both with a read before touching anything; report if the current code disagrees.

## Verification

1. `npm run build` — 0 errors.
2. Unit/spec coverage for the conflict path (Vitest, alongside existing lib tests): a stale
   version is rejected, the fresh one wins, `itemVersions` round-trips, and a conflict rolls back
   the *whole* save (the estimate header fields must not have moved either).
3. `e2e/money-pipeline.spec.ts` green (it does not exercise the item editor, but it is the
   money-path gate).
4. Manual two-tab check on prod after deploy against the sanctioned test project "Shop"
   (`cmpd6xca1009x1iizdf4suln3`): open the same estimate twice, edit a quantity in tab A and save,
   then edit a different quantity in tab B and save ⇒ tab B is rejected with the named-rows toast,
   tab A's edit survives. Then reload B and confirm its save succeeds.
5. Codex peer review on the diff (money path, per CLAUDE.md).

## Deploy order (CLAUDE.md)

1. `node scripts/apply-estimate-item-version.mjs` against prod.
2. `npm run build` locally.
3. `vercel --prod` from the canonical checkout.
4. Two-tab check above.
