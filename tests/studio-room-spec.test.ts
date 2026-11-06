import test from "node:test";
import assert from "node:assert/strict";
import { specToDoc, docToSpec, RoomSpecSchema, ROOM_SPEC_HELP, ROOM_SPEC_EXAMPLE, type RoomSpec } from "../src/lib/studio/room-spec";
import { openingsOnWall, wallItemPose } from "../src/lib/studio/walls";
import { wallSegments } from "../src/lib/studio/geometry";
import { inches, toInches } from "../src/lib/studio/units";

// Kalca master bath reference spec (docs/STUDIO-WALLS-SPEC.md). Inches, x right, y down.
const KALCA: RoomSpec = {
  outline: [[0, 0], [205, 0], [205, 169], [0, 169]],
  walls: [
    { from: [79, 0], to: [79, 54] },
    { from: [0, 54], to: [79, 54] },
    { from: [125, 0], to: [125, 45.8] },
    { from: [125, 45.8], to: [151, 80] },
    { from: [151, 80], to: [205, 80] },
    { from: [35, 101], to: [89, 128.5], kind: "pony", heightIn: 21 },
    { from: [89, 128.5], to: [89, 169], kind: "pony", heightIn: 21 },
  ],
  items: [
    { type: "toilet", at: [14, 27], facing: "E" },
    { type: "shower-glass", at: [17.5, 77.5], facing: "E", widthIn: 47, depthIn: 35 },
    { type: "tub-alcove", at: [52.2, 133.9] },
    { type: "vanity-double", at: [134, 158], facing: "N", widthIn: 85, depthIn: 22 },
    { type: "door-single", at: [65, 54], widthIn: 28 },
    { type: "door-single", at: [138, 62.9], widthIn: 28 },
    { type: "door-single", at: [205, 117], widthIn: 32 },
    { type: "window-single", at: [0, 140], widthIn: 30, heightIn: 36, elevationIn: 42 },
    { type: "window-single", at: [50, 169], widthIn: 30, heightIn: 36, elevationIn: 42 },
  ],
};

// Independent expected values: the 205 x 169 room is centered on (102.5, 84.5).
const ex = (sx: number) => inches(sx - 102.5);
const ez = (sy: number) => inches(sy - 84.5);
const near = (m: number, expectedM: number, label: string) =>
  assert.ok(Math.abs(toInches(m - expectedM)) <= 0.5, `${label}: ${toInches(m)}in vs ${toInches(expectedM)}in`);

test("Kalca spec validates and converts: outline, walls and fixtures within 0.5in", () => {
  RoomSpecSchema.parse(KALCA);
  const { doc, warnings } = specToDoc(KALCA);

  const pts = doc.room.points;
  assert.equal(pts.length, 4);
  [[0, 0], [205, 0], [205, 169], [0, 169]].forEach(([sx, sy], i) => {
    near(pts[i].x, ex(sx), `outline[${i}].x`);
    near(pts[i].z, ez(sy), `outline[${i}].z`);
  });

  // walls come first, in spec order, with the documented pose formula
  KALCA.walls!.forEach((w, i) => {
    const pose = wallItemPose({ x: ex(w.from[0]), z: ez(w.from[1]) }, { x: ex(w.to[0]), z: ez(w.to[1]) });
    const it = doc.items[i];
    assert.equal(it.defId, w.kind === "pony" ? "pony-wall" : "interior-wall", `wall ${i} type`);
    near(it.x, pose.x, `wall ${i}.x`);
    near(it.z, pose.z, `wall ${i}.z`);
    near(it.w!, pose.w, `wall ${i}.w`);
    assert.ok(Math.abs(it.rotation - pose.rotation) < 1e-6, `wall ${i} rotation`);
  });
  assert.ok(Math.abs(toInches(doc.items[5].h!) - 21) < 1e-6);

  const byType = (t: string) => doc.items.filter((i) => i.defId === t);
  const toilet = byType("toilet")[0];
  near(toilet.x, ex(14), "toilet.x"); near(toilet.z, ez(27), "toilet.z");
  assert.ok(Math.abs(toilet.rotation - Math.PI / 2) < 1e-9, "toilet faces E");
  const shower = byType("shower-glass")[0];
  near(shower.x, ex(17.5), "shower.x"); near(shower.z, ez(77.5), "shower.z");
  near(shower.w!, inches(47), "shower.w"); near(shower.d!, inches(35), "shower.d");
  const vanity = byType("vanity-double")[0];
  near(vanity.x, ex(134), "vanity.x"); near(vanity.z, ez(158), "vanity.z");
  assert.ok(Math.abs(vanity.rotation - Math.PI) < 1e-9, "vanity faces N");
  const tub = byType("tub-alcove")[0];
  near(tub.x, ex(52.2), "tub.x"); near(tub.z, ez(133.9), "tub.z");

  const doors = byType("door-single");
  assert.equal(doors.length, 3);
  // WC door is hosted in the WC south wall: snapped onto it, no warning
  near(doors[0].x, ex(65), "wc door x"); near(doors[0].z, ez(54), "wc door z");
  assert.deepEqual(warnings, [], "Kalca spec converts with no warnings");
  near(doors[1].x, ex(138), "closet door x"); near(doors[1].z, ez(62.9), "closet door z");
  near(doors[2].x, ex(205), "east door x"); near(doors[2].z, ez(117), "east door z");
  const windows = byType("window-single");
  near(windows[0].x, ex(0), "west window x"); near(windows[0].z, ez(140), "west window z");
  near(windows[1].x, ex(50), "south window x"); near(windows[1].z, ez(169), "south window z");
  assert.ok(Math.abs(toInches(windows[0].y!) - 42) < 1e-9);
});

test("closet and WC doors each cut a 28in opening centered on their wall; no phantom openings elsewhere", () => {
  const { doc } = specToDoc(KALCA);
  // wall 3 = closet angled wall (door at its midpoint), wall 1 = WC south wall (door at x=65 of 0..79)
  const closet = openingsOnWall(doc.items[3], doc.items);
  assert.equal(closet.length, 1);
  assert.ok(Math.abs(toInches(closet[0].width) - 28) < 0.01, "closet 28in wide");
  assert.ok(Math.abs(toInches(closet[0].center)) < 0.01, "closet centered");
  assert.ok(Math.abs(closet[0].top - inches(80)) < 1e-9 && closet[0].bottom === 0);
  const wc = openingsOnWall(doc.items[1], doc.items);
  assert.equal(wc.length, 1);
  assert.ok(Math.abs(toInches(wc[0].width) - 28) < 0.01, "wc 28in wide");
  assert.ok(Math.abs(toInches(wc[0].center) - (65 - 39.5)) < 0.01, "wc door 25.5in right of the wall midpoint");
  doc.items.slice(0, 7).forEach((w, i) => {
    if (i !== 1 && i !== 3) assert.equal(openingsOnWall(w, doc.items).length, 0, `wall ${i}`);
  });
});

test("spec -> doc -> spec round trip", () => {
  const { doc } = specToDoc(KALCA);
  const back = docToSpec(doc);
  assert.deepEqual(back.outline, KALCA.outline);
  assert.equal(back.walls!.length, KALCA.walls!.length);
  KALCA.walls!.forEach((w, i) => {
    const b = back.walls![i];
    for (let k = 0; k < 2; k++) {
      assert.ok(Math.abs(b.from[k] - w.from[k]) < 0.05, `wall ${i} from`);
      assert.ok(Math.abs(b.to[k] - w.to[k]) < 0.05, `wall ${i} to`);
    }
    assert.equal(b.kind, w.kind ?? "full");
    assert.equal(b.heightIn, w.heightIn);
  });
  assert.equal(back.items!.length, KALCA.items!.length);

  // the read-back spec is itself valid and converts to the same geometry
  const again = specToDoc(RoomSpecSchema.parse(JSON.parse(JSON.stringify(back)))).doc;
  assert.equal(again.items.length, doc.items.length);
  doc.items.forEach((it, i) => {
    const o = again.items[i];
    assert.equal(o.defId, it.defId);
    assert.ok(Math.abs(toInches(o.x - it.x)) < 0.05 && Math.abs(toInches(o.z - it.z)) < 0.05, `item ${i} position`);
    assert.ok(Math.abs(Math.sin(o.rotation - it.rotation)) < 1e-6 && Math.cos(o.rotation - it.rotation) > 0, `item ${i} rotation`);
  });
});

test("warnings: unknown type, item outside the room, unknown finish, far wall-mount item", () => {
  const { doc, warnings } = specToDoc({
    outline: [[0, 0], [100, 0], [100, 80], [0, 80]],
    floor: "floor-nope",
    items: [
      { type: "flux-capacitor", at: [10, 10] },
      { type: "toilet", at: [300, 300] },
      { type: "window-single", at: [50, 40] },
      { type: "sofa", at: [50, 40], finishes: { fabric: "fab-nope" } },
    ],
  });
  assert.ok(warnings.some((w) => /flux-capacitor.*unknown type/.test(w)));
  assert.ok(warnings.some((w) => /toilet.*outside the room/.test(w)));
  assert.ok(warnings.some((w) => /window-single.*not within 8"/.test(w)));
  assert.ok(warnings.some((w) => /floor "floor-nope"/.test(w)));
  assert.ok(warnings.some((w) => /fab-nope/.test(w)));
  assert.ok(!doc.items.some((i) => i.defId === "flux-capacitor"));
  assert.equal(doc.items.length, 3); // unknown type skipped, the rest kept
});

test("counter-clockwise outlines are normalized and degenerate outlines rejected", () => {
  const { doc } = specToDoc({ outline: [[0, 0], [0, 80], [100, 80], [100, 0]] });
  assert.equal(doc.room.points.length, 4);
  assert.throws(() => specToDoc({ outline: [[0, 0], [10, 0], [20, 0]] }));
  assert.throws(() => RoomSpecSchema.parse({ outline: [[0, 0], [1, 1]] }));
});

test("tool help teaches the format, lists catalog ids, and its example is a valid spec", () => {
  assert.match(ROOM_SPEC_HELP, /INCHES/);
  assert.match(ROOM_SPEC_HELP, /door-single/);
  assert.match(ROOM_SPEC_HELP, /EXAMPLE/);
  const { warnings } = specToDoc(RoomSpecSchema.parse(ROOM_SPEC_EXAMPLE));
  assert.deepEqual(warnings, []);
});

// ---- review round 1 ----

const BOX: RoomSpec["outline"] = [[0, 0], [120, 0], [120, 96], [0, 96]];

test("outline validation: self-crossing, repeated points, spikes and oversize are rejected", () => {
  assert.throws(() => specToDoc({ outline: [[0, 0], [100, 100], [100, 0], [0, 100]] }), /cross or touch/);
  assert.throws(() => specToDoc({ outline: [[0, 0], [100, 0], [100, 0], [100, 80], [0, 80]] }), /same point/);
  assert.throws(() => specToDoc({ outline: [[0, 0], [100, 0], [100, 80], [0, 80], [0, 0]] }), /same point/);
  assert.throws(() => specToDoc({ outline: [[0, 0], [100, 0], [50, 0], [50, 80]] }), /doubles back|cross or touch/);
  assert.throws(() => specToDoc({ outline: [[0, 0], [1300, 0], [1300, 80], [0, 80]] }), /larger than/);
  assert.throws(() => specToDoc({ outline: [[0, 0], [NaN, 0], [100, 80]] }), /non-finite/);
  // an L shape is fine
  specToDoc({ outline: [[0, 0], [100, 0], [100, 40], [50, 40], [50, 80], [0, 80]] });
});

test("facing degrees wrap modulo 360 and non-finite facing is rejected", () => {
  const rot = (facing: number | "E") => specToDoc({ outline: BOX, items: [{ type: "sofa", at: [60, 48], facing }] }).doc.items[0].rotation;
  assert.ok(Math.abs(rot(450) - rot("E")) < 1e-9);
  assert.ok(Number.isFinite(rot(1e308)));
  assert.ok(Math.abs(rot(-90) - rot(270)) < 1e-9);
  assert.throws(() => specToDoc({ outline: BOX, items: [{ type: "sofa", at: [60, 48], facing: Infinity }] }), /non-finite|facing/);
});

test("spec walls obey the Studio 4in-288in bounds", () => {
  assert.throws(() => specToDoc({ outline: BOX, walls: [{ from: [10, 10], to: [12, 10] }] }), /too short/);
  assert.throws(() => specToDoc({ outline: [[0, 0], [400, 0], [400, 80], [0, 80]], walls: [{ from: [0, 40], to: [300, 40] }] }), /too long/);
  specToDoc({ outline: BOX, walls: [{ from: [10, 10], to: [14, 10] }] });
});

test("pony wall height round trips (catalog default 36in is stated, not mistaken for 42in)", () => {
  const { doc } = specToDoc({ outline: BOX, walls: [{ from: [10, 10], to: [60, 10], kind: "pony" }] });
  assert.ok(Math.abs(toInches(doc.items[0].h!) - 42) < 1e-9);
  // a doc whose pony wall has no explicit height renders at the catalog 36in
  const bare = { ...doc, items: [{ ...doc.items[0], h: undefined }] };
  assert.equal(docToSpec(bare).walls![0].heightIn, 36);
  assert.equal(docToSpec(doc).walls![0].heightIn, 42);
});

test("wall label, finishes, thickness, ceiling and room wall thickness round trip", () => {
  const { doc, warnings } = specToDoc({
    outline: BOX,
    wallThicknessIn: 6,
    ceiling: "paint-swiss-coffee",
    walls: [{ from: [10, 10], to: [60, 10], label: "Chase wall", thicknessIn: 6, finishes: { paint: "paint-naval" } }],
  });
  assert.deepEqual(warnings, []);
  assert.ok(Math.abs(toInches(doc.room.wallThickness) - 6) < 1e-9);
  assert.equal(doc.surfaces.ceiling, "paint-swiss-coffee");
  const back = docToSpec(doc);
  assert.equal(back.ceiling, "paint-swiss-coffee");
  assert.equal(back.wallThicknessIn, 6);
  assert.equal(back.walls![0].label, "Chase wall");
  assert.equal(back.walls![0].thicknessIn, 6);
  assert.deepEqual(back.walls![0].finishes, { paint: "paint-naval" });
});

test("niches are outline-only: a niche near an interior wall does not snap onto it", () => {
  const { doc } = specToDoc({
    outline: [[0, 0], [200, 0], [200, 160], [0, 160]],
    walls: [{ from: [60, 20], to: [140, 20] }],
    items: [{ type: "shower-niche", at: [100, 22] }],
  });
  const niche = doc.items[1];
  // stays near the interior wall (not snapped onto its centerline) - it is left alone as freestanding
  assert.ok(Math.abs(toInches(niche.z - doc.items[0].z) - 2) < 0.5);
});

// ---- review round 2 ----

test("an exact 4in wall at 45 degrees survives get -> update (rounded endpoints re-import)", () => {
  const e = 4 / Math.SQRT2;
  const { doc } = specToDoc({ outline: BOX, walls: [{ from: [20, 20], to: [20 + e, 20 + e] }] });
  const back = docToSpec(doc);
  const again = specToDoc(RoomSpecSchema.parse(JSON.parse(JSON.stringify(back))));
  assert.equal(again.doc.items.length, 1);
  // 2-decimal rounding that lands at 3.988in is tolerated, 3.5in is not
  specToDoc({ outline: BOX, walls: [{ from: [20, 20], to: [22.82, 22.82] }] });
  assert.throws(() => specToDoc({ outline: BOX, walls: [{ from: [20, 20], to: [22.5, 22.5] }] }), /too short/);
});

test("a door 8.5in from an interior wall (2in deep) snaps to it; 10.5in stays freestanding", () => {
  const spec = (y: number): RoomSpec => ({
    outline: [[0, 0], [200, 0], [200, 160], [0, 160]],
    walls: [{ from: [50, 80], to: [150, 80] }],
    items: [{ type: "door-single", at: [100, y], widthIn: 28 }],
  });
  const snapped = specToDoc(spec(88.5));
  assert.ok(Math.abs(snapped.doc.items[1].z - snapped.doc.items[0].z) < 1e-9, "centered on the wall");
  assert.deepEqual(snapped.warnings, []);
  const far = specToDoc(spec(90.5));
  assert.ok(far.warnings.some((w) => /not within 8"/.test(w)));
});

test("wall-type items obey the wall length bounds", () => {
  assert.throws(() => specToDoc({ outline: BOX, items: [{ type: "interior-wall", at: [60, 48], widthIn: 1 }] }), /between 4" and 288"/);
  assert.throws(() => specToDoc({ outline: BOX, items: [{ type: "pony-wall", at: [60, 48], widthIn: 400 }] }), /between 4" and 288"/);
  assert.throws(() => specToDoc({ outline: BOX, items: [{ type: "interior-wall-doorway", at: [60, 48], widthIn: 40 }] }), /between 72" and 288"/);
  specToDoc({ outline: BOX, items: [{ type: "interior-wall", at: [60, 48], widthIn: 60 }, { type: "interior-wall-doorway", at: [60, 20], widthIn: 100 }] });
  assert.match(ROOM_SPEC_HELP, /walls\[\], not items\[\]/);
});

// ---- review round 3 ----

test("T-junction repro: door snapped to the horizontal wall at a perpendicular wall's line cuts only the horizontal wall", () => {
  const { doc, warnings } = specToDoc({
    outline: [[0, 0], [200, 0], [200, 160], [0, 160]],
    walls: [{ from: [66, 30], to: [66, 130] }, { from: [50, 80], to: [150, 80] }],
    items: [{ type: "door-single", at: [50, 81], widthIn: 32 }],
  });
  assert.deepEqual(warnings, []);
  const [vertical, horizontal] = doc.items;
  const h = openingsOnWall(horizontal, doc.items, wallSegments(doc.room.points));
  assert.equal(h.length, 1);
  assert.ok(Math.abs(toInches(h[0].width) - 32) < 0.01);
  assert.equal(openingsOnWall(vertical, doc.items, wallSegments(doc.room.points)).length, 0);
});

test("stored wall length is clamped to 4in-288in after the tolerance check", () => {
  const short = specToDoc({ outline: BOX, walls: [{ from: [20, 20], to: [22.82, 22.82] }] }).doc.items[0];
  assert.ok(toInches(short.w!) >= 4 - 1e-9, `short wall stored at ${toInches(short.w!)}`);
  const long = specToDoc({ outline: [[0, 0], [400, 0], [400, 80], [0, 80]], walls: [{ from: [0, 40], to: [288.04, 40] }] }).doc.items[0];
  assert.ok(toInches(long.w!) <= 288 + 1e-9);
  const asItem = specToDoc({ outline: BOX, items: [{ type: "interior-wall", at: [60, 48], widthIn: 3.97 }] }).doc.items[0];
  assert.ok(toInches(asItem.w!) >= 4 - 1e-9);
});
