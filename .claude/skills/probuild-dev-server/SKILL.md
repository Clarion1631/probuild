---
name: probuild-dev-server
description: Start the ProBuild Next.js dev server cleanly, or recover one that won't boot. Use when the dev server is stuck, the port is held by a dead process, or a fresh local run is needed.
allowed-tools: Read, Bash, Glob
---

# ProBuild dev server — clean start

Prefer the Browser pane's `preview_start` (config in `.claude/launch.json`) over running the server by hand. Use the recipe below only when you need a raw clean start or the preview won't come up.

Wrapped in a function on purpose: a failed check must not kill an interactive shell, and a
half-started server must not be left running on the wrong port.

```bash
# Listener PIDs on a port. Git Bash has no lsof, so fall back to PowerShell there —
# without this the port checks silently evaluate to "nothing is holding 3000" and
# step 1 becomes a no-op. Returns OS-native PIDs (Windows PIDs under Git Bash).
port_pids() {
  if command -v lsof >/dev/null 2>&1; then
    # -sTCP:LISTEN matters: plain `lsof -ti tcp:3000` also matches established
    # connections whose REMOTE port is 3000, so it can SIGKILL bystanders.
    lsof -nP -tiTCP:"$1" -sTCP:LISTEN
  elif command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command \
      "Get-NetTCPConnection -LocalPort $1 -State Listen -ErrorAction SilentlyContinue |
       Select-Object -ExpandProperty OwningProcess" 2>/dev/null | tr -d '\r'
  else
    echo "port_pids: need lsof or powershell.exe" >&2
    return 1
  fi
}

# Kill PIDs *and their children*. Only ever pass PIDs that came from port_pids —
# they are OS-native. Never pass a shell job id ($!); under Git Bash that is an
# MSYS pid and taskkill would resolve it to an unrelated Windows process.
kill_tree() {
  local p
  for p in "$@"; do
    [ -n "$p" ] || continue
    if command -v taskkill.exe >/dev/null 2>&1; then
      taskkill.exe //PID "$p" //T //F >/dev/null 2>&1
    else
      pkill -9 -P "$p" 2>/dev/null
      kill -9 "$p" 2>/dev/null
    fi
  done
}

# Kill whatever WE started, wherever it landed. The port is read back out of OUR
# OWN log, so this never touches an unrelated process that happens to hold 3001.
kill_our_server() {
  local bound
  bound=$(grep -oE 'http://localhost:[0-9]+' /tmp/devserver.log | head -1 | grep -oE '[0-9]+$')
  [ -n "$bound" ] && kill_tree $(port_pids "$bound")
  kill "$1" 2>/dev/null   # the npm shell job
  wait "$1" 2>/dev/null
}

probuild_dev_start() {
  local pids dev_pid probe code

  # 1. Free port 3000.
  pids=$(port_pids 3000) || return 1
  [ -n "$pids" ] && kill_tree $pids && sleep 2
  if [ -n "$(port_pids 3000)" ]; then
    echo "FAIL: port 3000 still held by pid $(port_pids 3000 | tr '\n' ' ')"
    return 1
  fi
  rm -f .next/dev/lock

  # 2. Start it.
  npm run dev > /tmp/devserver.log 2>&1 &
  dev_pid=$!

  # 3. Wait for OUR server to report it bound 3000. With 3000 taken, Next instead logs
  #    "Port 3000 is in use by process N, using available port 3001 instead." — which
  #    does not contain this string, so a fallback can never pass as success.
  for _ in $(seq 60); do
    grep -q "http://localhost:3000" /tmp/devserver.log && break
    kill -0 "$dev_pid" 2>/dev/null || break   # it exited; stop waiting
    sleep 1
  done
  if ! grep -q "http://localhost:3000" /tmp/devserver.log; then
    echo "FAIL: never bound 3000 (fell back to another port, or died)"
    tail -30 /tmp/devserver.log
    kill_our_server "$dev_pid"
    return 1
  fi

  # 4. Confirm ProBuild is what answers on 3000. Require BOTH a real 200 and ProBuild's
  #    own markup — `curl -s` alone reports success on a 404/500, and any process can
  #    return a bare 200. Binding is not the same as being ready to serve, hence the retry.
  probe=$(mktemp)
  for _ in $(seq 30); do
    code=$(curl -s --max-time 30 -o "$probe" -w '%{http_code}' http://localhost:3000/login)
    [ "$code" = "200" ] && grep -q "Golden Touch Remodeling" "$probe" && break
    sleep 2
  done
  if [ "$code" = "200" ] && grep -q "Golden Touch Remodeling" "$probe"; then
    rm -f "$probe"
    echo "OK: ProBuild dev server up on 3000 (npm job $dev_pid)"
    return 0
  fi
  echo "FAIL: :3000 returned $code and did not look like ProBuild"
  head -20 "$probe"; rm -f "$probe"
  kill_our_server "$dev_pid"
  return 1
}

probuild_dev_start
```

## Where to run this

**Git Bash.** That is the supported shell here, and the recipe runs there as written — `port_pids`
falls back to `powershell.exe` for the port lookup and `kill_tree` uses `taskkill`. No `lsof`
needed.

**Not WSL.** `node_modules` on this machine is installed for **Windows**. Run the dev server from
WSL against the Windows checkout and it boots, then 500s on every page with
`Cannot find module '../lightningcss.linux-x64-gnu.node'` — the native binaries are win32.
Confirmed 2026-08-10; the recipe's step 4 correctly reports FAIL rather than passing it. WSL2 also
has its own network namespace, so its `lsof` cannot see Windows-side listeners even for the port
check. Run it in the environment that owns `node_modules`.

## Rules

- **Always use port 3000.** If it's taken, kill the holder — don't switch ports, and don't
  kill 3001/3002; they are not ours to take.
- **Never treat a bare HTTP 200 as success.** A surviving process on 3000 will happily return
  200 while Next quietly falls back to 3001. The probe must see a 200 *and* ProBuild's own
  markup (`Golden Touch Remodeling`, the `<title>` from `src/app/layout.tsx`).
- Step 4 is a **content** check, not proof of identity — anything serving that string would
  pass it. It is there to catch the unrelated-process case, not a determined impostor.
- On failure the recipe cleans up after **itself**: `kill_our_server` reads the port Next actually
  bound out of our own log and kills that listener's whole process tree, so a fallback server on
  3001 doesn't survive — and no unrelated process on 3001 is ever touched, because the port comes
  from our log rather than a guess.
- If it still won't start: `rm -rf .next && npm run dev`.
