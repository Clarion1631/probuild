# Mobile App Testing

How the ProBuild mobile app (repo `gtr-probuild-mobile`, Expo 54) is tested. Four layers, from cheapest to heaviest. See `docs/TESTING.md` for the web suite and the hermetic-DB rules that apply to everything here.

## Layer 1 — API contract tests (this repo, runs in CI)

`e2e/mobile-api.spec.ts` hits the mobile-facing endpoints directly (PIN login, `/api/mobile/me`, time-entries auth matrix + cost math, schedule/today, time-suggestion). Runs in the normal `npx playwright test` pipeline on every PR against the throwaway Postgres container. Fixtures come from `e2e/data.setup.ts` (`field-crew@test.local` PIN 246810, `manager@test.local` PIN 135790, the `e2e-mob-*` estimate/task/daily-log rows).

## Layer 2 — Expo-web E2E (local launch gate, NOT in CI)

The mobile app's web build runs the same React code as iOS/Android, so a browser suite drives the real field screens. Specs live in `e2e/mobile-app/` and run with their own config:

```bash
set MOBILE_APP_DIR=C:\Users\jat00\workspaces\golden-touch\active\gtr-probuild-mobile
npm run test:mobile-e2e
```

What that does (`e2e/mobile-app/run-mobile-e2e.mjs`):
1. `npx expo export --platform web` in the mobile checkout (skip with `SKIP_MOBILE_BUILD=1`).
2. Runs `playwright.config.mobile.ts`: Next dev server on :3000 + `serve-mobile-web.mjs` on :19006 (static export, `/api/*` proxied to :3000 — the same same-origin shape prod uses via Vercel rewrites; no CORS, no app changes).
3. Specs log in via PIN through the real UI (Google OAuth is not headless-testable — that's on the device checklist). `workers: 1` on purpose: the specs share one crew user and mutate punches; do not parallelize.

DB rules: point `DATABASE_URL` at a local throwaway Postgres (docs/TESTING.md local recipe) with `PLAYWRIGHT_TEST_SECRET`, `E2E_STORAGE_MOCK=1`, `SELECTION_AI_MOCK=1`, `DAILY_LOG_MATCH_AI_MOCK=1`. The `data.setup.ts` prod-DB guard aborts if it smells Supabase.

Not in CI because the two repos are separate on GitHub; wiring a cross-repo checkout (PAT + actions/checkout) is a known follow-up. Until then this suite is the documented pre-release gate: run it before every store/TestFlight/OTA release.

## Layer 3 — Unit tests (mobile repo)

`apps/mobile`: `npm test` (jest-expo). Covers the API client's failure modes (401 → logout, timeouts, suggestion fetch never throwing), the auth store bootstrap, and pure time math. Cheap — run on any mobile change.

## Layer 4 — Manual device checklist (native-only)

`MANUAL-DEVICE-CHECKLIST.md` in the mobile repo root: Google OAuth, secure-store persistence, background geofence, push notifications, camera, LiDAR/AR, OTA application, meal-break modal, and the clock-in suggestion dialog on a real project. One iOS + one Android pass before each release. ~30 minutes.

## Release gate summary

Before `eas update` / `eas submit`:
1. CI green on the web repo (includes Layer 1).
2. `npm run test:mobile-e2e` green locally (Layer 2).
3. `npm test` green in `apps/mobile` (Layer 3).
4. Device checklist pass on both platforms (Layer 4).
