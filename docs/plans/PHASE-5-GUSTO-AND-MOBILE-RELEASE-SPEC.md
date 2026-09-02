# Phase 5 — Gusto rates in, hours out, mobile app release

Date: 2026-09-01. Status: DRAFT for executor. Parent plan: `docs/plans/RECEIPT-PIPELINE-V2-PLAN.md` (decision 6, "Gusto" section, phase table row 5).
Repos: site = this repo; mobile = `C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-mobile` (branch `feat/breaks-crew-logistics`).
The CJ/Richard mobile-bug chat thread is NOT reachable from the planner; the orchestrator appends it as Appendix A. Every item in it becomes a ticket before store go-live.

## 0. Facts from code (grounding — executor: do not re-derive, cite these)

- `User.hourlyRate` / `burdenRate`: `Decimal @default(0)` — `prisma/schema.prisma:17-18`. No `lastRateSyncAt`; no `PayrollPeriod` model exists (grep = 0 hits).
- Rates are edited today on Company → Team Members: list shows rate (`src/app/company/team-members/page.tsx:206`), edit form has hourlyRate/burdenRate inputs saved via `fetch("/api/users/[id]")` (`src/app/company/team-members/[id]/page.tsx:75-76,127,354,363`).
- Clock-out is `PUT /api/time-entries` (`src/app/api/time-entries/route.ts`, `createClockOutHandler`). `laborCost = durationHours * owner.hourlyRate`, `burdenCost = durationHours * owner.burdenRate` (lines 458-459), always the entry OWNER rates. `durationHours` is PAID hours after the WA meal deduction (`computeMealDeduction`); `shiftHours` is the raw span. The edit path (`PATCH /api/time-entries/[id]`, lines 220-221) recomputes the same way; `DELETE` is manager/admin-only (lines 324-344).
- WA break model: `src/lib/wa-breaks.ts` — meal 30 min unpaid once a day passes 5h (second after 11h), auto-deducted at clock-out unless punched/waived/worked-through; outcomes include `DEFERRED` (mid-day close, settled by `settleDay` in `src/lib/wa-breaks-db.ts`).
- WA overtime already exists as a pure lib: `src/lib/overtime.ts` — weekly only, over 40h per Mon–Sun workweek in a caller-supplied TZ, 1.5x, entry attributed to the week its startTime falls in, only the 40h threshold splits an entry. WA has no daily overtime and no general double-time; the export double-OT column is structural (always 0.00) for CSV-shape compatibility.
- Pay-period math already exists: `src/lib/pay-period-summary-core.ts` — arbitrary `[start, end)` range, fetches full overlapping workweeks so straddling weeks split correctly, prices each entry at its own historical effective rate (laborCost divided by durationHours), DI-core with no prisma import (testable). REUSE this for the export; do not re-implement OT.
- A Gusto scaffold already exists: OAuth (`src/app/api/gusto/auth`, `callback`, `employee-mappings`, settings page `src/app/settings/integrations/gusto/page.tsx`, `getGustoSettings` in `src/lib/integration-store.ts`) and a per-ENTRY CSV export at `src/app/api/gusto/export/route.ts` (settles DEFERRED days first — keep that logic). That route has NO role check at all (proxy session gate only) — Phase 5 replaces and gates it.
- Manager review UI: `src/app/manager/time-entries/page.tsx` (MANAGER/ADMIN, filters, flagged tab, skip-lunch approvals). There is no "approved" state on TimeEntry — only `needsReview` and `markTimeEntryReviewed`.
- Permission key `financialReports` exists in `src/lib/permissions.ts:110`.
- Help/bug widget gates: `src/app/api/help-chat/bug-fix/route.ts:23-27` and `request/route.ts:13-17` both 403 unless role is ADMIN, session-only (`getServerSession`). Neither path is in `src/proxy.ts` `PUBLIC_PROXY_BYPASS_PATTERN` or `MOBILE_AUTHENTICATED_ROUTE_PATTERNS`, so a mobile Bearer token cannot reach them today.
- Mobile release state: `TIME-CLOCK-HANDOFF.md` (mobile repo root) — 1.1.1 built and signed both platforms; iOS build 44 VALID in internal TestFlight; Android versionCode 17 in Play review (Start full rollout, US only, managed publishing OFF); public iOS 1.1.0 build 42 still WAITING_FOR_REVIEW (do not cancel without Justin); `apps/mobile/eas.json` submit config still points at absent `./google-services.json` and track `internal`; `app.config.ts` version `1.1.1`.
- Mobile screens: `apps/mobile/components/TimeClock.tsx` (race-hygiene rules in handoff Process section; `lib/breakSession.ts` untouched through all review rounds — keep it that way), `app/(tabs)/history.tsx` (Task 7 round-6 concurrency fix spec in handoff), `app/(tabs)/expenses.tsx` (Phase 3 of the parent plan will replace its posting path with `/api/receipts/intake` — NOTE ONLY, do not touch in Phase 5).
- Gusto import format in-repo knowledge: only the comment header "Employee Name, Hours, Date, Project" in the old export. Everything else about the Gusto CSV is ASSUMPTION (see section 7).

## 1. Goals and acceptance criteria

| # | Goal | Technical acceptance | Visual acceptance (gauntlet-verify, verbatim) |
|---|---|---|---|
| G1 | Payroll rates panel + CSV import + lastRateSyncAt | unit tests on import diff; `npm run build` 0 errors | Company → Team Members shows a "Payroll rates" panel listing each active user with hourly rate, burden rate, and "Last synced" date; an Import CSV button opens a preview diff (old to new per user) with a Save button |
| G2 | Zero-rate clock-out block | route test: PUT clock-out for a $0-rate owner returns 422 code ZERO_RATE_BLOCKED; entry stays open | the manager time-entries page shows a red "No pay rate" badge next to any listed user whose hourly rate is $0 |
| G3 | Gusto hours export + review page | golden-file CSV test; endpoint 403 for FIELD_CREW | /manager/payroll-export shows a period picker, a per-employee table with Regular, OT, Double OT, and total hours columns, Download buttons for summary and detail CSVs, and a Lock period button |
| G4 | Period lock | route tests: PATCH/DELETE/PUT on an entry inside a locked period return 423; lock stores exportHash | after locking, /manager/payroll-export shows a "Locked" badge with date and locker name, and editing a time entry in that period from the manager page shows a "period locked" error |
| G5 | Bug widget for all staff + mobile entry point | route tests: FIELD_CREW session 200, unauthenticated 401, Bearer mobile auth 200 | the mobile app menu shows a "Report a bug" item; submitting it shows a confirmation toast |
| G6 | Parallel-period runbook | section 5 checklist committed in this doc; no code | n/a |

## 2. Rates in (G1, G2)

Schema: one migration in `prisma/migrations/` PLUS one idempotent `scripts/apply-payroll-phase5.mjs` run against prod BEFORE merge, per CLAUDE.md ("Schema migrations"; never edit the baseline):

1. `User.lastRateSyncAt DateTime?` — set whenever hourlyRate/burdenRate change, via import or the existing manual editor (truthful meaning: "last time this rate was confirmed").
2. `PayrollPeriod` table — definition in section 3.

Implementation plan:

1. `src/app/company/team-members/page.tsx` — add a "Payroll rates" panel (server-rendered section): all ACTIVATED users; columns name, role, hourlyRate, burdenRate, lastRateSyncAt (relative date, red when null or older than 90 days); red "No pay rate" marker when hourlyRate is 0 for FIELD_CREW/MANAGER.
2. New `src/app/company/team-members/RatesImport.tsx` (client) + `POST /api/users/rates-import` (ADMIN or `financialReports` via `hasPermission`): accepts an uploaded/pasted CSV from the Gusto employee export. Match by email first, else exact full name. Expected columns ASSUMPTION: employee name, email, compensation rate. First call returns a preview diff `[{userId, name, oldHourly, newHourly, matched | unmatched}]`; a second call with `confirm: true` and the same rows writes rates + `lastRateSyncAt` in one transaction. Burden is NOT in the Gusto employee export (section 7, risk 4) — the import updates hourlyRate ONLY; burdenRate stays hand-maintained in the existing `[id]` editor.
3. Zero-rate block — in `createClockOutHandler` (`src/app/api/time-entries/route.ts`), after `findOwnerRates` (~line 456): if `owner.hourlyRate === 0` AND the owner role is FIELD_CREW or MANAGER (extend `findOwnerRates` to also select role; ADMIN/FINANCE exempt — salaried, section 7 risk 3), return 422 `{ error: "Your pay rate isn't set up yet. Tell your manager — your time is still on the clock and will be paid once the rate is entered.", code: "ZERO_RATE_BLOCKED" }`. The entry stays OPEN. Mirror the same check in the PATCH edit branch when it closes an open entry (`[id]/route.ts`, before the cost computation at line 220) with the manager-facing message: "Set an hourly rate for {name} on Company → Team Members before closing this entry."
4. Mobile: handle `ZERO_RATE_BLOCKED` in the clock-out error path of `apps/mobile/components/TimeClock.tsx` — show the server message verbatim, keep the running timer, and do NOT clear durable break-session state (`lib/breakSession.ts` untouched).
5. Manager badge — `src/app/manager/time-entries/page.tsx`: red "No pay rate" badge on rows whose user has hourlyRate 0 (the page already includes `user` on each entry).

Do NOT wire the Gusto OAuth scaffold into any of this; rate import is CSV-only for Phase 5. Treat `api/gusto/auth` and `callback` as dormant.

## 3. Hours out (G3, G4)

Schema — `PayrollPeriod`: `id`, `periodStart DateTime`, `periodEnd DateTime` (half-open `[start, end)`), `lockedAt DateTime?`, `lockedById String?` (FK to User), `exportHash String?` (sha256 of the summary CSV at lock time), `createdAt`. Unique on `(periodStart, periodEnd)`.

Endpoint — `GET /api/time-entries/export/gusto?periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD&format=summary|detail`:

1. Auth: session role ADMIN or `financialReports` permission. Web-only — do NOT add it to the proxy Bearer allowlist. (The existing `/^\/api\/time-entries(?:\/[^/]+(?:\/(?:meal-skip|logistics))?)?\/?$/` pattern in `src/proxy.ts` does not match the two-segment `export/gusto` suffix; leave that as is.)
2. Reuse the DEFERRED-day settlement preamble from the current `src/app/api/gusto/export/route.ts` (never settle today, never settle a worker with an open punch), then DELETE that old unguarded route — its `employeeMappings` lookup (`getGustoSettings`) moves into the new endpoint for the Gusto Employee ID column.
3. Compute with `pay-period-summary-core.ts` / `src/lib/overtime.ts`: per employee over the range — regular hours, OT hours (over 40 per Mon–Sun workweek, America/Los_Angeles), double-OT always 0.00 (WA), from CLOSED entries only. `durationHours` already excludes meal deductions — never re-deduct.
4. Refuse with 409 (listing the offending rows) if any entry in range has `needsReview = true` or is still open with startTime in range. "Approved" for export means closed and not flagged; managers clear flags on /manager/time-entries first.
5. Summary CSV (one row per employee per period): `Employee Name, Email, Gusto Employee ID, Regular Hours, Overtime Hours, Double Overtime Hours, PTO Hours, Sick Hours` — PTO/Sick emitted as 0.00 (not tracked in ProBuild; entered directly in Gusto). ASSUMPTION: this matches the Gusto Plus/Premium hours-import template; the parallel run verifies the real header names — keep them in one exported constant so renaming is one line.
6. Detail CSV (one row per entry): date, employee, project, cost code, shiftHours, mealDeductionHours, paid durationHours, that entry's regular/OT split, and an `edited` flag from `isEdited`.

Review page — `/manager/payroll-export` (new; List layout per DESIGN_SYSTEM.md; gate ADMIN or `financialReports`): period picker (default = last full period, pending section 7 risk 2), per-employee totals table, warning banner listing the needs-review/open entries that block export, Download summary/detail buttons, and a Lock period button that upserts the `PayrollPeriod` row with `lockedAt`, `lockedById`, `exportHash`. Unlock is ADMIN-only and clears `lockedAt` (row and hash retained).

Lock enforcement — new `src/lib/payroll-period.ts` with `assertPeriodUnlocked(startTime: Date)`. Called by: the PATCH edit branch of `/api/time-entries/[id]` (checked against BOTH the existing and the new startTime), DELETE `/api/time-entries/[id]`, and PUT clock-out when `existing.startTime` falls inside a locked period. Blocked response: 423 `{ code: "PERIOD_LOCKED" }` with the period dates in the message. `settleDay` is only reached through those routes plus the export preamble; add a test proving that exporting an already-LOCKED period performs no settlement writes (read-only recompute, and the UI shows the stored exportHash for comparison).

## 4. Parallel pay period — go-live runbook (G6)

1. Before the period starts: rates imported (G1); zero $0-rate active crew; Appendix A bug list triaged to done or explicitly deferred.
2. During the period: crew uses the ProBuild time clock exactly as today; Gusto keeps its current entry method. Nothing changes for anyone yet.
3. At period end: a manager clears every flagged entry on /manager/time-entries; run /manager/payroll-export; download both CSVs.
4. Compare TO THE CENT, per employee: ProBuild (regular x rate + OT x 1.5 x rate) against the Gusto payroll journal for the same period. Reconcile any mismatch in the DETAIL csv first — meal deductions and week-boundary OT splits are the two expected divergence sources. Record the comparison table as a dated note in `docs/plans/`.
5. If it ties out: lock the period in ProBuild. Next period, Justin enters ProBuild's summary numbers into Gusto (manual Hours entry or CSV import per tier). Only after ONE clean switched period does independent Gusto keying stop.
6. Rollback rule: Gusto is always authoritative for pay. If the export is wrong mid-switch, pay from Gusto's own records, then unlock and fix in ProBuild. Never delay payroll on a ProBuild bug.

## 5. Mobile release (G5)

Remaining items, exactly as `TIME-CLOCK-HANDOFF.md` leaves them (2026-08-16 status: 1.1.1 store artifacts built; iOS build 44 in internal TestFlight; Android versionCode 17 in Play review; public iOS 1.1.0 build 42 WAITING_FOR_REVIEW, deliberately untouched).

Executor can do:

1. Task 7 round-6 `history.tsx` concurrency fix — follow the handoff's Task 7 requirements 1-8 verbatim (TDD with RED first; monotonically increasing ownership tokens on every fetchHistory; one shared synchronous mutation-in-flight guard for Save/Delete; blur/unmount invalidation; stale summary-warning gating; `TimeClock.tsx` unchanged; no scope creep). Verification gates: focused regression tests, `npm test -- --runInBand`, `npx tsc --noEmit`, `npm run lint`, `npx expo export --platform web`, plus a fresh adversarial review of the exact fix range.
2. Fix the Appendix A bugs — one commit per bug, regression test where testable, same review gates.
3. Bug-widget relaxation (site repo): in `src/app/api/help-chat/bug-fix/route.ts` and `request/route.ts`, replace the `role !== "ADMIN"` gate with: authenticated user whose `status === "ACTIVATED"` and role in ADMIN/MANAGER/FIELD_CREW/FINANCE. Switch both routes from `getServerSession` to `authenticateMobileOrSession` (`src/lib/mobile-auth.ts`) so a phone Bearer token works, and add `/^\/api\/help-chat\/(?:bug-fix|request)\/?$/` to `MOBILE_AUTHENTICATED_ROUTE_PATTERNS` in `src/proxy.ts` with the standard "bypass hands auth to the route" comment. Everything downstream (GitHub issue creation, HelpRequest insert) unchanged.
4. Mobile "Report a bug" entry point: a menu item on the profile/settings surface (same level as sign-out) opening a small form — title, description, auto-filled current screen name — POSTing `{ title, description, currentPage }` to `/api/help-chat/request` through `lib/api.ts` with the Bearer token. Success toast "Sent — thank you". No screenshot upload in v1.
5. Version bump to 1.1.2 in `apps/mobile/app.config.ts`, `eas build --profile production` for both platforms (`autoIncrement: true`, remote appVersionSource), iOS submit via the ASC API key already configured in `eas.json`.

Only Justin can do (credentials and store consoles — clearly separated):

1. Decide the fate of public iOS 1.1.0 build 42 (WAITING_FOR_REVIEW): let it land and ship 1.1.2 behind it, or cancel and submit 1.1.2 directly. The handoff forbids touching it without his explicit decision.
2. Google Play production submits stay MANUAL in the console (as was done for versionCode 17): `eas.json` points at an absent `./google-services.json` and submit track `internal`. Provisioning a Play service-account key is Justin's call.
3. App Store Connect login, Play Data-safety/listing edits, and any store review responses.
4. Approve build spend: Expo's included build credits were exhausted on 2026-08-16; new EAS builds may bill pay-as-you-go.

Phase 3 note (not Phase 5 work): `apps/mobile/app/(tabs)/expenses.tsx` will be repointed at `/api/receipts/intake` by the parent plan's Phase 3. Do not refactor it now; avoid merge-conflict-prone edits near it.

## 6. Tests

1. OT computation table (extend the pure-lib tests around `src/lib/overtime.ts` / `pay-period-summary-core.ts`): exactly 40h week (0 OT); 41h in one entry (1h OT split within the entry); workweek straddling periodStart (pre-period hours push in-period hours into OT); meal-deducted 9h shift paying 8.5h; multi-project same day (split entries, still one meal deduction per day); Sunday-to-Monday midnight entry attributed to the week of its startTime.
2. Export route: golden-file byte-compare of summary + detail CSVs from a 3-user fixture (one with OT, one meal-deducted, one zero hours); 403 for a FIELD_CREW session; 409 when a needsReview entry sits in range.
3. Period lock: lock then PATCH/DELETE/PUT each return 423; an edit MOVING an entry into a locked period returns 423; ADMIN unlock lets the edit through; exportHash identical across repeated downloads of a locked period; locked-period export performs zero settlement writes.
4. Zero-rate block: PUT returns 422 ZERO_RATE_BLOCKED and the entry stays open; manager PATCH close blocked with the manager message; an ADMIN-role owner is exempt.
5. Bug widget (request-level, per the contract-auth-behavioural-tests pattern): FIELD_CREW session 200; DISABLED user 403; no session 401; mobile Bearer 200; bogus Bearer 401.
6. Mobile: Jest for the round-6 request/mutation coordinator (RED recorded first, per the handoff), plus one test asserting the bug-report POST payload shape.

## 7. Risks / open questions (max 5)

1. ASSUMPTION — Gusto import format. Plus/Premium hours CSV is assumed to be one row per employee per pay period (regular / overtime / double overtime / PTO / sick); the Simple tier may only offer per-employee manual Hours entry. Parent-plan open question 3 (which tier?) is still unanswered; the parallel run (section 4, step 4) validates against the real template before anything depends on header names.
2. HUMAN DECISION REQUIRED — pay period definition: weekly or biweekly, and which weekday it starts on. Schema and endpoint take an arbitrary range so the build is not blocked, but the /manager/payroll-export default and the parallel comparison need Justin's answer before go-live.
3. Salaried staff (CJ at $92k, Richard at $80k — see memory gtr-labor-rates-co-pricing): they punch the clock for job costing, but Gusto pays them salary. The summary CSV should EXCLUDE salaried users while the detail CSV keeps them for costing. Needs Justin to confirm exactly who is salaried in Gusto (proposal: exclude role ADMIN plus a per-user flag if needed).
4. Burden does not go to Gusto at all — burdenRate is a ProBuild-only costing input layered on wages (payroll tax, workers comp). The rate import touches hourlyRate only. Deriving burden from Gusto's employer-cost report is a possible later phase, not this one.
5. Blocking clock-out on a $0 rate (as specified) leaves the punch OPEN; if the manager does not fix the rate same-day it becomes a forgotten punch (over 24h means edit-only close, `MAX_SHIFT_HOURS`). Mitigations shipped with G2: the manager badge and the mirrored manager-side message. Fallback if this bites in practice: close-and-flag (`needsReview`, reason "$0 rate at clock-out") — a one-line policy switch, flagged here so it is a decision, not a redesign.

## Appendix A — CJ/Richard mobile bug thread

(Appended by the orchestrator from the ProBuild team-chat thread. Each line becomes a ticket with a severity and a "fix before store go-live? y/n" call.)
