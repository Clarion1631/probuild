# Spec: Unified Property 3D — combined rooms + outdoor in one scene, whole-house scan, AR export

**ID:** 20260717040628
**Date:** 2026-07-17
**Status:** draft

## Context

Room Studio (src/components/studio + src/lib/studio) models exactly one room per `RoomDesign` row: a v2 `DesignDoc` (polygon + placed items in room-local coordinates) rendered in its own react-three-fiber canvas. Outdoor spaces shipped July 2026 (`room.outdoor`, `room.noWalls`, outdoor catalog/templates), and LiDAR intake exists for single rooms (`POST /api/rooms/scan-import`, mobile capture in gtr-probuild-mobile `apps/mobile/app/room-scan.tsx`).

Golden Touch wants the whole property as ONE 3D model: scan a full house room-by-room, step outside into designed yards/patios/porches, and walk it all continuously — with client presentations (estimator/PM roles), share links (client role), and eventually AR overlay on the mobile apps (field + client roles). Today rooms are islands; there is no way to combine them.

Key architectural fact that makes this cheap: every `DesignDoc` is self-contained in local coordinates, and all meshes are procedural with globally cached materials. Composing N docs into one scene only requires a per-room transform — no doc-format change.

## Goals

1. **Placement data model.** `RoomDesign` gains nullable placement fields (`placementX`, `placementZ`, `placementRotation`, `placementLevel`). A room with non-null `placementX/Z` is "placed on the property". Persisted via existing room PUT; no new table.
2. **Property view.** New page per project/lead (proposed: `/projects/[id]/room-designer/property`, same for leads) rendering ALL placed rooms of that owner in a single R3F scene — each room's shell + items inside a group positioned/rotated by its placement. Orbit and walk modes work across the whole property; indoor rooms keep dollhouse wall-hide; outdoor rooms keep open-sky/no-ceiling and open-boundary behavior. Lights-on point-light count is capped scene-wide (budget: 12) to protect frame rate.
3. **Arrange mode.** A top-down orthographic mode in the property view: drag to move a room, rotate in 90° steps (free rotate with Shift), with edge-snap guides against other rooms (reuse the plan-view axis-snap pattern). Drags mutate three.js objects only; placement commits to the store/API on pointerup (existing perf contract). An "Unplaced rooms" tray lists the owner's other rooms; clicking one drops it at the property origin for arranging.
4. **Whole-structure scan intake.** `POST /api/rooms/scan-import` accepts a RoomPlan `CapturedStructure` payload (iOS 17+ multi-room capture: `sections[]` of CapturedRooms, each with a floor transform). Creates one `RoomDesign` per captured room via the existing single-room mapping, and derives each room's placement (x, z, Y-rotation, level from floor elevation) from its transform so the scanned house arrives pre-assembled in the property view.
5. **USDZ export.** "Export AR model" action on the property view composes the scene and produces a `.usdz` via three.js `USDZExporter` in the browser, uploads it to Supabase storage under the project, and records the URL. Also downloadable directly.
6. **Mobile AR Quick Look.** gtr-probuild-mobile gains a "View in AR" action (Designs tab / property entry) that fetches the exported USDZ and opens iOS AR Quick Look. (Android: out of scope v1, see Non-Goals.)
7. **Property share link.** `/share/property/[token]` public read-only property view (mirrors `/share/room/[token]`: public in BOTH AppLayout and src/proxy.ts matcher), token stored on Project.

## Non-Goals (v1 scope line — see Roadmap below; these ARE planned, just not in this build)

- Live ARKit anchoring/overlay ("stand in the room, see the design in place") — AR Quick Look tabletop/room-scale placement only in v1.
- Shared-wall deduplication or geometry merging between adjacent rooms (two abutting walls simply coexist; thickness overlap is visually acceptable v1).
- Cross-room item editing in the property view (v1: rooms remain editable in their own editor; property view is compose + arrange + walk).
- Multi-floor UI beyond an integer `placementLevel` rendered at `level * 3.0m` elevation.
- Android AR (Scene Viewer requires GLB, not USDZ).
- Estimate/selection rollups across the property (money-path work; needs its own spec and review rigor).

## Roadmap — later phases (intended, sequenced)

- **Phase 2 — property editing depth:** cross-room item editing directly in the property view; floor-switcher UI for multi-level homes (per-room `room.height` drives level elevation instead of the fixed 3.0m); shared-wall merge/cleanup pass for presentation-quality exterior shots.
- **Phase 3 — AR everywhere:** GLB twin-export so Android gets Scene Viewer AR alongside iOS Quick Look; live ARKit anchoring in the mobile app (persistent anchors from the original RoomPlan scan so the design overlays the real room in place). Quick Look (Goal 6) is the proving step for the model pipeline both of these reuse.
- **Phase 4 — property-level business layer:** estimate/selection rollups across all rooms of a property (separate spec; touches money paths, so codex review + money-pipeline e2e gates apply).

## Approach

**Data.** Placement lives on `RoomDesign` (4 nullable columns) rather than a join table — a room has at most one placement and already belongs to exactly one project/lead. Applied via the `apply_schema.ps1` workflow (never `prisma db push`), then `prisma generate` via PowerShell.

**Rendering.** New `PropertyScene` component: for each placed room, `<group position rotation><Room doc/><Items doc/></group>`. `Room`/`Items` already take a doc prop; audit them for module-level singletons that assume one room (e.g. the studio zustand store's `activeSurface` — property view mounts them in a read-only mode with surface-click and item-drag disabled outside arrange mode). Skies/ground: single large ground plane under everything when any outdoor room is placed. Store: a lean separate zustand store for the property view (placements, mode, selection) — do NOT overload the per-room studio store.

**Arrange mode.** Orthographic top-down camera; each room draws a floor-plate hit target. Pointer drag mutates the room group's position; snap candidates are other rooms' wall segments transformed to world space; green guide lines as in RoomEdit. On pointerup, write placement via `PUT /api/rooms/[id]` (extend its body schema with the 4 placement fields).

**Scan.** RoomPlan's `CapturedStructure` JSON export contains per-room floor transforms in a common structure frame. Mapping: reuse the existing CapturedRoom→DesignDoc mapping per section; decompose each 4x4 floor transform into translation (x, z), rotation about Y, and elevation→`placementLevel` (round(elevation / 3.0m)). The mobile scan screen gains a "whole floor / multi-room" toggle that uses `structureBuilder` (iOS 17+) and posts the combined JSON. Fixture-driven unit tests for the mapping (commit a small CapturedStructure fixture).

**USDZ.** Client-side `USDZExporter` from three/examples against a clone of the composed scene (strip lights/helpers; bake canvas floor textures to data textures — verify exporter handles CanvasTexture, else re-render floors with flat colors for export). Upload to Supabase storage `properties/{projectId}/model.usdz`. NOTE: coordinate before building — an untracked `src/lib/studio/usdz-generator.ts` and `api/rooms/[id]/ai-furnish/` exist in the canonical checkout (someone has in-flight USDZ work; see Open Questions).

**Mobile.** Expo: download USDZ to cache, open with iOS Quick Look (`expo-quick-look` or native module already used for USDZ/AR Quick Look in the lead-intake work — reuse that path).

## Files Touched

- `prisma/schema.prisma` — RoomDesign placement columns; Project `propertyShareToken`
- `src/lib/studio/property.ts` (new) — placement types, transforms, snap math
- `src/components/studio/PropertyStudio.tsx`, `src/components/studio/canvas/PropertyScene.tsx`, `ArrangeControls.tsx` (new)
- `src/app/(app)/projects/[id]/room-designer/property/page.tsx` (+ leads twin) (new)
- `src/app/share/property/[token]/page.tsx` (new) + `src/proxy.ts` matcher + AppLayout public list
- `src/app/api/rooms/[id]/route.ts` — accept placement fields on PUT
- `src/app/api/rooms/scan-import/route.ts` — CapturedStructure branch
- `src/app/api/projects/[id]/property-export/route.ts` (new) — record/serve USDZ URL
- `src/components/studio/RoomList.tsx` — "Property view" entry point + unplaced badge
- gtr-probuild-mobile: `apps/mobile/app/room-scan.tsx` (structure mode), new AR viewer action

## Data Model Changes

```
RoomDesign: + placementX Float?, placementZ Float?, placementRotation Float?, placementLevel Int?
Project:    + propertyShareToken String? @unique, propertyShareEnabled Boolean @default(false), propertyUsdzPath String?
```
Additive/nullable only. Apply via `apply_schema.ps1`; keep schema.prisma in sync.

## Test Plan

- Goal 1/3: e2e (throwaway-DB CI): create two rooms, place both via API, GET returns placements; arrange-mode drag commits new placement (Playwright).
- Goal 2: dev QA hooks — compose the sandbox project's demo rooms + one outdoor room, `window.__studio` advance + `/api/dev/snap` screenshot; verify walk mode crosses rooms; verify point-light cap with all lights on.
- Goal 4: unit test mapping a committed CapturedStructure fixture → N docs + placements (positions/rotations within tolerance).
- Goal 5: export sandbox property, assert non-empty USDZ in storage; open in macOS/iOS Quick Look manually.
- Goal 6: TestFlight build, View in AR opens Quick Look with the model.
- Goal 7: share token route renders logged-out (e2e), absent from proxy auth matcher regressions.
- `npm run build` zero errors; `e2e/money-pipeline.spec.ts` untouched but must stay green in CI.

## Rollback Plan

- All schema changes are additive nullable columns — safe to leave in place on revert.
- Property view/share are new routes; revert = remove routes + RoomList entry (no existing behavior altered).
- scan-import structure branch is additive (single-room payloads unchanged); revert the branch only.
- USDZ files in storage are inert artifacts; delete folder if needed.

## Open Questions

1. **In-flight USDZ/AI-furnish work**: untracked `src/lib/studio/usdz-generator.ts`, `src/app/api/rooms/[id]/ai-furnish/`, and `AiFurnishDialog.tsx` exist in the canonical checkout (not committed). Whose work is this and should Goal 5 build on it instead of three.js `USDZExporter`?
2. Route naming: `room-designer/property` vs a top-level `/projects/[id]/property` tab — which fits the nav model Justin wants?
3. Arrange permissions: ADMIN/MANAGER only, or anyone with project access?
4. Multi-floor v1: is `level * 3.0m` an acceptable approximation, or should level height come from each room's own `room.height`?
5. RoomPlan `CapturedStructure` JSON schema: confirm the exact export format produced by the mobile app's RoomPlan version before freezing the fixture (iOS 17 vs 18 differences).
6. Do lead-owned rooms need the property view at v1, or projects only?
