---
name: probuild-dev-server
description: Start the ProBuild Next.js dev server cleanly, or recover one that won't boot. Use when the dev server is stuck, the port is held by a dead process, or a fresh local run is needed.
allowed-tools: Read, Bash, Glob
---

# ProBuild dev server — clean start

Prefer the Browser pane's `preview_start` (config in `.claude/launch.json`) over running the server by hand. Use the recipe below only when you need a raw clean start or the preview won't come up.

```bash
kill -9 $(lsof -ti tcp:3000,3001,3002) 2>/dev/null; rm -f .next/dev/lock; sleep 2
npm run dev > /tmp/devserver.log 2>&1 &
sleep 15 && curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/
```

## Rules

- **Always use port 3000.** If it's taken, kill the holder — don't switch ports.
- If it still won't start: `rm -rf .next && npm run dev`.
