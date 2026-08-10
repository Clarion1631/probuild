---
name: probuild-diagnostics
description: Diagnose ProBuild production errors via Sentry, and test Stripe webhooks locally. Use when investigating a prod error or exception, or when verifying payment webhook handling against the local dev server.
allowed-tools: Read, Bash, Grep, Glob
---

# ProBuild diagnostics

## Sentry — production error triage

Org is `golden-touch-remodeling` (us.sentry.io). Auth is already configured via `$SENTRY_AUTH_TOKEN`.

```bash
sentry-cli issues list --org golden-touch-remodeling --project <project> --output json
```

## Stripe — local webhook testing

Auth is already configured via `$STRIPE_API_KEY`.

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe --output json
```

```bash
stripe trigger payment_intent.succeeded
```

Dev server must be on port 3000 — see the `probuild-dev-server` skill.

> Money-path changes (payments, signing, payment mirrors, notifications) also need `e2e/money-pipeline.spec.ts` green and a codex-peer-review pass on the diff.
