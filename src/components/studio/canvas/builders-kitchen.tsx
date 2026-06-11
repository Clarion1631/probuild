"use client";

// Room Studio - procedural builders: cabinets, appliances, bath fixtures.
//
// Local space contract: origin at footprint center ON THE FLOOR (y=0 bottom),
// front faces +Z, x spans [-w/2, w/2]. The wrapping ItemNode positions/rotates.

import { inches } from "@/lib/studio/units";
import {
  Box, Cyl, Ball, ShakerFront, BarPull, mat, matShade, glassMat, blackGlassMat,
  ceramicMat, fixedMat, flameMat, bulbMat,
} from "./parts";
import type { BuilderProps } from "./builders";
import * as THREE from "three";

const IN = inches;
const TOE_H = IN(4);
const TOE_IN = IN(3);
const DOOR_T = IN(0.85);
const COUNTER_T = IN(1.5);
const COUNTER_OVER = IN(1);

/** Carcass + toe kick shared by base cabinets. Returns y of counter top surface. */
function BaseCarcass({ w, d, h, finish }: { w: number; d: number; h: number; finish?: string }) {
  return (
    <>
      {/* toe kick (recessed, dark) */}
      <Box s={[w - IN(1), TOE_H, d - TOE_IN]} p={[0, TOE_H / 2, -TOE_IN / 2]} m={matShade(finish, 0.45)} castShadow={false} />
      {/* carcass */}
      <Box s={[w, h - TOE_H, d]} p={[0, TOE_H + (h - TOE_H) / 2, 0]} m={mat(finish)} />
    </>
  );
}

function CounterSlab({ w, d, h, counter }: { w: number; d: number; h: number; counter?: string }) {
  return (
    <Box
      s={[w + COUNTER_OVER, COUNTER_T, d + COUNTER_OVER]}
      p={[0, h + COUNTER_T / 2, COUNTER_OVER / 4]}
      m={mat(counter, "counter-quartz-white")}
    />
  );
}

export function CabinetBase({ w, d, h, finishes }: BuilderProps) {
  const f = finishes.cabinet;
  const doors = w > IN(27) ? 2 : 1;
  const dw = (w - IN(2)) / doors;
  const frontH = h - TOE_H - IN(1);
  return (
    <group>
      <BaseCarcass w={w} d={d} h={h} finish={f} />
      {Array.from({ length: doors }, (_, i) => {
        const x = doors === 1 ? 0 : (i === 0 ? -dw / 2 - IN(0.25) : dw / 2 + IN(0.25));
        return (
          <group key={i} position={[x, TOE_H + frontH / 2 + IN(0.5), d / 2]}>
            <ShakerFront w={dw} h={frontH} t={DOOR_T} finish={f} />
            <BarPull len={IN(5)} finish={finishes.hardware} vertical
              p={[(i === 0 && doors === 2) || doors === 1 ? dw / 2 - IN(2) : -dw / 2 + IN(2), frontH / 2 - IN(4), DOOR_T + 0.008]} />
          </group>
        );
      })}
      <CounterSlab w={w} d={d} h={h} counter={finishes.counter} />
    </group>
  );
}

export function CabinetDrawers({ w, d, h, finishes }: BuilderProps) {
  const f = finishes.cabinet;
  const stackH = h - TOE_H - IN(1);
  const rows = [0.28, 0.36, 0.36];
  let yCur = TOE_H + IN(0.5) + stackH;
  return (
    <group>
      <BaseCarcass w={w} d={d} h={h} finish={f} />
      {rows.map((frac, i) => {
        const rh = stackH * frac - IN(0.4);
        yCur -= stackH * frac;
        const y = yCur + (stackH * frac) / 2;
        return (
          <group key={i} position={[0, y, d / 2]}>
            <ShakerFront w={w - IN(2)} h={rh} t={DOOR_T} finish={f} />
            <BarPull len={Math.min(IN(8), w * 0.4)} finish={finishes.hardware} p={[0, 0, DOOR_T + 0.008]} />
          </group>
        );
      })}
      <CounterSlab w={w} d={d} h={h} counter={finishes.counter} />
    </group>
  );
}

export function CabinetSink({ w, d, h, finishes }: BuilderProps) {
  const f = finishes.cabinet;
  const frontH = h - TOE_H - IN(1);
  const dw = (w - IN(2)) / 2;
  const basinW = Math.min(w - IN(6), IN(30));
  return (
    <group>
      <BaseCarcass w={w} d={d} h={h} finish={f} />
      {/* false drawer front strip + doors */}
      <group position={[0, TOE_H + frontH - IN(3), d / 2]}>
        <ShakerFront w={w - IN(2)} h={IN(6)} t={DOOR_T} finish={f} />
      </group>
      {[-1, 1].map((sgn) => (
        <group key={sgn} position={[sgn * (dw / 2 + IN(0.25)), TOE_H + (frontH - IN(7)) / 2 + IN(0.5), d / 2]}>
          <ShakerFront w={dw} h={frontH - IN(7)} t={DOOR_T} finish={f} />
          <BarPull len={IN(5)} finish={finishes.hardware} vertical p={[sgn * (-dw / 2 + IN(2)), (frontH - IN(7)) / 2 - IN(4), DOOR_T + 0.008]} />
        </group>
      ))}
      <CounterSlab w={w} d={d} h={h} counter={finishes.counter} />
      {/* undermount basin visual: rim + dark interior */}
      <Box s={[basinW, IN(1), d - IN(8)]} p={[0, h + COUNTER_T, -IN(1)]} m={mat(finishes.sink, "metal-stainless")} castShadow={false} />
      <Box s={[basinW - IN(2), IN(1.2), d - IN(10)]} p={[0, h + COUNTER_T - IN(0.2), -IN(1)]} m={matShade(finishes.sink, 0.5, "metal-stainless")} castShadow={false} />
      {/* faucet */}
      <group position={[0, h + COUNTER_T, -d / 2 + IN(3.5)]}>
        <Cyl rTop={IN(0.5)} rBot={IN(0.7)} h={IN(9)} p={[0, IN(4.5), 0]} m={mat(finishes.faucet, "metal-brushed-nickel")} seg={12} />
        <Cyl rTop={IN(0.4)} rBot={IN(0.4)} h={IN(6)} p={[0, IN(9), IN(2.5)]} rot={[Math.PI / 2.4, 0, 0]} m={mat(finishes.faucet, "metal-brushed-nickel")} seg={10} />
      </group>
    </group>
  );
}

export function CabinetCorner({ w, d, h, finishes }: BuilderProps) {
  const f = finishes.cabinet;
  const frontH = h - TOE_H - IN(1);
  return (
    <group>
      <BaseCarcass w={w} d={d} h={h} finish={f} />
      {/* angled corner door */}
      <group position={[0, TOE_H + frontH / 2 + IN(0.5), 0]} rotation={[0, Math.PI / 4, 0]}>
        <group position={[0, 0, Math.min(w, d) * 0.62]}>
          <ShakerFront w={Math.min(w, d) * 0.55} h={frontH} t={DOOR_T} finish={f} />
          <Knub finishes={finishes} y={0} />
        </group>
      </group>
      <CounterSlab w={w} d={d} h={h} counter={finishes.counter} />
    </group>
  );
}

function Knub({ finishes, y }: { finishes: Record<string, string | undefined>; y: number }) {
  return <Ball r={0.012} p={[0, y, DOOR_T + 0.01]} m={mat(finishes.hardware, "metal-brushed-nickel")} seg={10} />;
}

export function CabinetCooktop(props: BuilderProps) {
  const { w, d, h, finishes } = props;
  return (
    <group>
      <CabinetDrawers {...props} />
      {/* cooktop glass + burners */}
      <Box s={[w - IN(4), IN(0.5), d - IN(6)]} p={[0, h + COUNTER_T + IN(0.25), 0]} m={blackGlassMat()} castShadow={false} />
      {burners(w, d, h + COUNTER_T + IN(0.55))}
    </group>
  );
}

function burners(w: number, d: number, y: number) {
  const positions: Array<[number, number]> = [
    [-w / 4, -d / 5], [w / 4, -d / 5], [-w / 4, d / 6], [w / 4, d / 6],
  ];
  return positions.map(([x, z], i) => (
    <Cyl key={i} rTop={IN(3.4)} rBot={IN(3.4)} h={IN(0.18)} p={[x, y, z]} m={fixedMat("burner", () => new THREE.MeshStandardMaterial({ color: "#2a2d31", roughness: 0.5, metalness: 0.4 }))} seg={20} castShadow={false} />
  ));
}

export function Island({ w, d, h, finishes }: BuilderProps) {
  const f = finishes.cabinet;
  const frontH = h - TOE_H - IN(1);
  const panels = Math.max(2, Math.round(w / IN(24)));
  const pw = (w - IN(2)) / panels;
  return (
    <group>
      <BaseCarcass w={w} d={d} h={h} finish={f} />
      {Array.from({ length: panels }, (_, i) => {
        const x = -w / 2 + IN(1) + pw * (i + 0.5);
        return (
          <group key={i} position={[x, TOE_H + frontH / 2 + IN(0.5), d / 2]}>
            <ShakerFront w={pw - IN(0.5)} h={frontH} t={DOOR_T} finish={f} />
          </group>
        );
      })}
      {/* back side panels too */}
      {Array.from({ length: panels }, (_, i) => {
        const x = -w / 2 + IN(1) + pw * (i + 0.5);
        return (
          <group key={`b${i}`} position={[x, TOE_H + frontH / 2 + IN(0.5), -d / 2]} rotation={[0, Math.PI, 0]}>
            <ShakerFront w={pw - IN(0.5)} h={frontH} t={DOOR_T} finish={f} />
          </group>
        );
      })}
      <CounterSlab w={w} d={d} h={h} counter={finishes.counter} />
    </group>
  );
}

export function IslandOverhang(props: BuilderProps) {
  const { w, d, h, finishes } = props;
  const overhang = IN(12);
  const cabD = d - overhang;
  return (
    <group>
      <group position={[0, 0, overhang / 2]}>
        <Island {...props} d={cabD} />
      </group>
      {/* extended slab covering the seating side */}
      <Box s={[w + COUNTER_OVER, COUNTER_T, d + COUNTER_OVER]} p={[0, h + COUNTER_T / 2, 0]} m={mat(finishes.counter, "counter-quartz-white")} />
    </group>
  );
}

export function CabinetWall({ w, d, h, finishes }: BuilderProps) {
  const f = finishes.cabinet;
  const doors = w > IN(24) ? 2 : 1;
  const dw = (w - IN(1.5)) / doors;
  return (
    <group>
      <Box s={[w, h, d]} p={[0, h / 2, 0]} m={mat(f)} />
      {Array.from({ length: doors }, (_, i) => {
        const x = doors === 1 ? 0 : (i === 0 ? -dw / 2 - IN(0.2) : dw / 2 + IN(0.2));
        return (
          <group key={i} position={[x, h / 2, d / 2]}>
            <ShakerFront w={dw} h={h - IN(1)} t={DOOR_T} finish={f} />
            <BarPull len={IN(4)} finish={finishes.hardware} vertical
              p={[(i === 0 && doors === 2) || doors === 1 ? dw / 2 - IN(1.5) : -dw / 2 + IN(1.5), -h / 2 + IN(4), DOOR_T + 0.008]} />
          </group>
        );
      })}
    </group>
  );
}

export function CabinetWallGlass({ w, d, h, finishes }: BuilderProps) {
  const f = finishes.cabinet;
  return (
    <group>
      <Box s={[w, h, d]} p={[0, h / 2, -IN(0.5)]} m={matShade(f, 0.25)} />
      {/* frame */}
      <Box s={[w, IN(1.5), DOOR_T]} p={[0, h - IN(0.75), d / 2]} m={mat(f)} />
      <Box s={[w, IN(1.5), DOOR_T]} p={[0, IN(0.75), d / 2]} m={mat(f)} />
      <Box s={[IN(1.5), h, DOOR_T]} p={[-w / 2 + IN(0.75), h / 2, d / 2]} m={mat(f)} />
      <Box s={[IN(1.5), h, DOOR_T]} p={[w / 2 - IN(0.75), h / 2, d / 2]} m={mat(f)} />
      <Box s={[IN(1.5), h, DOOR_T]} p={[0, h / 2, d / 2]} m={mat(f)} />
      {/* glass panes */}
      <Box s={[w - IN(3), h - IN(3), IN(0.2)]} p={[0, h / 2, d / 2]} m={glassMat()} castShadow={false} />
      {/* interior shelves visible through glass */}
      <Box s={[w - IN(2), IN(0.8), d - IN(2)]} p={[0, h * 0.36, 0]} m={matShade(f, 0.1)} castShadow={false} />
      <Box s={[w - IN(2), IN(0.8), d - IN(2)]} p={[0, h * 0.68, 0]} m={matShade(f, 0.1)} castShadow={false} />
    </group>
  );
}

export function OpenShelves({ w, d, h, finishes }: BuilderProps) {
  const shelfT = IN(1.6);
  return (
    <group>
      {[0, 1].map((i) => (
        <Box key={i} s={[w, shelfT, d]} p={[0, i * (h - shelfT) + shelfT / 2, 0]} m={mat(finishes.wood, "wood-oak")} />
      ))}
      {/* brackets */}
      {[-w / 2 + IN(3), w / 2 - IN(3)].map((x, i) => (
        <group key={i}>
          <Box s={[IN(0.4), IN(3), d * 0.8]} p={[x, h - shelfT - IN(1.5), 0]} m={mat(finishes.hardware, "metal-matte-black")} castShadow={false} />
          <Box s={[IN(0.4), IN(3), d * 0.8]} p={[x, shelfT + IN(0.2) - IN(1.5) + IN(1.5), 0]} m={mat(finishes.hardware, "metal-matte-black")} castShadow={false} />
        </group>
      ))}
    </group>
  );
}

export function CabinetTall({ w, d, h, finishes }: BuilderProps) {
  const f = finishes.cabinet;
  const split = h * 0.62;
  return (
    <group>
      <Box s={[w, h - TOE_H, d]} p={[0, TOE_H + (h - TOE_H) / 2, 0]} m={mat(f)} />
      <Box s={[w - IN(1), TOE_H, d - TOE_IN]} p={[0, TOE_H / 2, -TOE_IN / 2]} m={matShade(f, 0.45)} castShadow={false} />
      <group position={[0, TOE_H + (split - TOE_H) / 2, d / 2]}>
        <ShakerFront w={w - IN(1.5)} h={split - TOE_H - IN(0.5)} t={DOOR_T} finish={f} />
        <BarPull len={IN(6)} finish={finishes.hardware} vertical p={[w / 2 - IN(2.5), (split - TOE_H) / 2 - IN(6), DOOR_T + 0.008]} />
      </group>
      <group position={[0, split + (h - split) / 2, d / 2]}>
        <ShakerFront w={w - IN(1.5)} h={h - split - IN(0.5)} t={DOOR_T} finish={f} />
        <BarPull len={IN(6)} finish={finishes.hardware} vertical p={[w / 2 - IN(2.5), -(h - split) / 2 + IN(6), DOOR_T + 0.008]} />
      </group>
    </group>
  );
}

export function CabinetOvenTower({ w, d, h, finishes }: BuilderProps) {
  const f = finishes.cabinet;
  const ovenY = h * 0.42;
  const ovenH = IN(28);
  return (
    <group>
      <Box s={[w, h - TOE_H, d]} p={[0, TOE_H + (h - TOE_H) / 2, 0]} m={mat(f)} />
      <Box s={[w - IN(1), TOE_H, d - TOE_IN]} p={[0, TOE_H / 2, -TOE_IN / 2]} m={matShade(f, 0.45)} castShadow={false} />
      {/* double oven stack */}
      <Box s={[w - IN(2), ovenH, IN(1)]} p={[0, ovenY + ovenH / 2 - IN(4), d / 2]} m={mat(finishes.metal, "metal-stainless")} />
      <Box s={[w - IN(4), ovenH * 0.42, IN(0.4)]} p={[0, ovenY + ovenH * 0.68 - IN(4), d / 2 + IN(0.5)]} m={blackGlassMat()} castShadow={false} />
      <Box s={[w - IN(4), ovenH * 0.42, IN(0.4)]} p={[0, ovenY + ovenH * 0.2 - IN(4), d / 2 + IN(0.5)]} m={blackGlassMat()} castShadow={false} />
      <BarPull len={w - IN(6)} finish={"metal-stainless"} p={[0, ovenY + ovenH - IN(3.5), d / 2 + IN(1)]} />
      {/* doors above + below */}
      <group position={[0, (h + ovenY + ovenH) / 2 - IN(1), d / 2]}>
        <ShakerFront w={w - IN(1.5)} h={h - (ovenY + ovenH) - IN(2)} t={DOOR_T} finish={f} />
      </group>
      <group position={[0, TOE_H + (ovenY - IN(4) - TOE_H) / 2, d / 2]}>
        <ShakerFront w={w - IN(1.5)} h={ovenY - TOE_H - IN(5)} t={DOOR_T} finish={f} />
      </group>
    </group>
  );
}

function VanityBody({ w, d, h, finishes }: BuilderProps) {
  const f = finishes.cabinet;
  const frontH = h - TOE_H - IN(1);
  const doors = w > IN(30) ? 2 : 1;
  const dw = (w - IN(2)) / doors;
  return (
    <group>
      <BaseCarcass w={w} d={d} h={h} finish={f} />
      {Array.from({ length: doors }, (_, i) => {
        const x = doors === 1 ? 0 : (i === 0 ? -dw / 2 - IN(0.25) : dw / 2 + IN(0.25));
        return (
          <group key={i} position={[x, TOE_H + frontH / 2 + IN(0.5), d / 2]}>
            <ShakerFront w={dw} h={frontH} t={DOOR_T} finish={f} />
            <Knub finishes={finishes} y={frontH / 2 - IN(4)} />
          </group>
        );
      })}
      <CounterSlab w={w} d={d} h={h} counter={finishes.counter} />
    </group>
  );
}

export function Vanity(props: BuilderProps) {
  const { d, h, finishes } = props;
  return (
    <group>
      <VanityBody {...props} />
      <VanityBasin x={0} d={d} h={h} faucet={finishes.sink} />
    </group>
  );
}

export function VanityDouble(props: BuilderProps) {
  const { w, d, h, finishes } = props;
  return (
    <group>
      <VanityBody {...props} />
      <VanityBasin x={-w / 4} d={d} h={h} faucet={finishes.sink} />
      <VanityBasin x={w / 4} d={d} h={h} faucet={finishes.sink} />
    </group>
  );
}

function VanityBasin({ x, d, h, faucet }: { x: number; d: number; h: number; faucet?: string }) {
  return (
    <group position={[x, 0, 0]}>
      <Cyl rTop={IN(7)} rBot={IN(6)} h={IN(1.2)} p={[0, h + COUNTER_T + IN(0.4), IN(1)]} m={ceramicMat()} seg={24} castShadow={false} />
      <group position={[0, h + COUNTER_T, -d / 2 + IN(3)]}>
        <Cyl rTop={IN(0.45)} rBot={IN(0.6)} h={IN(7)} p={[0, IN(3.5), 0]} m={mat(faucet, "metal-chrome")} seg={10} />
        <Cyl rTop={IN(0.35)} rBot={IN(0.35)} h={IN(4)} p={[0, IN(7), IN(1.6)]} rot={[Math.PI / 2.6, 0, 0]} m={mat(faucet, "metal-chrome")} seg={8} />
      </group>
    </group>
  );
}

// -------------------------------- Appliances --------------------------------

export function FridgeFrench({ w, d, h, finishes }: BuilderProps) {
  const m1 = mat(finishes.metal, "metal-stainless");
  const splitY = h * 0.42;
  return (
    <group>
      <Box s={[w, h, d]} p={[0, h / 2, 0]} m={m1} />
      {/* door seams */}
      <Box s={[IN(0.3), h - splitY - IN(1), IN(0.2)]} p={[0, splitY + (h - splitY) / 2, d / 2]} m={matShade(finishes.metal, 0.5, "metal-stainless")} castShadow={false} />
      <Box s={[w - IN(1), IN(0.3), IN(0.2)]} p={[0, splitY, d / 2]} m={matShade(finishes.metal, 0.5, "metal-stainless")} castShadow={false} />
      {/* handles */}
      <BarPull len={h * 0.3} finish={finishes.metal} vertical p={[-IN(2.2), splitY + h * 0.22, d / 2 + IN(1)]} />
      <BarPull len={h * 0.3} finish={finishes.metal} vertical p={[IN(2.2), splitY + h * 0.22, d / 2 + IN(1)]} />
      <BarPull len={w * 0.5} finish={finishes.metal} p={[0, splitY - IN(3), d / 2 + IN(1)]} />
    </group>
  );
}

export function FridgeSide({ w, d, h, finishes }: BuilderProps) {
  const m1 = mat(finishes.metal, "metal-stainless");
  return (
    <group>
      <Box s={[w, h, d]} p={[0, h / 2, 0]} m={m1} />
      <Box s={[IN(0.3), h - IN(2), IN(0.2)]} p={[-w * 0.1, h / 2, d / 2]} m={matShade(finishes.metal, 0.5, "metal-stainless")} castShadow={false} />
      <BarPull len={h * 0.42} finish={finishes.metal} vertical p={[-w * 0.1 - IN(2), h * 0.55, d / 2 + IN(1)]} />
      <BarPull len={h * 0.42} finish={finishes.metal} vertical p={[-w * 0.1 + IN(2), h * 0.55, d / 2 + IN(1)]} />
    </group>
  );
}

export function Range({ w, d, h, finishes }: BuilderProps) {
  const m1 = mat(finishes.metal, "metal-stainless");
  return (
    <group>
      <Box s={[w, h - IN(1.5), d]} p={[0, (h - IN(1.5)) / 2, 0]} m={m1} />
      {/* oven window */}
      <Box s={[w - IN(6), h * 0.34, IN(0.4)]} p={[0, h * 0.34, d / 2]} m={blackGlassMat()} castShadow={false} />
      <BarPull len={w - IN(8)} finish={finishes.metal} p={[0, h * 0.62, d / 2 + IN(1)]} />
      {/* cooktop surface + burners */}
      <Box s={[w, IN(1.2), d]} p={[0, h - IN(0.6), 0]} m={blackGlassMat()} />
      {burners(w, d, h + IN(0.05))}
      {/* control panel */}
      <Box s={[w, IN(1.4), IN(1)]} p={[0, h - IN(0.7), -d / 2 + IN(0.5)]} m={m1} castShadow={false} />
    </group>
  );
}

export function RangePro(props: BuilderProps) {
  const { w, d, h, finishes } = props;
  return (
    <group>
      <Range {...props} />
      {/* pro touches: knob row + thicker handle */}
      {Array.from({ length: 6 }, (_, i) => (
        <Cyl key={i} rTop={IN(0.8)} rBot={IN(0.8)} h={IN(0.8)} rot={[Math.PI / 2, 0, 0]}
          p={[-w / 2 + IN(4) + i * ((w - IN(8)) / 5), h * 0.74, d / 2 + IN(0.4)]} m={mat(finishes.metal, "metal-stainless")} seg={12} castShadow={false} />
      ))}
    </group>
  );
}

export function Hood({ w, d, h, finishes }: BuilderProps) {
  const m1 = mat(finishes.metal, "metal-stainless");
  return (
    <group>
      {/* canopy */}
      <Box s={[w, IN(7), d]} p={[0, IN(3.5), 0]} m={m1} />
      {/* tapered chimney */}
      <Box s={[w * 0.42, h - IN(7), d * 0.55]} p={[0, IN(7) + (h - IN(7)) / 2, -d * 0.1]} m={m1} />
    </group>
  );
}

export function Dishwasher({ w, d, h, finishes }: BuilderProps) {
  const m1 = mat(finishes.metal, "metal-stainless");
  return (
    <group>
      <Box s={[w, h - TOE_H, d]} p={[0, TOE_H + (h - TOE_H) / 2, 0]} m={m1} />
      <Box s={[w - IN(1), TOE_H, d - IN(2)]} p={[0, TOE_H / 2, -IN(1)]} m={matShade(finishes.metal, 0.55, "metal-stainless")} castShadow={false} />
      <BarPull len={w - IN(5)} finish={finishes.metal} p={[0, h - IN(3), d / 2 + IN(0.9)]} />
      <Box s={[w, COUNTER_T, d]} p={[0, h + COUNTER_T / 2, 0]} m={mat("counter-quartz-white", "counter-quartz-white")} />
    </group>
  );
}

export function Microwave({ w, d, h, finishes }: BuilderProps) {
  const m1 = mat(finishes.metal, "metal-stainless");
  return (
    <group>
      <Box s={[w, h, d]} p={[0, h / 2, 0]} m={m1} />
      <Box s={[w * 0.62, h - IN(3), IN(0.3)]} p={[-w * 0.12, h / 2, d / 2]} m={blackGlassMat()} castShadow={false} />
      <Box s={[w * 0.2, h - IN(3), IN(0.2)]} p={[w * 0.36, h / 2, d / 2]} m={matShade(finishes.metal, 0.3, "metal-stainless")} castShadow={false} />
    </group>
  );
}

export function WineFridge({ w, d, h, finishes }: BuilderProps) {
  return (
    <group>
      <Box s={[w, h - TOE_H, d]} p={[0, TOE_H + (h - TOE_H) / 2, 0]} m={mat(finishes.metal, "metal-black-stainless")} />
      <Box s={[w - IN(3), h - TOE_H - IN(3), IN(0.4)]} p={[0, TOE_H + (h - TOE_H) / 2, d / 2]} m={glassMat()} castShadow={false} />
      {/* bottle rows */}
      {Array.from({ length: 4 }, (_, r) => (
        <Box key={r} s={[w - IN(5), IN(0.5), d - IN(6)]} p={[0, TOE_H + IN(5) + r * IN(6), 0]} m={matShade(finishes.metal, 0.3, "metal-black-stainless")} castShadow={false} />
      ))}
      <BarPull len={h * 0.4} finish={"metal-stainless"} vertical p={[w / 2 - IN(2), h * 0.5, d / 2 + IN(0.8)]} />
      <Box s={[w, COUNTER_T, d]} p={[0, h + COUNTER_T / 2, 0]} m={mat("counter-quartz-white", "counter-quartz-white")} />
    </group>
  );
}

export function Washer({ w, d, h, finishes }: BuilderProps) {
  const m1 = mat(finishes.metal, "metal-stainless");
  return (
    <group>
      <Box s={[w, h, d]} p={[0, h / 2, 0]} m={m1} />
      {/* round porthole door */}
      <Cyl rTop={IN(9)} rBot={IN(9)} h={IN(1)} rot={[Math.PI / 2, 0, 0]} p={[0, h * 0.45, d / 2]} m={matShade(finishes.metal, 0.25, "metal-stainless")} seg={24} castShadow={false} />
      <Cyl rTop={IN(7)} rBot={IN(7)} h={IN(1.2)} rot={[Math.PI / 2, 0, 0]} p={[0, h * 0.45, d / 2 + IN(0.1)]} m={blackGlassMat()} seg={24} castShadow={false} />
      <Box s={[w - IN(4), IN(2.5), IN(0.5)]} p={[0, h - IN(2.5), d / 2]} m={blackGlassMat()} castShadow={false} />
    </group>
  );
}

export function Dryer(props: BuilderProps) {
  return <Washer {...props} />;
}

// -------------------------------- Fixtures --------------------------------

export function SinkFarmhouse({ w, d, h, finishes }: BuilderProps) {
  return (
    <group>
      <Box s={[w, h, d]} p={[0, h / 2, 0]} m={ceramicMat()} />
      <Box s={[w - IN(2.5), IN(2), d - IN(3)]} p={[0, h - IN(1), 0]} m={fixedMat("basin-int", () => new THREE.MeshStandardMaterial({ color: "#dfe0db", roughness: 0.3 }))} castShadow={false} />
      <group position={[0, h, -d / 2 + IN(2)]}>
        <Cyl rTop={IN(0.5)} rBot={IN(0.7)} h={IN(9)} p={[0, IN(4.5), 0]} m={mat(finishes.faucet, "metal-brushed-nickel")} seg={12} />
        <Cyl rTop={IN(0.4)} rBot={IN(0.4)} h={IN(6)} p={[0, IN(9), IN(2.5)]} rot={[Math.PI / 2.4, 0, 0]} m={mat(finishes.faucet, "metal-brushed-nickel")} seg={10} />
      </group>
    </group>
  );
}

export function Toilet({ w, d, h }: BuilderProps) {
  return (
    <group>
      {/* tank */}
      <Box s={[w, h * 0.55, IN(7)]} p={[0, h * 0.5, -d / 2 + IN(4)]} m={ceramicMat()} />
      <Box s={[w + IN(1), IN(1.5), IN(8)]} p={[0, h * 0.78, -d / 2 + IN(4)]} m={ceramicMat()} />
      {/* bowl */}
      <Cyl rTop={w * 0.55} rBot={w * 0.34} h={IN(13)} p={[0, IN(8), IN(3)]} m={ceramicMat()} seg={22} />
      {/* seat */}
      <Cyl rTop={w * 0.58} rBot={w * 0.58} h={IN(1.2)} p={[0, IN(15), IN(3)]} m={ceramicMat()} seg={22} />
    </group>
  );
}

export function Tub({ w, d, h, finishes }: BuilderProps) {
  return (
    <group>
      {/* outer shell - rounded look from stacked boxes + cylinders at ends */}
      <Box s={[w * 0.62, h, d]} p={[0, h / 2, 0]} m={ceramicMat()} />
      <Cyl rTop={d / 2} rBot={d / 2} h={h} p={[-w * 0.31, h / 2, 0]} m={ceramicMat()} seg={24} />
      <Cyl rTop={d / 2} rBot={d / 2} h={h} p={[w * 0.31, h / 2, 0]} m={ceramicMat()} seg={24} />
      {/* interior */}
      <Box s={[w * 0.6, IN(2), d * 0.66]} p={[0, h - IN(1), 0]} m={fixedMat("tub-int", () => new THREE.MeshStandardMaterial({ color: "#e8e9e4", roughness: 0.2 }))} castShadow={false} />
      {/* floor-mount faucet */}
      <group position={[w * 0.42, 0, -d * 0.28]}>
        <Cyl rTop={IN(0.5)} rBot={IN(0.6)} h={h + IN(10)} p={[0, (h + IN(10)) / 2, 0]} m={mat(finishes.faucet, "metal-matte-black")} seg={10} />
        <Cyl rTop={IN(0.4)} rBot={IN(0.4)} h={IN(7)} p={[0, h + IN(9), IN(3)]} rot={[Math.PI / 2, 0, 0]} m={mat(finishes.faucet, "metal-matte-black")} seg={8} />
      </group>
    </group>
  );
}

export function TubAlcove({ w, d, h, finishes }: BuilderProps) {
  return (
    <group>
      <Box s={[w, h, d]} p={[0, h / 2, 0]} m={ceramicMat()} />
      <Box s={[w - IN(5), IN(2), d - IN(5)]} p={[0, h - IN(1), 0]} m={fixedMat("tub-int", () => new THREE.MeshStandardMaterial({ color: "#e8e9e4", roughness: 0.2 }))} castShadow={false} />
      {/* wall-end faucet */}
      <Cyl rTop={IN(0.4)} rBot={IN(0.4)} h={IN(6)} p={[-w / 2 + IN(6), h + IN(4), -d / 2 + IN(2)]} rot={[Math.PI / 2.5, 0, 0]} m={mat(finishes.faucet, "metal-chrome")} seg={8} />
    </group>
  );
}

export function Shower({ w, d, h, finishes }: BuilderProps) {
  const frame = mat(finishes.metal, "metal-matte-black");
  return (
    <group>
      {/* tiled back + side walls */}
      <Box s={[w, h, IN(1)]} p={[0, h / 2, -d / 2 + IN(0.5)]} m={mat(finishes.tile, "tile-white-subway")} />
      <Box s={[IN(1), h, d]} p={[-w / 2 + IN(0.5), h / 2, 0]} m={mat(finishes.tile, "tile-white-subway")} />
      {/* base pan */}
      <Box s={[w, IN(3), d]} p={[0, IN(1.5), 0]} m={ceramicMat()} />
      {/* glass front + side */}
      <Box s={[w * 0.6, h - IN(4), IN(0.3)]} p={[-w * 0.18, (h - IN(4)) / 2 + IN(3), d / 2]} m={glassMat()} castShadow={false} />
      <Box s={[IN(0.3), h - IN(4), d - IN(1)]} p={[w / 2, (h - IN(4)) / 2 + IN(3), 0]} m={glassMat()} castShadow={false} />
      {/* frame rails */}
      <Box s={[w, IN(1), IN(1)]} p={[0, h - IN(1), d / 2]} m={frame} castShadow={false} />
      {/* shower head + valve */}
      <Cyl rTop={IN(4)} rBot={IN(4)} h={IN(0.5)} p={[0, h - IN(8), -d / 2 + IN(6)]} m={frame} seg={18} castShadow={false} />
      <Cyl rTop={IN(0.4)} rBot={IN(0.4)} h={IN(5)} p={[0, h - IN(6), -d / 2 + IN(3)]} rot={[Math.PI / 3, 0, 0]} m={frame} seg={8} castShadow={false} />
      <Cyl rTop={IN(1.6)} rBot={IN(1.6)} h={IN(0.8)} rot={[Math.PI / 2, 0, 0]} p={[0, h * 0.45, -d / 2 + IN(1.2)]} m={frame} seg={14} castShadow={false} />
    </group>
  );
}

export function PedestalSink({ w, d, h, finishes }: BuilderProps) {
  return (
    <group>
      <Cyl rTop={IN(3.2)} rBot={IN(4.5)} h={h - IN(6)} p={[0, (h - IN(6)) / 2, 0]} m={ceramicMat()} seg={16} />
      <Box s={[w, IN(5), d]} p={[0, h - IN(2.5), 0]} m={ceramicMat()} />
      <Box s={[w - IN(4), IN(1.5), d - IN(5)]} p={[0, h - IN(0.8), IN(0.6)]} m={fixedMat("basin-int", () => new THREE.MeshStandardMaterial({ color: "#dfe0db", roughness: 0.3 }))} castShadow={false} />
      <Cyl rTop={IN(0.4)} rBot={IN(0.5)} h={IN(5)} p={[0, h + IN(2), -d / 2 + IN(3)]} m={mat(finishes.faucet, "metal-chrome")} seg={10} />
    </group>
  );
}

/**
 * Recessed shower niche. The item centers ON the wall face (cutsWall carves a
 * real hole in the host wall); this builder lines that hole: tiled liner box
 * sunk into the wall (local -Z), a flush trim ring on the room face, a glass
 * shelf, and an optional LED strip under the head tile.
 */
export function ShowerNiche({ w, d, h, finishes, lightsOn, led }: BuilderProps) {
  const tile = mat(finishes.tile, "tile-white-subway");
  const trim = mat(finishes.trim, "metal-brushed-nickel");
  const FW = IN(0.8); // trim frame strip width
  return (
    <group>
      {/* trim ring, just proud of the wall face - covers the hole rim */}
      <Box s={[w + 2 * FW, FW, IN(0.5)]} p={[0, h + FW / 2, IN(0.25)]} m={trim} castShadow={false} />
      <Box s={[w + 2 * FW, FW, IN(0.5)]} p={[0, -FW / 2, IN(0.25)]} m={trim} castShadow={false} />
      <Box s={[FW, h, IN(0.5)]} p={[-(w / 2 + FW / 2), h / 2, IN(0.25)]} m={trim} castShadow={false} />
      <Box s={[FW, h, IN(0.5)]} p={[w / 2 + FW / 2, h / 2, IN(0.25)]} m={trim} castShadow={false} />
      {/* tiled liner filling the wall cutout (slightly oversize to seal the hole edges) */}
      <Box s={[w + IN(0.4), h + IN(0.4), IN(0.4)]} p={[0, h / 2, -d + IN(0.2)]} m={matShade(finishes.tile, 0.12, "tile-white-subway")} castShadow={false} />
      <Box s={[w + IN(0.4), IN(0.6), d]} p={[0, h + IN(0.05), -d / 2]} m={tile} castShadow={false} />
      <Box s={[w + IN(0.4), IN(0.6), d]} p={[0, -IN(0.05), -d / 2]} m={tile} castShadow={false} />
      <Box s={[IN(0.6), h + IN(0.4), d]} p={[-(w / 2 + IN(0.05)), h / 2, -d / 2]} m={tile} castShadow={false} />
      <Box s={[IN(0.6), h + IN(0.4), d]} p={[w / 2 + IN(0.05), h / 2, -d / 2]} m={tile} castShadow={false} />
      {/* glass center shelf */}
      <Box s={[w - IN(0.5), IN(0.3), d - IN(0.8)]} p={[0, h / 2, -d / 2]} m={glassMat()} castShadow={false} />
      {/* optional LED strip under the head tile */}
      {led && (
        <Box s={[w - IN(1.5), IN(0.2), IN(0.35)]} p={[0, h - IN(0.35), -IN(0.6)]} m={bulbMat(!!lightsOn)} castShadow={false} />
      )}
      {led && lightsOn && (
        <pointLight position={[0, h - IN(3), -d / 2 + IN(1)]} intensity={0.3} distance={1.3} decay={2} color="#ffe2b0" />
      )}
    </group>
  );
}

/**
 * Pony / knee wall - a freestanding half-height wall stub with a cap. Place
 * against walls or in the open to split spaces (tub surrounds, stair edges,
 * room dividers).
 */
export function PonyWall({ w, d, h, finishes }: BuilderProps) {
  return (
    <group>
      <Box s={[w, h - IN(1.2), d]} p={[0, (h - IN(1.2)) / 2, 0]} m={mat(finishes.paint, "paint-soft-chalk")} />
      {/* cap with a slight overhang */}
      <Box s={[w + IN(1.5), IN(1.2), d + IN(1.5)]} p={[0, h - IN(0.6), 0]} m={mat(finishes.cap, "wood-oak")} />
      {/* baseboard wrap */}
      <Box s={[w + IN(0.6), IN(4.5), d + IN(0.6)]} p={[0, IN(2.25), 0]} m={fixedMat("pony-base", () => new THREE.MeshStandardMaterial({ color: "#eceae3", roughness: 0.7 }))} castShadow={false} />
    </group>
  );
}

/**
 * Full-height interior partition wall. The wrapper stretches `h` to the
 * ceiling at the item's position (fullHeight catalog flag), so it always
 * meets the ceiling - flat or sloped. Painted both sides, baseboards both sides.
 */
export function InteriorWall({ w, d, h, finishes }: BuilderProps) {
  const paint = mat(finishes.paint, "paint-soft-chalk");
  const base = fixedMat("pony-base", () => new THREE.MeshStandardMaterial({ color: "#eceae3", roughness: 0.7 }));
  return (
    <group>
      <Box s={[w, h, d]} p={[0, h / 2, 0]} m={paint} />
      <Box s={[w, IN(4.5), IN(0.9)]} p={[0, IN(2.25), d / 2 + IN(0.4)]} m={base} castShadow={false} />
      <Box s={[w, IN(4.5), IN(0.9)]} p={[0, IN(2.25), -d / 2 - IN(0.4)]} m={base} castShadow={false} />
    </group>
  );
}

/** Interior wall with a centered cased doorway opening (36" x 80"). */
export function InteriorWallDoorway({ w, d, h, finishes }: BuilderProps) {
  const paint = mat(finishes.paint, "paint-soft-chalk");
  const base = fixedMat("pony-base", () => new THREE.MeshStandardMaterial({ color: "#eceae3", roughness: 0.7 }));
  const trim = fixedMat("trim-white2", () => new THREE.MeshStandardMaterial({ color: "#f2f0ea", roughness: 0.7 }));
  const openW = Math.min(IN(36), w * 0.45);
  const openH = Math.min(IN(80), h - IN(8));
  const sideW = (w - openW) / 2;
  return (
    <group>
      {/* side panels */}
      <Box s={[sideW, h, d]} p={[-(openW + sideW) / 2, h / 2, 0]} m={paint} />
      <Box s={[sideW, h, d]} p={[(openW + sideW) / 2, h / 2, 0]} m={paint} />
      {/* header above the opening */}
      <Box s={[openW, h - openH, d]} p={[0, openH + (h - openH) / 2, 0]} m={paint} />
      {/* casing */}
      <Box s={[openW + IN(4), IN(3), d + IN(1.2)]} p={[0, openH + IN(1.5), 0]} m={trim} castShadow={false} />
      <Box s={[IN(2), openH, d + IN(1.2)]} p={[-openW / 2 - IN(1), openH / 2, 0]} m={trim} castShadow={false} />
      <Box s={[IN(2), openH, d + IN(1.2)]} p={[openW / 2 + IN(1), openH / 2, 0]} m={trim} castShadow={false} />
      {/* baseboards on the side panels, both faces */}
      {[-1, 1].map((side) => (
        <group key={side}>
          <Box s={[sideW, IN(4.5), IN(0.9)]} p={[-(openW + sideW) / 2, IN(2.25), side * (d / 2 + IN(0.4))]} m={base} castShadow={false} />
          <Box s={[sideW, IN(4.5), IN(0.9)]} p={[(openW + sideW) / 2, IN(2.25), side * (d / 2 + IN(0.4))]} m={base} castShadow={false} />
        </group>
      ))}
    </group>
  );
}

export function Fireplace({ w, d, h, finishes, lightsOn }: BuilderProps) {
  const boxW = w * 0.55;
  const boxH = h * 0.5;
  return (
    <group>
      {/* surround */}
      <Box s={[w, h, d]} p={[0, h / 2, 0]} m={mat(finishes.surround, "tile-marble-herringbone")} />
      {/* firebox */}
      <Box s={[boxW, boxH, IN(2)]} p={[0, boxH / 2 + IN(6), d / 2 - IN(0.5)]} m={fixedMat("firebox", () => new THREE.MeshStandardMaterial({ color: "#17120e", roughness: 1 }))} castShadow={false} />
      {lightsOn && (
        <>
          <Box s={[boxW * 0.7, boxH * 0.35, IN(1)]} p={[0, boxH * 0.3 + IN(6), d / 2 + IN(0.2)]} m={flameMat()} castShadow={false} />
          <pointLight position={[0, boxH * 0.4 + IN(6), d / 2 + IN(6)]} intensity={0.7} distance={3} color="#ff9a3c" decay={2} />
        </>
      )}
      {/* mantel */}
      <Box s={[w + IN(4), IN(2.5), d + IN(4)]} p={[0, h - IN(1.25), 0]} m={mat(finishes.mantel, "wood-oak")} />
    </group>
  );
}
