---
name: probuild-diagnostics
description: Diagnose ProBuild production errors via Sentry, and test Stripe webhooks locally. Use when investigating a prod error or exception, or when verifying payment webhook handling against the local dev server.
allowed-tools: Read, Bash, Grep, Glob
---

# ProBuild diagnostics

## Sentry — production error triage

Org is `golden-touch-remodeling` (us.sentry.io). Auth is via `$SENTRY_AUTH_TOKEN`.

```bash
sentry-cli issues list --org golden-touch-remodeling --project <project> --query "is:unresolved"
```

`issues list` has **no** JSON output — there is no `--output`/`--format` flag on this
subcommand (verified against sentry-cli 3.3.5; passing `--output json` hard-errors with
`unexpected argument '--output' found`). It prints a table. Useful flags are `--query`,
`--status {resolved,muted,unresolved}`, `--max-rows`, `--pages`, and `-i/--id`.

If `$SENTRY_AUTH_TOKEN` is stale every command fails auth — triage from the Sentry web UI
instead rather than trying to work around it.

## Stripe — local webhook testing

Auth is already configured via `$STRIPE_API_KEY`.

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe --format JSON
```

The flag is `--format JSON` (uppercase), **not** `--output json` — `stripe listen` has no
`--output` flag. Verified against Stripe CLI 1.40.0.

```bash
stripe trigger payment_intent.succeeded
```

Dev server must be on port 3000 — see the `probuild-dev-server` skill.

> Money-path changes (payments, signing, payment mirrors, notifications) also need `e2e/money-pipeline.spec.ts` green and a codex-peer-review pass on the diff.
