#!/usr/bin/env bash
# Decides whether a failed Codex Review Gate run needs a chat alert, and if
# so, prints the alert message on stdout. Prints nothing (still exit 0) when
# the failure is Codex working normally (VERDICT: REQUEST_CHANGES) — that
# case needs no alert.
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

# Case A: Codex could not sign in (expired/reused login token).
# grep -q exits as soon as it finds a match, without draining the rest of
# its input; piping a large `printf` into it can then kill the printf with
# SIGPIPE and, under `pipefail`, flip this condition's exit status. A
# here-string has no concurrent writer to kill, so it doesn't have that
# failure mode.
if grep -qE 'refresh_token_reused|token_expired|401 Unauthorized' <<< "$stderr_content"; then
  template=$(cat <<'MSGEOF'
ProBuild PR check: Codex can't sign in (its GitHub login expired). PRs are not getting a Codex review until this is fixed. On Justin's PC, in PowerShell, run these 2 commands:
1) New-Item -ItemType Directory -Force "$HOME\.codex-ci" | Out-Null; $env:CODEX_HOME = "$HOME\.codex-ci"; codex login; Remove-Item Env:CODEX_HOME
2) Get-Content "$HOME\.codex-ci\auth.json" -Raw | gh secret set CODEX_AUTH_JSON --repo Clarion1631/probuild
Then re-run the failed check. Run: __RUN_URL__
MSGEOF
  )
  printf '%s' "${template/__RUN_URL__/$RUN_URL}"
  exit 0
fi

# Case B: no verdict line at all (sandbox error, crash, missing review file).
# Mirrors the exact pattern the gate itself uses to extract the verdict.
# Same here-string reasoning as the case A check above.
if ! grep -qE 'VERDICT: (APPROVE|REQUEST_CHANGES)' <<< "$review_content"; then
  printf '%s' "ProBuild PR check: Codex couldn't finish a review (no verdict). PRs are not getting a Codex review until this is fixed. Check the failed run: ${RUN_URL}"
  exit 0
fi

# A VERDICT line exists and there was no sign-in error: the gate is working
# normally (REQUEST_CHANGES or APPROVE). No alert.
exit 0
