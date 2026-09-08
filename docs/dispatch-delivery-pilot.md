# Dispatch delivery pilot

The dispatch consumer is staged and disabled. There is no cron, route, environment toggle, credential loader, or backlog scan. Existing queued messages have not been sent.

`deliverDispatchById` consumes one explicitly reviewed `ChatDelivery` ID. Its caller supplies `enabled: true`, that ID in `approvedDeliveryIds`, and exactly one verified recipient mapping containing the ProBuild user ID, a `DIRECT_MESSAGE` space, verification time, and stable authentication principal ID. Verify the actual DM participant and authenticated sender before constructing this server-owned configuration. Never accept it from employee input or substitute a project space. Activated ProBuild status is checked again before claiming.

The injected sender obtains a token for that pinned principal and calls `sendDispatchChatMessage`. The token must permit both creating and reading messages; create-only access is insufficient. The adapter uses Google's fixed API origin, refuses redirects, uses a stable request ID and custom message ID, and reads the stored message after every successful create or duplicate response to verify its content. It loads no credentials itself. See [Google's message creation contract](https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/create).

First claim freezes message text, DM space, principal and message identity in the queue payload. A 60-second lease and compare-and-swap completion fence competing workers. An uncertain send stays failed with the same identity; a stale claim can be retried. Remapping, changed payload, inactive users, missing instruction snapshots, and five attempts require review. `PROCESSED` means the provider confirmed the message; it never means an employee acknowledged it. No payroll or time entry is written.

Before pilot activation, review the exact delivery row, current staffing and instructions, actual DM mapping and authenticated sender, then allow only that row. Older queue rows without frozen task snapshots are refused. Do not approve the historical backlog. A subsequent scheduler needs a separately reviewed publication cutoff and authorization policy.

Local verification uses the disposable `crew_readiness_20260907` PostgreSQL database only. Set both `DATABASE_URL` and `CREW_PROVENANCE_TEST_URL` to that localhost database (with `pgbouncer=true`) and run:

```
node --import tsx --test tests/daily-log-provenance.test.ts tests/daily-log-provenance-db.test.ts tests/dispatch-chat-transport.test.ts tests/dispatch-delivery-worker-db.test.ts
node --import tsx scripts/verify-dispatch-publication.ts
```

The MCP log path in this patch accepts the exact originating `chatMessageName`, includes it in confirmation preview/hash, validates the linked project Chat space in preview and commit, and persists Google Chat provenance. Existing database uniqueness rejects concurrent and cross-project reuse. This does not install an unattended Chat ingestion scheduler or verify the message's contents independently of the authorized caller.
