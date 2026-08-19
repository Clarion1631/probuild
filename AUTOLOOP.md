# Autonomous Fix Loop — Setup Guide

An autonomous pipeline on your GitHub + Vercel + Supabase stack, manageable
entirely from your phone. Runs on SUBSCRIPTIONS (Claude Max + ChatGPT Pro) —
no API keys.

## The loop

```
Issue (label: auto-fix)
  → Planner: Claude Fable 5 subagent — plan + visual acceptance criteria
  → Executor: Claude Opus 5, medium effort — implement, test, open PR
  → Reviewer: Codex CLI (gpt-5.6-sol, xhigh) — adversarial review gate
      ↳ REQUEST_CHANGES → Claude fixes → re-review (automatic loop)
  → Gauntlet visual verify: real Chromium against the Vercel PREVIEW deploy
      ↳ builder/critic screenshot loop, 100% of criteria or the gate fails
  → Auto-merge → Vercel production deploy (Git integration)
      → optional Supabase migration push
  → Notify (Google Chat webhook / GitHub mobile push)
```

## Install

1. This kit lives in `.github/workflows/`, `.claude/agents/`, `.claude/skills/`.
2. Labels `auto-fix` and `claude-fix` must exist (created automatically if this
   was installed by Claude).
3. Repo secrets (Settings → Secrets and variables → Actions) — subscription
   auth, no API keys:
   - `CLAUDE_CODE_OAUTH_TOKEN` — on your PC run `claude setup-token` (use the
     Max account you want to dedicate to automation) and paste the token.
   - `CODEX_AUTH_JSON` — on your PC run `codex login` (ChatGPT Pro account),
     then paste the full contents of `~/.codex/auth.json`
     (Windows: `C:\\Users\\<you>\\.codex\\auth.json`). Note: tokens rotate;
     if the review job starts failing auth, re-login locally and re-paste.
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TEST_USER_EMAIL` — for
     visual verification behind Google login: CI never touches Google's OAuth
     UI; it mints the Supabase session directly for a seeded test user (see
     gauntlet-verify SKILL.md). Copy the Supabase values from Vercel env vars.
   - Optional: `GCHAT_WEBHOOK_URL` (ship notifications),
     `VERCEL_AUTOMATION_BYPASS_SECRET` (if deployment protection is on).
4. Vercel: keep the Git integration on so previews build per-PR and production
   deploys on merge to main. The gate waits for the preview URL automatically.
5. Branch protection on main: require the `codex-review` and
   `gauntlet-visual-verify` checks so nothing merges around the gates.

## Running and steering from your phone

- The loop runs itself hourly (edit the cron in `claude-auto-fix-loop.yml`).
- To feed it: open a GitHub issue from the GitHub mobile app and add the
  `auto-fix` label. That's the entire API.
- To kick it immediately: GitHub app → Actions → Claude Auto-Fix Loop → Run
  workflow.
- To watch/steer interactively: Claude mobile app → Code tab (cloud sessions,
  also included in your Max plan).
- Notifications: GitHub mobile push covers PR/merge events; the Google Chat
  webhook step pings your space on each shipped fix.

## Tuning knobs

- Executor model/effort: `--model claude-opus-5 --effort medium` in
  `claude_args` (both workflows).
- Planner model: `model: claude-fable-5` in `.claude/agents/planner.md`.
- Reviewer: `--model gpt-5.6-sol -c model_reasoning_effort="xhigh"` in
  `claude-pr-gate.yml`.
- Verification strictness: rounds and criteria rules in
  `.claude/skills/gauntlet-verify/SKILL.md`.
- Rate limits: the loop consumes your Max plan's usage. With 2× Max accounts,
  dedicate one account's setup-token to CI and keep the other for your own
  interactive Claude Code sessions so the loop never starves you.

## Safety rails baked in

- Concurrency group = one issue in flight at a time.
- allowedTools whitelists (no dangerous permission bypasses).
- Codex verdict + visual gauntlet are required checks; failed/inconclusive
  verification exits nonzero and blocks merge.
- DB changes only via committed Supabase migrations.
- Planner stops with HUMAN DECISION REQUIRED for irreversible/product calls.
