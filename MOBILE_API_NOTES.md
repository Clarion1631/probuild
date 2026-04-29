# Mobile API endpoints — W4

Backfill endpoints for the gtr-probuild-mobile cutover. All routes accept either:

- **Mobile JWT** — `Authorization: Bearer <token>` (issued by `/api/mobile/login` or `/api/mobile/google-login`, signed with `NEXTAUTH_SECRET`).
- **Web session** — NextAuth cookie (so the same routes back the web UI).

`assertProjectAccess` checks: ADMIN/MANAGER pass through; everyone else needs a `ProjectAccess` row, a `Project.crew` assignment, or `permissions.canAccessProject`. Manager-only routes use `userHasRole(user, ["ADMIN", "MANAGER"])`. Employee role/rate edits require ADMIN.

> Set `TOKEN=<jwt>` and `BASE=https://probuild.goldentouchremodeling.com` (or `http://localhost:3000`) before pasting these.

---

## 1. `PATCH /api/time-entries/[id]` — edit past entry with reason
**Auth:** owner OR ADMIN/MANAGER. **Body:** `{ startTime?, endTime?, editNotes }`. Snapshots originals on first edit, recomputes labor/burden from the **owner's** rates, sets `editedByManagerId`/`editedAt` when a manager edits someone else's entry.

```bash
curl -s -X PATCH "$BASE/api/time-entries/te_abc123" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"startTime":"2026-04-28T08:00:00Z","endTime":"2026-04-28T16:30:00Z","editNotes":"Forgot to clock out"}'
```
```json
{
  "id": "te_abc123",
  "startTime": "2026-04-28T08:00:00.000Z",
  "endTime": "2026-04-28T16:30:00.000Z",
  "durationHours": 8.5,
  "laborCost": "297.50",
  "burdenCost": "85.00",
  "isEdited": true,
  "originalStartTime": "2026-04-28T08:00:00.000Z",
  "originalEndTime": "2026-04-28T17:00:00.000Z",
  "editNotes": "Forgot to clock out",
  "editedByManagerId": null,
  "editedAt": null
}
```

## 2. `DELETE /api/time-entries/[id]` — manager-only
**Auth:** ADMIN/MANAGER. Cascade handled by Prisma `onDelete`.

```bash
curl -s -X DELETE "$BASE/api/time-entries/te_abc123" \
  -H "Authorization: Bearer $TOKEN"
```
```json
{ "ok": true }
```

## 3. `GET /api/manager/dashboard`
**Auth:** ADMIN/MANAGER. Returns active workers, week-to-date labor + burden (cents), geofence violations this ISO week (Mon–Sun), and the 25 most recent edited entries.

```bash
curl -s "$BASE/api/manager/dashboard" \
  -H "Authorization: Bearer $TOKEN"
```
```json
{
  "activeWorkers": [
    {
      "id": "te_111",
      "userId": "u_222",
      "projectId": "p_333",
      "startTime": "2026-04-29T13:05:00.000Z",
      "user": { "id": "u_222", "name": "Sam Rivera", "email": "sam@example.com", "role": "FIELD_CREW" },
      "project": { "id": "p_333", "name": "Smith Kitchen", "location": "123 Main St" }
    }
  ],
  "weeklyLaborCents": 482350,
  "weeklyBurdenCents": 137800,
  "geofenceViolationsThisWeek": 2,
  "recentEdits": []
}
```

## 4. `GET /api/manager/jobs` + `POST /api/manager/jobs` + `PATCH /api/manager/jobs/[id]`
**Auth:** ADMIN/MANAGER. Wraps `Project`. `address` maps to `Project.location`.

```bash
# list
curl -s "$BASE/api/manager/jobs?status=In%20Progress" \
  -H "Authorization: Bearer $TOKEN"

# create
curl -s -X POST "$BASE/api/manager/jobs" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smith Kitchen","clientId":"cl_xyz","address":"123 Main St","locationLat":47.6062,"locationLng":-122.3321,"geofenceRadiusMeters":150}'

# update
curl -s -X PATCH "$BASE/api/manager/jobs/p_333" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status":"Closed","geofenceRadiusMeters":200}'
```
```json
{
  "id": "p_333",
  "name": "Smith Kitchen",
  "clientId": "cl_xyz",
  "location": "123 Main St",
  "locationLat": 47.6062,
  "locationLng": -122.3321,
  "geofenceRadiusMeters": 150,
  "status": "In Progress",
  "client": { "id": "cl_xyz", "name": "Jane Smith", "companyName": null }
}
```

## 5. `GET /api/manager/employees` + `PATCH /api/manager/employees/[id]`
**Auth:** GET — ADMIN/MANAGER. PATCH — ADMIN only (role + rate + status). `hourlyRate`/`burdenRate` accept numeric strings (parsed via `new Prisma.Decimal(...)`).

```bash
curl -s "$BASE/api/manager/employees" \
  -H "Authorization: Bearer $TOKEN"

curl -s -X PATCH "$BASE/api/manager/employees/u_222" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role":"FIELD_CREW","hourlyRate":"35.00","burdenRate":"10.00"}'
```
```json
{
  "id": "u_222",
  "email": "sam@example.com",
  "name": "Sam Rivera",
  "role": "FIELD_CREW",
  "status": "ACTIVATED",
  "hourlyRate": "35",
  "burdenRate": "10"
}
```

## 6. `GET /api/projects/[id]/tasks`
**Auth:** project access (manager or assigned). Includes `assignments`, `punchItems`, `dependencies`.

```bash
curl -s "$BASE/api/projects/p_333/tasks" \
  -H "Authorization: Bearer $TOKEN"
```
```json
[
  {
    "id": "t_aa",
    "name": "Demo cabinets",
    "status": "In Progress",
    "progress": 40,
    "startDate": "2026-04-25T00:00:00.000Z",
    "endDate": "2026-04-29T00:00:00.000Z",
    "assignments": [],
    "punchItems": [
      { "id": "pi_1", "name": "Photo of removed sink", "completed": false, "photoUrl": null }
    ],
    "dependencies": []
  }
]
```

## 7. `PATCH /api/tasks/[id]/progress`
**Auth:** project access. `progress` 0–100. Auto-flips `status = "Complete"` at 100.

```bash
curl -s -X PATCH "$BASE/api/tasks/t_aa/progress" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"progress":100}'
```
```json
{ "id": "t_aa", "progress": 100, "status": "Complete" }
```

## 8. `POST /api/tasks/[id]/punch-items/[itemId]/complete`
**Auth:** project access. Sets `completed = true` and stores `photoUrl` if provided.

```bash
curl -s -X POST "$BASE/api/tasks/t_aa/punch-items/pi_1/complete" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"photoUrl":"https://storage/.../photo.jpg"}'
```
```json
{ "id": "pi_1", "completed": true, "photoUrl": "https://storage/.../photo.jpg" }
```

---

## Auth helper notes (`src/lib/mobile-auth.ts`)

- `authenticateMobileOrSession(req)` — verifies `Bearer` JWT (`jose.jwtVerify` with HS256 + `NEXTAUTH_SECRET`); falls back to NextAuth `getServerSession`. Returns `{ user }` or `{ error: NextResponse }`. Disabled users (`status === "DISABLED"`) are rejected.
- `authenticateMobileOnly(req)` — JWT only.
- `userHasRole(user, roles)` — exact role match.
- `assertProjectAccess(user, projectId)` — ADMIN/MANAGER pass; otherwise checks `ProjectAccess` row, then `Project.crew` membership; returns `null` (ok) or a `NextResponse` error.

The legacy `Bearer <user-id>` pattern in `src/app/api/time-entries/route.ts` (GET/POST/PUT) is **not** changed by this PR — that's a W1 task. The new routes here use the proper signed-JWT pattern.
