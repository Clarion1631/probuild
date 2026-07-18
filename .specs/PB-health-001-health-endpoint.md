# Spec: Add /api/health endpoint

**ID:** PB-health-001
**Date:** 2026-04-09
**Status:** implemented; proxy contract corrected 2026-07-17

## Context
ProBuild needs a lightweight, unauthenticated deployment probe. The endpoint must be excluded by both production proxy matching paths so deployment checks and external uptime monitors do not rely on loading the full home page.

## Production contract

- Supported probe: `https://probuild.goldentouchremodeling.com/api/health`
- Authentication: none for the exact `/api/health` path
- Response: HTTP 200 with `{ "status": "ok", "ts": "<ISO 8601 timestamp>" }`
- Cache policy: `Cache-Control: no-store, max-age=0`
- Dependency scope: web-process deployment probe only; no database, storage, or third-party readiness claim
- `/api/version`: public deployment identity for stale-client detection, not readiness

## Proxy requirement

Both proxy matching paths exclude exactly `/api/health`. Nested paths such as `/api/health/private` remain protected; the exception does not widen another `/api` namespace.

## Goals
1. `GET /api/health` returns HTTP 200 with JSON body `{ "status": "ok", "ts": "<ISO 8601 timestamp>" }`.
2. The endpoint requires no authentication.
3. Response time is under 50ms (no database or external calls).

## Non-Goals
- Dependency-readiness checks (database, storage, or third-party connectivity).
- Separate readiness and liveness endpoints; this probe covers only web-process deployment/liveness.
- Rate limiting.

## Approach
Use a Next.js App Router route handler at `src/app/api/health/route.ts`. Export a single `GET` function that returns only `{ status: "ok", ts: new Date().toISOString() }` with `Cache-Control: no-store, max-age=0`. No auth, database access, storage, or third-party calls. Mark the route as `dynamic = "force-dynamic"` and exclude only the exact path from both production proxy matching paths.

## Files Touched
- `src/app/api/health/route.ts`
- `src/proxy.ts`
- `e2e/auth-status.spec.ts`

## Data Model Changes
None

## Test Plan
1. Run `curl http://localhost:3000/api/health` and confirm HTTP 200 with the expected JSON shape.
2. Verify `ts` is a valid ISO 8601 string within a few seconds of the request time.
3. Run the production proxy test locally and confirm the exact health path is public while `/api/health/private` remains protected.
4. After deploy, hit `https://probuild.goldentouchremodeling.com/api/health` and confirm the same.

## Rollback Plan
Revert the scoped health-contract commit (or remove the route plus both exact proxy exceptions) and redeploy. No migrations or state require rollback.

## Open Questions
None -- this is self-contained.
