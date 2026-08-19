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
and saves a screenshot to ./gauntlet-shots/<criterion-N>.png.

## Auth — how to log in (IMPORTANT: this app does NOT use Supabase Auth)

ProBuild's users live in a Prisma `"User"` table in Postgres (columns include
email, role, pinCode); `auth.users` is empty. Google is the SSO front door for
office users — NEVER automate the Google OAuth screen in CI (Google blocks
automated logins; it will flake forever).

Do this instead, in order of preference:

1. READ THE AUTH CODE FIRST. Look at the app's auth implementation
   (`app/api/auth`, NextAuth config, middleware, any PIN/crew login route)
   and pick the non-Google login path that exists.
2. PIN / credentials login: if the app has a PIN or credentials flow (the
   `pinCode` column suggests a field-crew PIN login), fetch the test user's
   record via the service-role connection and log in through the UI:
   ```js
   const { createClient } = require('@supabase/supabase-js');
   const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
   const { data: user } = await db.from('User').select('*')
     .eq('email', process.env.TEST_USER_EMAIL).single();
   // use user.pinCode (or equivalent) in the app's own login form
   ```
3. Session-token mint: if the app uses NextAuth JWT sessions and a
   `NEXTAUTH_SECRET` env var is available, craft a valid session cookie for
   the test user and set it on the Playwright context before page load.
4. If no non-Google path is possible, verify every logged-OUT criterion,
   then FAIL the auth-dependent criteria with reason "AUTH BLOCKED — needs
   TEST_USER_PIN or NEXTAUTH_SECRET secret" — never fake a pass, never
   attempt Google's UI.

Save the authenticated state once per run (`context.storageState({ path:
'auth.json' })`) and reuse it for every criterion. If the Vercel deployment
has protection enabled, send `x-vercel-protection-bypass:
$VERCEL_AUTOMATION_BYPASS_SECRET` as an extra HTTP header.

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
