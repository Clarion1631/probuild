# Spec: Add /api/health endpoint

**ID:** PB-health-001
**Date:** 2026-04-09
**Status:** draft

## Context
ProBuild has no health-check endpoint. Vercel deployment checks and external uptime monitors (e.g., BetterUptime, UptimeRobot) need a lightweight, unauthenticated URL to probe. Without one, we rely on loading the full home page to detect outages, which is slow and brittle.

## Goals
1. `GET /api/health` returns HTTP 200 with JSON body `{ "status": "ok", "ts": "<ISO 8601 timestamp>" }`.
2. The endpoint requires no authentication.
3. Response time is under 50ms (no database or external calls).

## Non-Goals
- Deep health checks (database connectivity, third-party service status).
- Readiness vs. liveness distinction -- a single endpoint is sufficient for now.
- Rate limiting or caching headers.

## Approach
Create a Next.js App Router route handler at `src/app/api/health/route.ts`. Export a single `GET` function that returns `NextResponse.json({ status: "ok", ts: new Date().toISOString() })`. No middleware, no auth, no database access. Mark the route as `dynamic = "force-dynamic"` so Vercel never caches a stale timestamp.

## Files Touched
- `src/app/api/health/route.ts` (new)

## Data Model Changes
None

## Test Plan
1. Run `curl http://localhost:3000/api/health` and confirm HTTP 200 with the expected JSON shape.
2. Verify `ts` is a valid ISO 8601 string within a few seconds of the request time.
3. After deploy, hit `https://probuild.vercel.app/api/health` and confirm the same.

## Rollback Plan
Delete `src/app/api/health/route.ts` and redeploy. No migrations or state to revert.

## Open Questions
None -- this is self-contained.

## Review — 2026-04-09

**Reviewer:** codex-reviewer + reviewer agent
**Verdict:** PASS

### Goal-by-Goal

| # | Goal | Result | Notes |
|---|------|--------|-------|
| 1 | `GET /api/health` returns HTTP 200 with JSON body `{ "status": "ok", "ts": "<ISO 8601 timestamp>" }` | PASS | `NextResponse.json({ status: "ok", ts: new Date().toISOString() })` matches the required shape exactly; Next.js defaults the status to 200. |
| 2 | The endpoint requires no authentication | PASS | No middleware, no auth imports, no guards of any kind in the route file. |
| 3 | Response time under 50ms (no database or external calls) | PASS | Handler is pure in-memory computation — `new Date().toISOString()` only. `export const dynamic = "force-dynamic"` prevents stale cached responses without adding latency. |

### Bugs
- None

### Security
- None

### Nits
- The `GET` function could be typed as `() => NextResponse` for explicitness, but this is not required and does not affect runtime behavior.
