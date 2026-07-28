# CLAUDE.md — ProBuild Project Context

## What this project is
**ProBuild** — a construction/contractor management platform (competitor to Houzz Pro). Built with Next.js, Prisma, Supabase, deployed on Vercel.

## Key paths & service IDs
| Thing | Value |
|---|---|
| This project (Windows) | `C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-site` |
| GitHub | https://github.com/Clarion1631/probuild |
| Production | https://probuild.goldentouchremodeling.com |
| Vercel preview | https://probuild-amber.vercel.app |
| Vercel project ID | `prj_sd7R3WIYZCRMnu5IhAudBdc4vuIL` |
| Supabase project ref | `ghzdbzdnwjxazvmcefbh` |
| Sentry org | `golden-touch-remodeling` (us.sentry.io) |
| Known prod DB project ID | `cmn7tlgiv0001phwqjzwk75or` |

## Vercel env vars (already configured)
`STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `DATABASE_URL`,
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`,
`RESEND_API_KEY`, `GEMINI_API_KEY`,
`NEXTAUTH_SECRET`, `NEXTAUTH_URL`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`NEXT_PUBLIC_APP_URL`,
`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`

## Stack
- Auto-deploy is **disabled**. Deploy manually via `vercel --prod` — see the `deploy-probuild` skill.

## Room Studio (3D room designer)
- Lives in `src/components/studio/` + `src/lib/studio/` (react-three-fiber). The legacy `room-designer` modules are gone — don't recreate them.
- Document model: `RoomDesign.layoutJson` holds a v2 `DesignDoc` (`lib/studio/doc.ts`); placed items mirror into `RoomAsset` rows. v1 layouts upgrade on load.
- Catalog/finishes/templates are code-seeded (`lib/studio/catalog.ts`, `materials.ts`, `templates.ts`) — no GLTF downloads, all meshes procedural (`components/studio/canvas/builders-*.tsx`).
- Perf contract: nothing writes to the zustand store per-frame; drags mutate three.js objects and commit on pointerup. No postprocessing. Keep it that way.
- LiDAR intake: `POST /api/rooms/scan-import` (RoomPlan JSON or simplified corners). Mobile capture screen: gtr-probuild-mobile `apps/mobile/app/room-scan.tsx`.
- Client sharing: `/share/room/[token]` (public route in AppLayout) + portal Designs tab lists share-enabled rooms.

## Product Vision
See **VISION.md** — AI-first remodeling platform. Every feature should ask: "What can AI do here so the human doesn't have to?"

## Design System
See **DESIGN_SYSTEM.md** — standardized colors, typography, page layouts, and components. Every new page must follow one of the 4 layout templates (List, Form, Editor, Full-Width Tool). Use shared components: StatCard, TabButton, EmptyState, StatusBadge.

## Active Build Plan
See **ProbuildTodo.md** — execute sessions in order (Sessions 3–7 remain).
Sessions 1–2 + Gantt polish are complete. Each session lists specific files, actions, and schema changes.

## Development workflow
```
1. Pick next session from ProbuildTodo.md
2. Make changes
3. npm run build          # must pass 0 errors
4. git push origin main
5. Schema changed? Run the branch's scripts/apply-*.mjs against prod FIRST (see "Deploying to Vercel")
6. vercel --prod --token $env:VERCEL_TOKEN   # deploy only when ready
7. Click through affected pages on prod to verify
8. Mark items done in ProbuildTodo.md
```

## Deploying to Vercel — hard rules
Full procedure lives in the `deploy-probuild` skill. Non-negotiables:
- Auto-deploy is OFF (disabled in `vercel.json` after a $250 runaway-build bill). Do **NOT** re-enable it in vercel.json or the Vercel dashboard.
- **Schema changed?** If the branch edits `prisma/schema.prisma` and ships a `scripts/apply-*.mjs`, run it against prod **BEFORE** deploying. The new build's Prisma client selects the new columns immediately, so any page querying them throws P2022 until the script runs.
- Deploy from the main repo dir, never a worktree (worktrees lack the `.vercel` link).

## E2E testing — never against the live DB
E2E creates real leads/estimates/invoices. Never point it at prod. Details and guard rails: **docs/TESTING.md**.

## Dev server
Always use port 3000 — if it's taken, kill it, don't switch ports. Clean-start recipe: `probuild-dev-server` skill.

## Schema migrations
> `npx prisma db push` hangs interactively. `prisma migrate dev` fails (port 5432 blocked on free tier).

Use the `probuild-schema-migration` skill for the working procedure.

## Critical database config
- **DATABASE_URL must include `?pgbouncer=true`** — Supabase transaction pooler (port 6543) + Prisma requires this. Without it: `42P05 prepared statement already exists` and the site goes down.
- Correct format: `postgresql://...@aws-0-us-west-2.pooler.supabase.com:6543/postgres?pgbouncer=true`
- DIRECT_URL uses port 5432 on `db.ghzdbzdnwjxazvmcefbh.supabase.co` (for migrations only)

## Production data
- Known prod project ID: `cmn7tlgiv0001phwqjzwk75or`
- Do NOT try psql, prisma direct connect, or supabase CLI to query prod — use the API

## Messaging component
`src/components/ClientMessaging.tsx` is the single canonical messaging component used by both lead pages (`/leads/[id]`) and project pages (`/projects/[id]/messages`). It accepts a swappable `headerContent` slot for per-context headers. `LeadMessaging.tsx` was deleted in commit `363b70c`.

## Common pitfalls
- **config.py is gitignored** — never commit it, it contains secrets
- **GoldenTouch Pro URL** is `https://probuild-amber.vercel.app` — that's the live Vercel deployment
- **WSL env vars** — `setx` vars (VERCEL_TOKEN, STRIPE_API_KEY, etc.) are Windows-only, NOT available in WSL

## UI: hover-reveal buttons must support no-hover devices
ProBuild is used across different browsers, OS configs, and pointer types (some users may be on Chromebooks or devices where CSS `:hover` doesn't fire reliably). **Any button hidden via `opacity-0 group-hover:opacity-100` MUST also include `[@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto`** so it stays visible on devices without reliable hover. This was discovered when Richard's browser silently hid all Add Sub-item / Add Category / delete buttons on the estimate editor.

Pattern to use:
```
className="opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto transition"
```

## Feature Decision Rule
Before building anything, answer: **"What remodeling problem does this solve, for which role, and can AI automate it?"**
If a feature doesn't map to a real workflow step for a real role (estimator, PM, field crew, bookkeeper, owner, client, sub), don't build it. No redundancy.

## Coding rules

- **Design system** — follow `DESIGN_SYSTEM.md`. Use `hui-btn`, `hui-card`, `hui-input`, shared components (StatCard, TabButton, EmptyState, StatusBadge). Every page follows one of the 4 layout templates.
- **Server actions** — go in `src/lib/actions.ts` by default; existing split files (client-actions.ts, lead-note-actions.ts, subcontractor-actions.ts) are legacy — don't add new ones
- **Server components by default** — only add `"use client"` when strictly needed (event handlers, hooks, browser APIs)
- **No dummy UI** — every button, link, and form must be fully wired before committing
- **Database** — always use Prisma (`src/lib/prisma.ts`), not direct Supabase client, for data access; Supabase is auth/storage only
- **Schema changes** — do NOT use `npx prisma db push` (hangs in WSL) or `prisma migrate dev` (port 5432 blocked). Instead: apply SQL via `C:\Users\jat00\AppData\Local\Temp\apply_schema.ps1`, then regenerate client via **PowerShell** (never Git Bash — Git Bash triggers `copyEngine: false` which breaks the local dev engine)
- **Auth roles** — ADMIN, MANAGER, FIELD_CREW, FINANCE — check `src/lib/permissions.ts` before adding role-gated UI
- **Toasts** — use `sonner` (already in layout), not any other toast library
- **Existing routes** — check `src/app/` before adding one; don't duplicate
- **Money-path changes** (payments, signing, payment mirrors, notifications) — estimate/invoice milestones are mirrored pairs linked by `PaymentSchedule.sourceScheduleId`; settling or unsettling either side must update both. ALL paid-milestone side effects (team email, client receipt, activity log) flow through `notifyMilestonePaid()` in `lib/payment-notifications.ts` — never add a second writer for a lifecycle event (two duplicate loggers shipped that way before the June 2026 audit caught them). After touching these paths: run codex-peer-review on the diff and keep `e2e/money-pipeline.spec.ts` green (PR CI runs it — it guards the sign→convert→invoice chain, mirror links, undo restore, and exactly-once activity writers).

## Efficiency rules (token management)
- **Full context, minimum tokens** — read the 4 reference docs (CLAUDE.md, VISION.md, DESIGN_SYSTEM.md, ProbuildTodo.md) for context, then build. Don't explore the codebase unless you're editing a file you haven't seen.
- **Run parallel sub-agents** for independent work (e.g. building 3 report pages simultaneously in separate agents)
- **Don't re-read large files** — if you already know the structure, reference it. GanttChart.tsx is 17k tokens — don't read it unless editing it.
- **Batch tool calls** — make independent reads/greps/globs in parallel, not sequential

## Dead buttons / unlinked UI
- While working on any page, audit all buttons, links, and nav items for dead ends
- **Always fix, never remove** — wire to the correct route or server action
- Wiring must be intelligent — a "New Invoice" button should open an invoice form, not just navigate to /invoices
- If the target page/modal doesn't exist yet, build a minimal but real version — not a placeholder
