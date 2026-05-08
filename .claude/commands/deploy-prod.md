---
description: Codex-reviewed production deploy — verify build, peer-review the diff, and ship via Vercel CLI only if clean.
---

You are about to run the **only blessed path to production** for this project. Auto-deploy is intentionally OFF (Vercel billed $250 from push-triggered builds). This command gates every deploy on a Codex peer review so we catch bugs before they hit prod.

If the user passes `--skip-review` as an argument, skip step 4 only and explain you're doing so. Use that for genuine emergencies (security hotfix, prod fully down).

## Step 1 — Pre-flight checks

Run from the **main repo** (`C:\Users\jat00\.gemini\antigravity\workspaces\gtr-probuild-site`), NOT a worktree.

- `git -C "C:\Users\jat00\.gemini\antigravity\workspaces\gtr-probuild-site" status --porcelain` — must be empty. If dirty (especially `UU` for unresolved merge), abort and tell the user what's blocking them.
- `git -C "<main-repo>" rev-list --count origin/main..HEAD` — if 0, abort: nothing new to deploy.
- Stash untracked junk if needed but never commit on the user's behalf.

## Step 2 — Build verification

```powershell
Set-Location "C:\Users\jat00\.gemini\antigravity\workspaces\gtr-probuild-site"
npm run build
```

On non-zero exit, abort and surface the error verbatim. Do not deploy a build that fails locally — Vercel will fail too and you'll have wasted build minutes.

## Step 3 — Capture the diff to review

The "fix" being reviewed is everything between `origin/main` and `HEAD` (the commits that this deploy will ship to prod).

```powershell
git -C "<main-repo>" log origin/main..HEAD --oneline
git -C "<main-repo>" diff origin/main..HEAD --stat
```

If the diff is empty, abort.

## Step 4 — Codex peer review (gate)

Spawn the `codex-peer-review:codex-peer-reviewer` subagent. In the prompt, include:
- The full diff (`git diff origin/main..HEAD`)
- A note that this is a **production deploy gate** — focus on blockers, not nits
- Reviewer should grade each concern as BLOCKER / MAJOR / MINOR / NIT
- Reviewer must explicitly say "PASS" or "FAIL" at the end

Also flag the high-risk areas from the global review protocol (money math, date math, auth, SQL joins, external API integrations).

After the review returns, parse the output:
- If it contains "FAIL" or any BLOCKER findings → **abort the deploy**. List the blockers to the user, do NOT continue.
- If MAJOR findings exist → show them and **ask the user** whether to proceed (ExitPlanMode-style) before deploying.
- If only MINOR/NIT → mention them in the summary but proceed.
- If clean → proceed.

If the user passed `--skip-review`, skip this step and add a `[REVIEW SKIPPED]` note to the final summary.

## Step 5 — Deploy via Vercel CLI

```powershell
vercel --prod --token $env:VERCEL_TOKEN --yes --archive=tgz --cwd "C:\Users\jat00\.gemini\antigravity\workspaces\gtr-probuild-site"
```

- Run in background (Bash with `run_in_background: true`) — the build takes 3-8 minutes
- When the background task completes, read the output. Look for `"readyState": "READY"` (success) or `"readyState": "ERROR"` (failure)
- On error, surface the Vercel build log lines so the user can debug

## Step 6 — Verify production

After the deploy reports READY:
- WebFetch `https://probuild.goldentouchremodeling.com` — confirm it loads (login page expected)
- Check the latest deploy in `vercel ls probuild --token $env:VERCEL_TOKEN --scope justins-projects-a2347a8d`

## Step 7 — Final summary

Print:
- Commits deployed (the SHA list from step 3)
- Deploy URL (`probuild-{hash}-justins-projects-a2347a8d.vercel.app`)
- Codex review summary (PASS / number of MAJOR issues acknowledged / any skipped)
- Production verification result
- Any new gotchas worth saving to memory

If a new deploy-related gotcha emerged, save it to memory as a `feedback` type.
