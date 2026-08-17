# Autonomous Fix Loop — Setup Guide

An autonomous pipeline on your GitHub + Vercel + Supabase stack, manageable
entirely from your phone.

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
3. Repo secrets (Settings → Secrets and variables → Actions):
   - `ANTHROPIC_API_KEY` — or install the Claude GitHub App (`/install-github-app`
     from Claude Code) and use its OAuth token instead.
   - `OPENAI_API_KEY` — for the Codex reviewer.
   - `GCHAT_WEBHOOK_URL` — optional, Google Chat space webhook for notifications.
   - (Optional, for auto-migrations) `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`;
     uncomment the migration step in `claude-pr-gate.yml`.
   - For visual verification behind Google login: `SUPABASE_URL`,
     `SUPABASE_SERVICE_ROLE_KEY`, `TEST_USER_EMAIL` (a seeded test account),
     and `VERCEL_AUTOMATION_BYPASS_SECRET` if deployment protection is on.
     CI never touches Google's OAuth UI — it mints the Supabase session
     directly for the test user (see gauntlet-verify SKILL.md).
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
- To watch/steer interactively: Claude mobile app → Code tab (cloud sessions).
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

## Safety rails baked in

- Concurrency group = one issue in flight at a time.
- allowedTools whitelists (no dangerous permission bypasses).
- Codex verdict + visual gauntlet are required checks; failed/inconclusive
  verification exits nonzero and blocks merge.
- DB changes only via committed Supabase migrations.
- Planner stops with HUMAN DECISION REQUIRED for irreversible/product calls.
