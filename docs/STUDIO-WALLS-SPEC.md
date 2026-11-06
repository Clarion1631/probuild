# Room Studio: walls Richard can draw, and rooms the AI can build

## Why
Richard (GTR ops, not technical) could not draw the Kalca master bath in Room Studio. Root causes:
- Plan view only reshapes the room OUTLINE ("double-click a wall dot adds a corner"). Inside walls exist only as catalog items (Objects > Fixtures > Interior Wall / Interior Wall + Doorway / Pony Wall) that you drag in and rotate by hand. Nothing on screen points to them, and angled walls are near impossible by hand.
- Item sizes only change with +/- buttons in fixed steps (2"), clamped to catalog min (Interior Wall min 24"), so exact sizes and short returns are impossible.
- Doors and windows snap only to the outline walls, so a closet or water-closet door cannot sit in an inside wall.
- There is no way for the AI (Claude, Alice) to build a room except hand-writing layoutJson against the session API (done once for room `cmw47qsod0001molcsx1w2cz0`, lead "Kalca Master Bath").

Goal: Richard can build any typical remodel floor plan himself from his tape measurements, and the AI can build the same thing from a sketch through one MCP call.

## Facts about the current code (verified on origin/main 9bea0a4b)
- Doc model `src/lib/studio/doc.ts`: meters; `room.points` polygon; `items[]` with `x,z` center, `rotation` (radians; local +Z is the item front; three.js Y rotation, so local +X maps to `(cos r, -sin r)` in x,z), optional `w,d,h,y,label,finishes`.
- A straight wall item from point a to b: center = midpoint, `w` = length, `rotation = atan2(-(b.z-a.z), b.x-a.x)`. Proven: the hand-built Kalca room (17 items incl. 43" angled closet wall) renders correctly with this.
- `resolveItem` (`canvas/Items.tsx`) does NOT clamp sizes; only the Inspector +/- clamps to `def.resizable`.
- Store `src/components/studio/store.ts`: every `commitDoc` = one undo step; `placing` armed-item pattern; dev-only `window.__studioStore`.
- Click-to-place pattern to copy: `canvas/Placement.tsx` (capture plane, pose state, Esc/right-click cancel).
- Wall-mount snapping: `nearestWall(pt, wallSegments(doc.room.points))` in `Items.tsx` (drag) and `Placement.tsx` (place); `wallFacingRotation(wall)` faces the inward normal.
- HintBar text lives in `src/components/studio/Studio.tsx`.
- Rooms API: `POST /api/rooms` (create from template/empty), `PUT /api/rooms/[id]` (layoutJson + assets via `toApiPayload`). ProBuild MCP server: `src/app/api/mcp/[transport]/route.ts` (write tools go through the WRITE_TOOLS audit list; follow `create_lead` / `create_change_order` patterns for auth, access checks and logging).
- Tests: node test runner via `tsx --test tests/<name>.test.ts` (see `package.json`), e.g. `tests/studio-library-import.test.ts`.

## Delivery: two PRs (merging to main ships to prod)
- **PR 1 (Richard, ship first):** Goal 1 without `openingsOnWall`, Goal 2, Goal 3 (incl. the 4" minimum), hint text, Goal 6.
- **PR 2:** Goal 4 (doors/windows on inside walls + openings) and Goal 5 (MCP build tools), plus `openingsOnWall`.

## Testing rules
- `npm run dev` in this repo talks to the PROD database (`.env.local`). Any manual test room goes on the sanctioned prod test project "Shop" (`cmpd6xca1009x1iizdf4suln3`) and is deleted afterwards. Never open or edit the real Kalca room `cmw47qsod0001molcsx1w2cz0` except read-only after PR 2 deploys.
- Run `prisma generate` from PowerShell, never Git Bash.
- CI runs `npm run test:unit`: add every new test file to that script in `package.json`.

## Numbered goals
1. **Shared wall math** `src/lib/studio/walls.ts` (pure, no React):
   - `parseLength(text)` -> meters | null. Accepts `54`, `54"`, `54 in`, `4'6"`, `4' 6`, `4'6`, `4.5'`, `4 ft 6 in`, `10'`. Bare numbers are inches. Rejects empty, negative, zero, junk.
   - `wallItemPose(a, b)` -> `{ x, z, rotation, w }` per the formula above; `wallEndpoints(item)` -> `{ a, b }` inverse (round-trip tested, including angled walls).
   - `snapDrawPoint(raw, from, ctx)` -> point. Order: snap to a nearby endpoint/corner (within 4") from `ctx.anchors` (room corners + interior wall endpoints), else when `from` is set and angle snap is on, snap direction to the nearest 45 deg; then round length to the nearest 1/2"; else round to 1" grid.
   - (PR 2) `openingsOnWall(wallItem, items)` -> list of `{ center, width, bottom, top }` along the wall axis for every door/window/opening item whose center is within (half the wall thickness + 1") of the wall SEGMENT (projection clamped to the wall's own length, never the infinite line, so short stubs that line up with a door get no phantom opening) and whose rotation is parallel (either face). Openings are clipped to the wall's length.
2. **Draw walls tool (Plan view)**:
   - A "Draw walls" toggle button (pencil/ruler icon) shown in Plan view. Store gets UI state `drawingWalls: boolean` (no undo). Turning it on clears `placing` and selection; leaving Plan view turns it off.
   - New `canvas/DrawWalls.tsx` modeled on `Placement.tsx`: first click sets the start, the preview segment follows the cursor with a live length label (ft-in) and endpoint dots; second click commits one `interior-wall` item (one undo step) and chains: the end becomes the next start. Shift = free angle. Esc or right-click ends the chain; Esc with no chain exits draw mode. Room-outline corner handles (`RoomEdit`) and item dragging are inert while drawing; camera panning must not fire on the drawing click.
   - Exact length: while a chain is active, typing a digit opens a small "Length" box (DOM overlay); Enter commits a wall of that length in the current preview direction (uses `parseLength`).
   - A "Pony wall" option in the same toolbar (radio: Full height / Pony 42") so the same tool draws half walls (`pony-wall`, h 42").
   - HintBar: in draw mode: `Click to start a wall - click again to end it (snaps to 45/90, Shift = any angle) - type a length + Enter for an exact size - Esc to stop`. Normal Plan view hint also mentions `Draw walls` and `Fixtures > Interior Wall`.
3. **Exact sizes in the Inspector**: for any resizable item, Width (and Depth/Height when that axis is resizable) become typed inputs accepting `parseLength`, committing on Enter/blur, clamped to `def.resizable`. For `interior-wall`, `interior-wall-doorway`, `pony-wall` the label is "Length" and resizing keeps the START end fixed (use `wallEndpoints`). Lower `resizable.min` for `interior-wall` and `pony-wall` to 4" so short returns work.
4. **Doors and windows on inside walls**:
   - Wall-mount snapping (drag in `Items.tsx`, place in `Placement.tsx`) considers interior-wall segments (both faces) as well as the outline. A Door dropped near an inside wall lands on it, aligned, centered in the wall thickness.
   - The interior-wall (and pony-wall) builders render real openings for items from `openingsOnWall` (wall split into pieces around each opening, header above doors). The opening updates when the door is dropped or deleted (commit time, not per drag frame: perf contract). No auto-splitting of wall items.
5. **AI build tools (ProBuild MCP)** with a pure converter `src/lib/studio/room-spec.ts`:
   - Spec (inches, sketch frame: x right, y down; converter centers it): `{ outline: [[x,y]...], heightIn?, walls?: [{ from:[x,y], to:[x,y], kind?: "full"|"pony", heightIn? }], items?: [{ type: <catalog id>, at:[x,y], facing?: "N"|"S"|"E"|"W"|<degrees>, widthIn?, depthIn?, heightIn?, elevationIn?, label?, finishes? }], floor?, wallPaint? }`. Wall-mount items snap to the nearest wall (outline or spec wall) like the UI does. Unknown types / items outside the room -> warnings, not silent drops.
   - MCP tools: `build_room_design` (leadId XOR projectId, name, roomType, spec; creates a RoomDesign like `POST /api/rooms` with layoutJson + assets mirror; returns roomId, studio URL, counts, warnings), `get_room_design` (roomId -> spec in inches, so the AI can read and revise), `update_room_design` (roomId + spec -> replaces layout). Auth: the MCP actor pattern already in the route (`getUserWithPermissionsByEmail` / `canAccessJobScope`), not the session-based rooms API. Add the two writes to `WRITE_TOOLS` and the tool-to-entity map; `get_room_design` allowed in read-only mode, the writes blocked; keep whatever test enforces the registerTool enumeration passing. `update_room_design` takes `expectedUpdatedAt` and refuses if the room changed since (an open Studio tab's autosave would otherwise clobber it); say so in the tool description. Nothing is sent to anyone.
   - Unit test: the Kalca spec (below) converts to a doc whose outline, wall items and fixtures match the hand-built room within 0.5". The closet door is modeled as ONE angled wall plus a `door-single` item, so also assert `openingsOnWall` returns a 28" opening centered on that wall.
6. **Docs**: short "How to draw a floor plan" section in the Studio help if one exists, else in this file; update the Plan hint.

## Kalca reference spec (inches, x right, y down)
outline 205 x 169. Walls: WC east (79,0)-(79,54); WC south (0,54)-(51,54); closet west (125,0)-(125,45.8); closet angled (125,45.8)-(151,80) as one wall plus a 28" `door-single` at its midpoint (138,62.9) (the hand-built room used two 7.5" stubs instead); closet south (151,80)-(205,80). Pony walls h21: (35,101)-(89,128.5) and (89,128.5)-(89,169). Items: toilet at (14,27) facing E; shower-glass 47x35 at (17.5,77.5) facing E; tub-alcove at (52.2,133.9); vanity-double 85x22 at (134,158) facing N; door-single 28 at (65,54); door-single 32 on east wall at (205,117); windows 30x36 elev 42 at (0,140) and (50,169).

## Out of scope
Changing the room outline editor, multi-room plans, auto-splitting walls, new catalog meshes beyond openings in wall builders.

## Acceptance
- `tests/studio-walls.test.ts` and `tests/studio-room-spec.test.ts` pass; `npm run typecheck` and existing studio tests pass; `npm run build` passes.
- Local dev (never touch prod rooms): draw an L plus a 45 deg wall with typed lengths, add a door to an inside wall and see the opening, type an exact length in the Inspector, undo/redo, reload and see it persisted. Screenshots attached to the PR.
- MCP `build_room_design` with the Kalca spec against local dev creates the room; `get_room_design` returns it.
- Codex review (codex-reviewer agent) + Opus review; blockers fixed. PR merged only on green CI.

## How to draw a floor plan (Room Studio help)
1. Switch to **Plan** view and set the room outline (drag blue dots, or Room size in the top bar).
2. Click **Draw walls** in the top bar (choose Full height or Pony 42" next to it).
3. Click where a wall starts, then click where it ends. Each click after that continues from the last end. Walls snap to corners and other wall ends, to 45 and 90 degrees, and to the nearest half inch. Hold **Shift** for any angle.
4. For an exact length, after the first click just type it (`54`, `4'6"`, `10'`) and press **Enter**.
5. **Esc**, right-click or a double-click ends the chain; **Esc** again leaves Draw walls. Ctrl+Z undoes one wall at a time.
6. To resize a wall later, select it and type a new **Length** in the right panel. The start end stays put.
