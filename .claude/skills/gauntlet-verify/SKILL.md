---
name: gauntlet-verify
description: Gauntlet-style visual verification of a deployed fix. Use after a preview or production deployment to verify, in a real browser, that every visual acceptance criterion for a fix is 100% met. Loops screenshot → critique → re-check until verified or failed.
---

# Gauntlet Visual Verify

Verify a deployed fix in a real browser using a builder/critic loop. You are
given a URL and a set of visual acceptance criteria (from the PR body or the
planner's plan). The fix is only "in" when every criterion is verifiably true.

## Setup

Use Playwright with the preinstalled Chromium:

```bash
npm i -D playwright @playwright/test 2>/dev/null || npm i -g playwright
```

Write a small script per criterion that navigates, performs the interaction,
and saves a screenshot to ./gauntlet-shots/<criterion-N>.png. Use
`executablePath` from the environment's Chromium if playwright's download is
blocked.

## Auth (Google-login apps — DO NOT automate Google OAuth)

Never drive the Google OAuth screen in CI — Google blocks automated logins and
it will flake forever. The app's session is a SUPABASE session; Google is only
the identity provider. Mint the session directly:

1. A seeded test user exists (email in `TEST_USER_EMAIL`). Using
   `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (CI secrets), call the admin
   API to mint tokens for that user:
   ```js
   const { createClient } = require('@supabase/supabase-js');
   const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
   const { data } = await admin.auth.admin.generateLink({ type: 'magiclink', email: process.env.TEST_USER_EMAIL });
   // Open data.properties.action_link in the browser once — it lands authenticated —
   // or verify the token_hash via supabase.auth.verifyOtp to get a session, then
   // inject the access/refresh tokens into the app's storage before page load.
   ```
2. Save the authenticated state once per run with Playwright
   `context.storageState({ path: 'auth.json' })` and reuse it for every
   criterion check (`browser.newContext({ storageState: 'auth.json' })`).
3. If the Vercel deployment has protection enabled, send the
   `x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET` header
   (set as extraHTTPHeaders in the Playwright context).
4. If the fix under test is ABOUT the login flow itself, verify up to the
   Google redirect (correct button, correct redirect URL params) and verify
   the post-login state via the minted session — never through Google's UI.

## The loop (max 3 rounds)

1. BUILDER pass: for each criterion, drive the browser through the exact user
   path described, capture a screenshot at the moment the criterion should be
   observable, plus the console log.
2. CRITIC pass: spawn a fresh subagent (Task tool) whose ONLY input is the
   screenshots and the criteria text — not your reasoning. It must answer,
   per criterion: VERIFIED / NOT VERIFIED / INCONCLUSIVE, with one sentence
   of evidence ("error text 'Invalid email' visible under field").
   The critic must be harsh: an INCONCLUSIVE screenshot is NOT a pass.
3. If anything is NOT VERIFIED or INCONCLUSIVE: adjust the browser script
   (wrong selector, needed to wait for hydration, wrong viewport), or if the
   app is actually wrong, the gate FAILS — do not paper over it.
4. Repeat up to 3 rounds. All-VERIFIED → pass. Otherwise → fail.

## Reporting

- Pass: comment on the PR: "🏁 Gauntlet visual verification: N/N criteria
  VERIFIED" with the evidence list, and attach/upload screenshots
  (gh pr comment; commit screenshots to the branch under .gauntlet/ if
  attachments aren't possible). Exit 0.
- Fail: comment with the failing criteria + screenshots and exit 1 so the CI
  gate blocks the merge. Never exit 0 on a failed or inconclusive verification.

## Console + network checks (always)

Regardless of criteria, fail if the page under test logs uncaught exceptions
or returns 5xx responses on the tested paths. Include these in the report.
