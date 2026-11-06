import test from "node:test";
import assert from "node:assert/strict";
import { parseLength, wallItemPose, wallEndpoints, snapDrawPoint, lengthKeyEdit, wallLengthProblem } from "../src/lib/studio/walls";
import { inches } from "../src/lib/studio/units";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test("parseLength accepts every documented format", () => {
  const cases: Array<[string, number]> = [
    ["54", 54], ['54"', 54], ["54 in", 54], ["4'6\"", 54], ["4' 6", 54], ["4'6", 54],
    ["4.5'", 54], ["4 ft 6 in", 54], ["10'", 120], ["  10 ft ", 120], ["0.5", 0.5],
  ];
  for (const [text, inch] of cases) {
    const m = parseLength(text);
    assert.notEqual(m, null, text);
    close(m!, inches(inch));
  }
});

test("parseLength rejects empty, zero, negative, junk", () => {
  for (const bad of ["", "   ", "0", "0'", "-5", "-4'6", "abc", "4'6\"x", "4 5 6", "1/0", "ft"]) {
    assert.equal(parseLength(bad), null, bad);
  }
});

test("pose and endpoints round-trip at 0, 90, 45 and arbitrary angles", () => {
  const cases = [
    [{ x: 0, z: 0 }, { x: 2, z: 0 }],
    [{ x: 1, z: 1 }, { x: 1, z: 3 }],
    [{ x: 0, z: 0 }, { x: 1, z: 1 }],
    [{ x: 2, z: 3 }, { x: -1, z: -0.5 }],
    [{ x: -0.3, z: 0.7 }, { x: 0.9, z: -2.1 }],
  ];
  for (const [a, b] of cases) {
    const pose = wallItemPose(a, b);
    close(pose.w, Math.hypot(b.x - a.x, b.z - a.z));
    const e = wallEndpoints(pose, pose.w);
    close(e.a.x, a.x); close(e.a.z, a.z); close(e.b.x, b.x); close(e.b.z, b.z);
  }
});

test("pose matches the verified formula", () => {
  const p = wallItemPose({ x: 0, z: 0 }, { x: 1, z: 1 });
  close(p.rotation, -Math.PI / 4);
  close(p.x, 0.5); close(p.z, 0.5);
});

const ctx = (angleSnap = true, anchors: Array<{ x: number; z: number }> = []) => ({ anchors, angleSnap });

test("snapDrawPoint: endpoint snap wins over angle snap", () => {
  const anchor = { x: 1, z: 0.3 };
  const p = snapDrawPoint({ x: 1.05, z: 0.32 }, { x: 0, z: 0 }, ctx(true, [anchor]));
  assert.deepEqual(p, anchor);
});

test("snapDrawPoint: ignores anchors beyond 4 inches", () => {
  const p = snapDrawPoint({ x: 1, z: 0.0 }, { x: 0, z: 0 }, ctx(true, [{ x: 1, z: inches(5) }]));
  close(p.z, 0, 1e-9);
});

test("snapDrawPoint: snaps to 45 degrees and rounds length to half inch", () => {
  const p = snapDrawPoint({ x: 1.0, z: 0.08 }, { x: 0, z: 0 }, ctx());
  close(p.z, 0, 1e-9);
  close(p.x / inches(0.5), Math.round(p.x / inches(0.5)), 1e-6);
  const d = snapDrawPoint({ x: 1.0, z: 1.1 }, { x: 0, z: 0 }, ctx());
  close(d.x, d.z, 1e-9);
  const len = Math.hypot(d.x, d.z);
  close(len / inches(0.5), Math.round(len / inches(0.5)), 1e-6);
});

test("snapDrawPoint: Shift (angleSnap off) keeps a free angle on the 1 inch grid", () => {
  const raw = { x: inches(30.3), z: inches(10.4) };
  const p = snapDrawPoint(raw, { x: 0, z: 0 }, ctx(false));
  close(p.x, inches(30)); close(p.z, inches(10));
});

test("snapDrawPoint: no start point uses the grid", () => {
  const p = snapDrawPoint({ x: inches(12.4), z: inches(-7.6) }, null, ctx());
  close(p.x, inches(12)); close(p.z, inches(-8));
});

test("lengthKeyEdit collects keys, backspace, submit and cancel", () => {
  let t = "";
  for (const k of ["5", "4"]) t = lengthKeyEdit(t, k).text;
  assert.equal(t, "54");
  assert.equal(lengthKeyEdit(t, "Backspace").text, "5");
  assert.equal(lengthKeyEdit("4", "'").text, "4'");
  assert.equal(lengthKeyEdit("4", " ").text, "4 ");
  assert.equal(lengthKeyEdit("6", "Enter").action, "submit");
  assert.equal(lengthKeyEdit("6", "Escape").action, "cancel");
  assert.deepEqual(lengthKeyEdit("6", "x"), { text: "6", action: "none" });
  assert.deepEqual(lengthKeyEdit("6", "Shift"), { text: "6", action: "none" });
});

test("parseLength accepts fractions and carpenter dashes", () => {
  const cases: Array<[string, number]> = [
    ["54 1/2", 54.5], ["1/2", 0.5], ["3/4\"", 0.75], ["4'6 1/2\"", 54.5],
    ["4'-6\"", 54], ["4' - 6\"", 54], ["4'-6 1/2\"", 54.5], ["10'-0\"", 120], ["54.5", 54.5],
  ];
  for (const [text, inch] of cases) {
    const m = parseLength(text);
    assert.notEqual(m, null, text);
    close(m!, inches(inch));
  }
  for (const bad of ["1/0x", "4'-", "-6\"", "1/2/3", "4' -- 6"]) assert.equal(parseLength(bad), null, bad);
});

test("wallLengthProblem: exact 4 and 288 inches pass, outside fails", () => {
  assert.equal(wallLengthProblem(parseLength("4")!), null);
  assert.equal(wallLengthProblem(parseLength("24'")!), null);
  assert.equal(wallLengthProblem(inches(3.9)), "short");
  assert.equal(wallLengthProblem(inches(288.5)), "long");
});
