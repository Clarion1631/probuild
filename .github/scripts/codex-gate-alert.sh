#!/usr/bin/env bash
# Decides whether a failed Codex Review Gate run needs a chat alert, and if
# so, prints the alert message on stdout. Checks for a verdict FIRST: if the
# review already has one (APPROVE or REQUEST_CHANGES), Codex answered and the
# gate is working normally, so this prints nothing (still exit 0) — even if
# stderr also logged an auth error along the way (Codex can refresh an
# expired access token mid-run and still finish the review normally). Only
# when there's no verdict does this fall back to stderr, to tell a sign-in
# failure (case A) apart from any other verdict-less run (case B).
#
# Usage: codex-gate-alert.sh <stderr-log-file> <review-file> <run-url>
# Either file may be missing; that is treated as empty input.
set -euo pipefail

STDERR_LOG="${1:?usage: codex-gate-alert.sh <stderr-log-file> <review-file> <run-url>}"
REVIEW_FILE="${2:?usage: codex-gate-alert.sh <stderr-log-file> <review-file> <run-url>}"
RUN_URL="${3:?usage: codex-gate-alert.sh <stderr-log-file> <review-file> <run-url>}"

stderr_content=""
[ -f "$STDERR_LOG" ] && stderr_content=$(cat "$STDERR_LOG")

review_content=""
[ -f "$REVIEW_FILE" ] && review_content=$(cat "$REVIEW_FILE")

# A verdict means Codex answered and the gate is working normally (APPROVE or
# REQUEST_CHANGES) — check this before anything else, so a stderr auth error
# logged on the way to a real verdict (e.g. a mid-run token refresh) never
# raises a false sign-in alert. Mirrors the exact pattern the gate itself
# uses to extract the verdict.
# grep -q exits as soon as it finds a match, without draining the rest of
# its input; piping a large `printf` into it can then kill the printf with
# SIGPIPE and, under `pipefail`, flip this condition's exit status. A
# here-string has no concurrent writer to kill, so it doesn't have that
# failure mode.
if grep -qE 'VERDICT: (APPROVE|REQUEST_CHANGES)' <<< "$review_content"; then
  exit 0
fi

# Case A: Codex could not sign in (expired/reused login token). Only reached
# once we know the review has no verdict.
# Same here-string reasoning as above.
if grep -qE 'refresh_token_reused|token_expired|401 Unauthorized' <<< "$stderr_content"; then
  template=$(cat <<'MSGEOF'
ProBuild PR check: Codex can't sign in (its GitHub login expired). PRs are not getting a Codex review until this is fixed. On Justin's PC, in PowerShell, run these 2 commands:
1)
```
New-Item -ItemType Directory -Force "$HOME\.codex-ci" | Out-Null; $env:CODEX_HOME = "$HOME\.codex-ci"; codex login; Remove-Item Env:CODEX_HOME
```
2)
```
Get-Content "$HOME\.codex-ci\auth.json" -Raw | gh secret set CODEX_AUTH_JSON --repo Clarion1631/probuild
```
Then re-run the failed check. Run: __RUN_URL__
MSGEOF
  )
  printf '%s' "${template/__RUN_URL__/$RUN_URL}"
  exit 0
fi

# Case B: no verdict line at all (sandbox error, crash, missing review file).
printf '%s' "ProBuild PR check: Codex couldn't finish a review (no verdict). PRs are not getting a Codex review until this is fixed. Check the failed run: ${RUN_URL}"
exit 0
