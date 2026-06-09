"use client";

// Room Studio - procedural builders: lighting, doors/windows, furniture, decor.
// Same local-space contract as builders-kitchen.

import * as THREE from "three";
import { inches } from "@/lib/studio/units";
import {
  Box, Cyl, Ball, mat, matShade, glassMat, mirrorMat, bulbMat, fixedMat,
  screenMat, soilMat, leafMat, leafMat2, BarPull,
} from "./parts";
import type { BuilderProps } from "./builders";

const IN = inches;

// -------------------------------- Lighting --------------------------------
// Ceiling lights hang DOWN from local y=h (their mount point); the wrapper
// positions the group so y=0 is the item's bottom. We draw from the top down.

export function Recessed({ w, h, lightsOn }: BuilderProps) {
  return (
    <group>
      <Cyl rTop={w / 2} rBot={w / 2} h={IN(0.6)} p={[0, h - IN(0.3), 0]} m={fixedMat("trim-white", () => new THREE.MeshStandardMaterial({ color: "#f5f5f2", roughness: 0.6 }))} seg={20} castShadow={false} />
      <Cyl rTop={w / 2 - IN(0.8)} rBot={w / 2 - IN(0.8)} h={IN(0.3)} p={[0, h - IN(0.6), 0]} m={bulbMat(!!lightsOn)} seg={18} castShadow={false} />
    </group>
  );
}

export function Pendant({ w, h, finishes, lightsOn }: BuilderProps) {
  const metal = mat(finishes.metal, "metal-matte-black");
  const shadeR = w / 2;
  return (
    <group>
      <Cyl rTop={IN(0.15)} rBot={IN(0.15)} h={h * 0.45} p={[0, h - h * 0.225, 0]} m={metal} seg={8} castShadow={false} />
      {/* dome shade */}
      <Cyl rTop={shadeR * 0.35} rBot={shadeR} h={h * 0.3} p={[0, h * 0.42, 0]} m={metal} seg={22} />
      <Ball r={IN(1.6)} p={[0, h * 0.32, 0]} m={bulbMat(!!lightsOn)} seg={12} />
    </group>
  );
}

export function PendantGlass({ w, h, finishes, lightsOn }: BuilderProps) {
  const metal = mat(finishes.metal, "metal-brass");
  return (
    <group>
      <Cyl rTop={IN(0.12)} rBot={IN(0.12)} h={h * 0.4} p={[0, h - h * 0.2, 0]} m={metal} seg={8} castShadow={false} />
      <Ball r={w / 2} p={[0, h * 0.35, 0]} m={glassMat()} seg={20} />
      <Ball r={IN(1.4)} p={[0, h * 0.35, 0]} m={bulbMat(!!lightsOn)} seg={12} />
    </group>
  );
}

export function PendantTrio(props: BuilderProps) {
  const { w } = props;
  const spacing = w / 3;
  const single = { ...props, w: IN(9) };
  return (
    <group>
      {[-spacing, 0, spacing].map((x, i) => (
        <group key={i} position={[x, 0, 0]}>
          <Pendant {...single} />
        </group>
      ))}
    </group>
  );
}

export function Chandelier({ w, h, finishes, lightsOn }: BuilderProps) {
  const metal = mat(finishes.metal, "metal-brass");
  const arms = 6;
  return (
    <group>
      <Cyl rTop={IN(0.15)} rBot={IN(0.15)} h={h * 0.35} p={[0, h - h * 0.175, 0]} m={metal} seg={8} castShadow={false} />
      <Ball r={IN(2)} p={[0, h * 0.6, 0]} m={metal} seg={14} />
      {Array.from({ length: arms }, (_, i) => {
        const a = (i / arms) * Math.PI * 2;
        const r = w / 2 - IN(2);
        return (
          <group key={i}>
            <Cyl rTop={IN(0.12)} rBot={IN(0.12)} h={r} p={[Math.cos(a) * r * 0.5, h * 0.52, Math.sin(a) * r * 0.5]} rot={[Math.PI / 2, 0, -a]} m={metal} seg={6} castShadow={false} />
            <Cyl rTop={IN(0.5)} rBot={IN(0.7)} h={IN(2)} p={[Math.cos(a) * r, h * 0.55, Math.sin(a) * r]} m={metal} seg={10} castShadow={false} />
            <Ball r={IN(1)} p={[Math.cos(a) * r, h * 0.62, Math.sin(a) * r]} m={bulbMat(!!lightsOn)} seg={10} />
          </group>
        );
      })}
    </group>
  );
}

export function FlushMount({ w, h, finishes, lightsOn }: BuilderProps) {
  return (
    <group>
      <Cyl rTop={w / 2} rBot={w / 2} h={IN(1)} p={[0, h - IN(0.5), 0]} m={mat(finishes.metal, "metal-brushed-nickel")} seg={22} castShadow={false} />
      <Ball r={w / 2 - IN(1)} p={[0, h - IN(1), 0]} m={bulbMat(!!lightsOn)} seg={18} half />
    </group>
  );
}

export function Sconce({ w, d, h, finishes, lightsOn }: BuilderProps) {
  const metal = mat(finishes.metal, "metal-matte-black");
  return (
    <group>
      {/* backplate against wall (-Z side) */}
      <Box s={[w * 0.5, h * 0.6, IN(0.6)]} p={[0, h / 2, -d / 2 + IN(0.3)]} m={metal} castShadow={false} />
      <Cyl rTop={IN(0.25)} rBot={IN(0.25)} h={d * 0.5} p={[0, h * 0.62, -d * 0.2]} rot={[Math.PI / 2, 0, 0]} m={metal} seg={8} castShadow={false} />
      <Cyl rTop={IN(1.8)} rBot={IN(2.4)} h={h * 0.35} p={[0, h * 0.55, d * 0.12]} m={metal} seg={16} open />
      <Ball r={IN(1.1)} p={[0, h * 0.52, d * 0.12]} m={bulbMat(!!lightsOn)} seg={10} />
    </group>
  );
}

export function FloorLamp({ w, h, finishes, lightsOn }: BuilderProps) {
  const metal = mat(finishes.metal, "metal-brass");
  return (
    <group>
      <Cyl rTop={w * 0.28} rBot={w * 0.32} h={IN(1)} p={[0, IN(0.5), 0]} m={metal} seg={18} />
      <Cyl rTop={IN(0.3)} rBot={IN(0.3)} h={h - IN(14)} p={[0, (h - IN(14)) / 2 + IN(1), 0]} m={metal} seg={10} castShadow={false} />
      <Cyl rTop={w * 0.42} rBot={w * 0.5} h={IN(11)} p={[0, h - IN(6.5), 0]} m={mat(finishes.shade, "fab-oat")} seg={20} open />
      <Ball r={IN(1.5)} p={[0, h - IN(8), 0]} m={bulbMat(!!lightsOn)} seg={10} />
    </group>
  );
}

export function TableLamp({ w, h, finishes, lightsOn }: BuilderProps) {
  const metal = mat(finishes.metal, "metal-brass");
  return (
    <group>
      <Cyl rTop={w * 0.16} rBot={w * 0.3} h={h * 0.5} p={[0, h * 0.25, 0]} m={metal} seg={14} />
      <Cyl rTop={w * 0.4} rBot={w * 0.48} h={h * 0.4} p={[0, h * 0.74, 0]} m={mat(finishes.shade, "fab-oat")} seg={18} open />
      <Ball r={IN(1.2)} p={[0, h * 0.68, 0]} m={bulbMat(!!lightsOn)} seg={10} />
    </group>
  );
}

export function Track({ w, d, h, finishes, lightsOn }: BuilderProps) {
  const metal = mat(finishes.metal, "metal-matte-black");
  const heads = Math.max(3, Math.round(w / IN(16)));
  return (
    <group>
      <Box s={[w, IN(0.8), IN(1.2)]} p={[0, h - IN(0.4), 0]} m={metal} castShadow={false} />
      {Array.from({ length: heads }, (_, i) => {
        const x = -w / 2 + (w / (heads + 1)) * (i + 1);
        const tilt = (i % 2 === 0 ? 1 : -1) * 0.4;
        return (
          <group key={i} position={[x, h - IN(2.5), 0]} rotation={[tilt, 0, 0]}>
            <Cyl rTop={IN(1.4)} rBot={IN(1.6)} h={IN(4)} p={[0, -IN(1), 0]} m={metal} seg={12} />
            <Ball r={IN(1)} p={[0, -IN(3), 0]} m={bulbMat(!!lightsOn)} seg={10} />
          </group>
        );
      })}
    </group>
  );
}

// ----------------------------- Doors & Windows -----------------------------
// These sit IN a wall: the wrapper centers them on the wall plane. Local -Z =
// outside. The wall renderer cuts a hole behind them.

export function Door({ w, d, h, finishes }: BuilderProps) {
  const slab = mat(finishes.door, "paint-pure-white");
  return (
    <group>
      {/* jamb */}
      <Box s={[w + IN(3), IN(2), IN(5)]} p={[0, h + IN(1), 0]} m={slab} castShadow={false} />
      <Box s={[IN(1.5), h, IN(5)]} p={[-w / 2 - IN(0.75), h / 2, 0]} m={slab} castShadow={false} />
      <Box s={[IN(1.5), h, IN(5)]} p={[w / 2 + IN(0.75), h / 2, 0]} m={slab} castShadow={false} />
      {/* slab with 2-panel relief */}
      <Box s={[w, h, IN(1.4)]} p={[0, h / 2, 0]} m={slab} />
      <Box s={[w - IN(7), h * 0.42, IN(0.4)]} p={[0, h * 0.7, IN(0.6)]} m={matShade(finishes.door, 0.1, "paint-pure-white")} castShadow={false} />
      <Box s={[w - IN(7), h * 0.36, IN(0.4)]} p={[0, h * 0.26, IN(0.6)]} m={matShade(finishes.door, 0.1, "paint-pure-white")} castShadow={false} />
      {/* lever */}
      <Cyl rTop={IN(1)} rBot={IN(1)} h={IN(0.6)} rot={[Math.PI / 2, 0, 0]} p={[w / 2 - IN(3), IN(36), IN(1)]} m={mat(finishes.hardware, "metal-matte-black")} seg={12} castShadow={false} />
      <Box s={[IN(4), IN(0.7), IN(0.7)]} p={[w / 2 - IN(4.5), IN(36), IN(1.4)]} m={mat(finishes.hardware, "metal-matte-black")} castShadow={false} />
    </group>
  );
}

export function DoorDouble(props: BuilderProps) {
  const { w, h, finishes } = props;
  const slab = mat(finishes.door, "paint-pure-white");
  const leaf = w / 2 - IN(0.5);
  return (
    <group>
      <Box s={[w + IN(3), IN(2), IN(5)]} p={[0, h + IN(1), 0]} m={slab} castShadow={false} />
      {[-1, 1].map((sgn) => (
        <group key={sgn} position={[sgn * (leaf / 2 + IN(0.25)), 0, 0]}>
          <Box s={[leaf, h, IN(1.4)]} p={[0, h / 2, 0]} m={slab} />
          <Box s={[leaf - IN(6), h * 0.8, IN(0.4)]} p={[0, h * 0.5, IN(0.6)]} m={matShade(finishes.door, 0.1, "paint-pure-white")} castShadow={false} />
          <Cyl rTop={IN(0.9)} rBot={IN(0.9)} h={IN(0.6)} rot={[Math.PI / 2, 0, 0]} p={[sgn * -1 * (leaf / 2 - IN(3)), IN(36), IN(1)]} m={mat(finishes.hardware, "metal-matte-black")} seg={12} castShadow={false} />
        </group>
      ))}
    </group>
  );
}

export function DoorSliding({ w, h, finishes }: BuilderProps) {
  const frame = mat(finishes.frame, "metal-matte-black");
  const leafW = w / 2;
  const rail = IN(2);
  return (
    <group>
      <Box s={[w, IN(2.5), IN(3)]} p={[0, h - IN(1.25), 0]} m={frame} />
      <Box s={[w, IN(2), IN(3)]} p={[0, IN(1), 0]} m={frame} />
      {[-1, 1].map((sgn) => (
        <group key={sgn} position={[(sgn * w) / 4, 0, sgn * IN(0.7)]}>
          {/* slim leaf frame: two stiles + two rails around a big glass pane */}
          <Box s={[rail, h - IN(3), IN(1)]} p={[-leafW / 2 + rail / 2, h / 2, 0]} m={frame} castShadow={false} />
          <Box s={[rail, h - IN(3), IN(1)]} p={[leafW / 2 - rail / 2, h / 2, 0]} m={frame} castShadow={false} />
          <Box s={[leafW, rail, IN(1)]} p={[0, h - IN(3), 0]} m={frame} castShadow={false} />
          <Box s={[leafW, rail, IN(1)]} p={[0, IN(3), 0]} m={frame} castShadow={false} />
          <Box s={[leafW - rail * 1.6, h - IN(7), IN(0.3)]} p={[0, h / 2, 0]} m={glassMat()} castShadow={false} />
        </group>
      ))}
    </group>
  );
}

export function Doorway({ w, h }: BuilderProps) {
  const trim = fixedMat("trim-white2", () => new THREE.MeshStandardMaterial({ color: "#f2f0ea", roughness: 0.7 }));
  return (
    <group>
      <Box s={[w + IN(4), IN(3), IN(5.5)]} p={[0, h + IN(1.5), 0]} m={trim} castShadow={false} />
      <Box s={[IN(2), h, IN(5.5)]} p={[-w / 2 - IN(1), h / 2, 0]} m={trim} castShadow={false} />
      <Box s={[IN(2), h, IN(5.5)]} p={[w / 2 + IN(1), h / 2, 0]} m={trim} castShadow={false} />
    </group>
  );
}

export function Window({ w, d, h, finishes }: BuilderProps) {
  const frame = mat(finishes.frame, "paint-pure-white");
  return (
    <group>
      {/* outer frame */}
      <Box s={[w, IN(2), IN(4)]} p={[0, h - IN(1), 0]} m={frame} castShadow={false} />
      <Box s={[w, IN(2), IN(4)]} p={[0, IN(1), 0]} m={frame} castShadow={false} />
      <Box s={[IN(2), h, IN(4)]} p={[-w / 2 + IN(1), h / 2, 0]} m={frame} castShadow={false} />
      <Box s={[IN(2), h, IN(4)]} p={[w / 2 - IN(1), h / 2, 0]} m={frame} castShadow={false} />
      {/* center rail + glass */}
      <Box s={[w - IN(3), IN(1.2), IN(1.2)]} p={[0, h / 2, 0]} m={frame} castShadow={false} />
      <Box s={[w - IN(3.5), h - IN(3.5), IN(0.3)]} p={[0, h / 2, 0]} m={glassMat()} castShadow={false} />
      {/* sill */}
      <Box s={[w + IN(3), IN(1.2), IN(5.5)]} p={[0, IN(0.2), IN(1)]} m={frame} castShadow={false} />
    </group>
  );
}

export function WindowDouble(props: BuilderProps) {
  const { w } = props;
  const single = { ...props, w: w / 2 - IN(0.5) };
  return (
    <group>
      <group position={[-w / 4, 0, 0]}>
        <Window {...single} />
      </group>
      <group position={[w / 4, 0, 0]}>
        <Window {...single} />
      </group>
    </group>
  );
}

export function WindowPicture({ w, h, finishes }: BuilderProps) {
  const frame = mat(finishes.frame, "paint-tricorn-black");
  return (
    <group>
      <Box s={[w, IN(2.5), IN(4)]} p={[0, h - IN(1.25), 0]} m={frame} castShadow={false} />
      <Box s={[w, IN(2.5), IN(4)]} p={[0, IN(1.25), 0]} m={frame} castShadow={false} />
      <Box s={[IN(2.5), h, IN(4)]} p={[-w / 2 + IN(1.25), h / 2, 0]} m={frame} castShadow={false} />
      <Box s={[IN(2.5), h, IN(4)]} p={[w / 2 - IN(1.25), h / 2, 0]} m={frame} castShadow={false} />
      <Box s={[w - IN(4), h - IN(4), IN(0.3)]} p={[0, h / 2, 0]} m={glassMat()} castShadow={false} />
    </group>
  );
}

// -------------------------------- Furniture --------------------------------

export function Sofa({ w, d, h, finishes }: BuilderProps) {
  const fab = mat(finishes.fabric, "fab-oat");
  const fabD = matShade(finishes.fabric, 0.08, "fab-oat");
  const legM = mat(finishes.legs, "wood-walnut");
  const seatH = h * 0.42;
  const armW = IN(7);
  const seats = Math.max(2, Math.round((w - armW * 2) / IN(26)));
  const cushW = (w - armW * 2) / seats;
  return (
    <group>
      {/* legs */}
      {[[-w / 2 + IN(3), -d / 2 + IN(3)], [w / 2 - IN(3), -d / 2 + IN(3)], [-w / 2 + IN(3), d / 2 - IN(3)], [w / 2 - IN(3), d / 2 - IN(3)]].map(([x, z], i) => (
        <Cyl key={i} rTop={IN(0.8)} rBot={IN(1.1)} h={IN(5)} p={[x, IN(2.5), z]} m={legM} seg={10} />
      ))}
      {/* base + back */}
      <Box s={[w, seatH - IN(5), d]} p={[0, IN(5) + (seatH - IN(5)) / 2, 0]} m={fab} />
      <Box s={[w, h - seatH, IN(9)]} p={[0, seatH + (h - seatH) / 2, -d / 2 + IN(4.5)]} m={fab} />
      {/* arms */}
      <Box s={[armW, h * 0.78 - IN(5), d]} p={[-w / 2 + armW / 2, IN(5) + (h * 0.78 - IN(5)) / 2, 0]} m={fab} />
      <Box s={[armW, h * 0.78 - IN(5), d]} p={[w / 2 - armW / 2, IN(5) + (h * 0.78 - IN(5)) / 2, 0]} m={fab} />
      {/* seat + back cushions */}
      {Array.from({ length: seats }, (_, i) => {
        const x = -w / 2 + armW + cushW * (i + 0.5);
        return (
          <group key={i}>
            <Box s={[cushW - IN(1), IN(5), d - armW - IN(8)]} p={[x, seatH + IN(0.5), IN(2)]} m={fabD} />
            <Box s={[cushW - IN(1.5), h - seatH - IN(2), IN(5)]} p={[x, seatH + (h - seatH) / 2 + IN(1), -d / 2 + IN(10)]} m={fabD} />
          </group>
        );
      })}
    </group>
  );
}

export function Sectional(props: BuilderProps) {
  const { w, d } = props;
  const mainD = IN(38);
  const chaiseW = IN(36);
  return (
    <group>
      {/* main run along back */}
      <group position={[0, 0, -d / 2 + mainD / 2]}>
        <Sofa {...props} d={mainD} />
      </group>
      {/* chaise return on the right */}
      <group position={[w / 2 - chaiseW / 2, 0, mainD / 2 - IN(4)]} rotation={[0, Math.PI / 2, 0]}>
        <Sofa {...props} w={d - mainD + IN(8)} d={chaiseW} />
      </group>
    </group>
  );
}

export function Armchair(props: BuilderProps) {
  return <Sofa {...props} />;
}

export function CoffeeTable({ w, d, h, finishes }: BuilderProps) {
  const wood = mat(finishes.wood, "wood-oak");
  return (
    <group>
      <Box s={[w, IN(1.5), d]} p={[0, h - IN(0.75), 0]} m={wood} />
      <Box s={[w * 0.85, IN(1), d * 0.8]} p={[0, h * 0.45, 0]} m={matShade(finishes.wood, 0.08, "wood-oak")} castShadow={false} />
      {[[-w / 2 + IN(2), -d / 2 + IN(2)], [w / 2 - IN(2), -d / 2 + IN(2)], [-w / 2 + IN(2), d / 2 - IN(2)], [w / 2 - IN(2), d / 2 - IN(2)]].map(([x, z], i) => (
        <Box key={i} s={[IN(1.4), h, IN(1.4)]} p={[x, h / 2, z]} m={wood} />
      ))}
    </group>
  );
}

export function SideTable({ w, d, h, finishes }: BuilderProps) {
  const wood = mat(finishes.wood, "wood-walnut");
  return (
    <group>
      <Cyl rTop={w / 2} rBot={w / 2} h={IN(1.2)} p={[0, h - IN(0.6), 0]} m={wood} seg={22} />
      <Cyl rTop={IN(1)} rBot={IN(1.4)} h={h - IN(1.2)} p={[0, (h - IN(1.2)) / 2, 0]} m={wood} seg={12} />
      <Cyl rTop={w / 2 - IN(2)} rBot={w / 2 - IN(2)} h={IN(0.8)} p={[0, IN(0.4), 0]} m={wood} seg={22} />
    </group>
  );
}

export function TvConsole({ w, d, h, finishes }: BuilderProps) {
  const wood = mat(finishes.wood, "wood-walnut");
  const tvW = Math.min(w * 0.82, IN(58));
  const tvH = tvW * 0.56;
  return (
    <group>
      <Box s={[w, h - IN(4), d]} p={[0, IN(4) + (h - IN(4)) / 2, 0]} m={wood} />
      {/* door fronts */}
      {[-1, 1].map((sgn) => (
        <Box key={sgn} s={[w / 2 - IN(2), h - IN(7), IN(0.6)]} p={[sgn * w / 4, IN(4) + (h - IN(4)) / 2, d / 2]} m={matShade(finishes.wood, 0.12, "wood-walnut")} castShadow={false} />
      ))}
      {[[-w / 2 + IN(3), -d / 2 + IN(3)], [w / 2 - IN(3), -d / 2 + IN(3)], [-w / 2 + IN(3), d / 2 - IN(3)], [w / 2 - IN(3), d / 2 - IN(3)]].map(([x, z], i) => (
        <Cyl key={i} rTop={IN(0.7)} rBot={IN(0.9)} h={IN(4)} p={[x, IN(2), z]} m={mat("metal-matte-black", "metal-matte-black")} seg={8} />
      ))}
      {/* TV on top */}
      <Box s={[tvW, tvH, IN(1.2)]} p={[0, h + tvH / 2 + IN(4), -d * 0.15]} m={screenMat()} />
      <Box s={[IN(14), IN(1), IN(8)]} p={[0, h + IN(0.5), -d * 0.15]} m={mat("metal-matte-black", "metal-matte-black")} castShadow={false} />
      <Box s={[IN(2.5), IN(3.5), IN(2)]} p={[0, h + IN(2.2), -d * 0.15]} m={mat("metal-matte-black", "metal-matte-black")} castShadow={false} />
    </group>
  );
}

export function DiningTable({ w, d, h, finishes }: BuilderProps) {
  const wood = mat(finishes.wood, "wood-oak");
  return (
    <group>
      <Box s={[w, IN(1.6), d]} p={[0, h - IN(0.8), 0]} m={wood} />
      {[[-w / 2 + IN(4), -d / 2 + IN(4)], [w / 2 - IN(4), -d / 2 + IN(4)], [-w / 2 + IN(4), d / 2 - IN(4)], [w / 2 - IN(4), d / 2 - IN(4)]].map(([x, z], i) => (
        <Box key={i} s={[IN(2.5), h - IN(1.6), IN(2.5)]} p={[x, (h - IN(1.6)) / 2, z]} m={wood} />
      ))}
    </group>
  );
}

export function DiningChair({ w, d, h, finishes }: BuilderProps) {
  const wood = mat(finishes.wood, "wood-oak");
  const seatH = IN(18);
  return (
    <group>
      <Box s={[w, IN(1.8), d * 0.9]} p={[0, seatH, IN(0.5)]} m={mat(finishes.fabric, "fab-oat")} />
      <Box s={[w - IN(1), h - seatH - IN(2), IN(1.4)]} p={[0, seatH + (h - seatH) / 2 + IN(1), -d / 2 + IN(1.5)]} m={wood} />
      {[[-w / 2 + IN(1), -d / 2 + IN(1.2)], [w / 2 - IN(1), -d / 2 + IN(1.2)], [-w / 2 + IN(1), d / 2 - IN(1.2)], [w / 2 - IN(1), d / 2 - IN(1.2)]].map(([x, z], i) => (
        <Box key={i} s={[IN(1.3), seatH, IN(1.3)]} p={[x, seatH / 2, z]} m={wood} />
      ))}
    </group>
  );
}

export function Stool({ w, d, h, finishes }: BuilderProps) {
  const wood = mat(finishes.wood, "wood-black");
  return (
    <group>
      <Cyl rTop={w / 2} rBot={w / 2} h={IN(2.5)} p={[0, h - IN(1.25), 0]} m={mat(finishes.fabric, "fab-cognac")} seg={18} />
      {Array.from({ length: 4 }, (_, i) => {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const r = w / 2 - IN(1.5);
        return <Cyl key={i} rTop={IN(0.7)} rBot={IN(0.9)} h={h - IN(2.5)} p={[Math.cos(a) * r * 0.8, (h - IN(2.5)) / 2, Math.sin(a) * r * 0.8]} m={wood} seg={8} />;
      })}
      <Cyl rTop={w / 2 - IN(2)} rBot={w / 2 - IN(2)} h={IN(0.6)} p={[0, h * 0.35, 0]} m={wood} seg={14} castShadow={false} />
    </group>
  );
}

export function Bookshelf({ w, d, h, finishes }: BuilderProps) {
  const wood = mat(finishes.wood, "wood-oak");
  const shelves = 5;
  const bookColors = ["#7d5a44", "#46586b", "#6e7155", "#8a4f42", "#5b4a63", "#a08a5f"];
  return (
    <group>
      <Box s={[w, h, IN(0.8)]} p={[0, h / 2, -d / 2 + IN(0.4)]} m={matShade(finishes.wood, 0.15, "wood-oak")} />
      <Box s={[IN(1), h, d]} p={[-w / 2 + IN(0.5), h / 2, 0]} m={wood} />
      <Box s={[IN(1), h, d]} p={[w / 2 - IN(0.5), h / 2, 0]} m={wood} />
      {Array.from({ length: shelves + 1 }, (_, i) => (
        <Box key={i} s={[w, IN(1), d]} p={[0, (h / shelves) * i + IN(0.5) * (i === 0 ? 1 : i === shelves ? -1 : 0), 0]} m={wood} />
      ))}
      {/* books: a few color runs per shelf */}
      {Array.from({ length: shelves }, (_, s) =>
        Array.from({ length: 3 }, (_, b) => {
          const bw = w * (0.16 + ((s * 3 + b) % 3) * 0.05);
          const x = -w / 2 + IN(2) + b * (w / 3.1) + bw / 2;
          const bh = (h / shelves) * (0.55 + ((s + b) % 2) * 0.15);
          return (
            <Box key={`${s}-${b}`} s={[bw, bh, d * 0.7]} p={[x, (h / shelves) * s + bh / 2 + IN(1), 0]}
              m={fixedMat(`book-${(s * 3 + b) % bookColors.length}`, () => new THREE.MeshStandardMaterial({ color: bookColors[(s * 3 + b) % bookColors.length], roughness: 0.9 }))} castShadow={false} />
          );
        }),
      )}
    </group>
  );
}

export function Bed({ w, d, h, finishes }: BuilderProps) {
  const fab = mat(finishes.fabric, "fab-oat");
  const frame = mat(finishes.frame, "wood-walnut");
  const mattressH = IN(11);
  const baseH = IN(9);
  return (
    <group>
      {/* headboard at -Z (against wall) */}
      <Box s={[w, h, IN(3)]} p={[0, h / 2, -d / 2 + IN(1.5)]} m={fab} />
      {/* base + mattress */}
      <Box s={[w - IN(2), baseH, d - IN(6)]} p={[0, baseH / 2 + IN(2), IN(1)]} m={frame} />
      <Box s={[w - IN(3), mattressH, d - IN(9)]} p={[0, baseH + IN(2) + mattressH / 2, IN(1)]} m={fixedMat("mattress", () => new THREE.MeshStandardMaterial({ color: "#f0ede4", roughness: 0.95 }))} />
      {/* duvet */}
      <Box s={[w - IN(1.5), IN(3), (d - IN(9)) * 0.7]} p={[0, baseH + IN(2) + mattressH + IN(1), IN(1) + (d - IN(9)) * 0.15]} m={matShade(finishes.fabric, 0.04, "fab-oat")} castShadow={false} />
      {/* pillows */}
      {[-1, 1].map((sgn) => (
        <Box key={sgn} s={[w * 0.36, IN(5), IN(16)]} p={[sgn * w * 0.21, baseH + IN(2) + mattressH + IN(2.5), -d / 2 + IN(14)]} m={fixedMat("pillow", () => new THREE.MeshStandardMaterial({ color: "#f7f5ee", roughness: 1 }))} castShadow={false} />
      ))}
    </group>
  );
}

export function Dresser({ w, d, h, finishes }: BuilderProps) {
  const wood = mat(finishes.wood, "wood-walnut");
  const rows = 3;
  const cols = 2;
  const drawerH = (h - IN(6)) / rows;
  const drawerW = (w - IN(3)) / cols;
  return (
    <group>
      <Box s={[w, h - IN(4), d]} p={[0, IN(4) + (h - IN(4)) / 2, 0]} m={wood} />
      {[[-w / 2 + IN(2), -d / 2 + IN(2)], [w / 2 - IN(2), -d / 2 + IN(2)], [-w / 2 + IN(2), d / 2 - IN(2)], [w / 2 - IN(2), d / 2 - IN(2)]].map(([x, z], i) => (
        <Cyl key={i} rTop={IN(0.8)} rBot={IN(1)} h={IN(4)} p={[x, IN(2), z]} m={wood} seg={8} />
      ))}
      {Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => {
          const x = -w / 2 + IN(1.5) + drawerW * (c + 0.5);
          const y = IN(5) + drawerH * (r + 0.5);
          return (
            <group key={`${r}-${c}`}>
              <Box s={[drawerW - IN(0.8), drawerH - IN(0.8), IN(0.6)]} p={[x, y, d / 2]} m={matShade(finishes.wood, 0.1, "wood-walnut")} castShadow={false} />
              <BarPull len={IN(5)} finish={finishes.hardware} p={[x, y, d / 2 + IN(0.7)]} />
            </group>
          );
        }),
      )}
    </group>
  );
}

export function Nightstand(props: BuilderProps) {
  return <Dresser {...props} />;
}

export function Desk({ w, d, h, finishes }: BuilderProps) {
  const wood = mat(finishes.wood, "wood-oak");
  const legM = mat(finishes.legs, "metal-matte-black");
  return (
    <group>
      <Box s={[w, IN(1.4), d]} p={[0, h - IN(0.7), 0]} m={wood} />
      {[[-w / 2 + IN(2), 0], [w / 2 - IN(2), 0]].map(([x], i) => (
        <group key={i}>
          <Box s={[IN(1.2), h - IN(1.4), IN(1.2)]} p={[x, (h - IN(1.4)) / 2, -d / 2 + IN(2)]} m={legM} />
          <Box s={[IN(1.2), h - IN(1.4), IN(1.2)]} p={[x, (h - IN(1.4)) / 2, d / 2 - IN(2)]} m={legM} />
          <Box s={[IN(1.2), IN(1.2), d - IN(4)]} p={[x, IN(3), 0]} m={legM} castShadow={false} />
        </group>
      ))}
    </group>
  );
}

export function Rug({ w, d, finishes }: BuilderProps) {
  return (
    <group>
      <Box s={[w, IN(0.4), d]} p={[0, IN(0.2), 0]} m={mat(finishes.fabric, "fab-cream-boucle")} castShadow={false} />
      <Box s={[w - IN(8), IN(0.42), d - IN(8)]} p={[0, IN(0.21), 0]} m={matShade(finishes.fabric, 0.07, "fab-cream-boucle")} castShadow={false} />
    </group>
  );
}

// --------------------------------- Decor ---------------------------------

export function Plant({ w, h }: BuilderProps) {
  const potH = h * 0.22;
  return (
    <group>
      <Cyl rTop={w * 0.42} rBot={w * 0.32} h={potH} p={[0, potH / 2, 0]} m={fixedMat("pot", () => new THREE.MeshStandardMaterial({ color: "#b9aa97", roughness: 0.8 }))} seg={16} />
      <Cyl rTop={w * 0.38} rBot={w * 0.38} h={IN(0.6)} p={[0, potH, 0]} m={soilMat()} seg={14} castShadow={false} />
      <Cyl rTop={IN(0.5)} rBot={IN(0.7)} h={h * 0.4} p={[0, potH + h * 0.2, 0]} m={fixedMat("trunk", () => new THREE.MeshStandardMaterial({ color: "#6d553c", roughness: 1 }))} seg={8} />
      {Array.from({ length: 7 }, (_, i) => {
        const a = (i / 7) * Math.PI * 2;
        const ly = potH + h * (0.4 + (i % 3) * 0.14);
        return (
          <group key={i} position={[Math.cos(a) * w * 0.18, ly, Math.sin(a) * w * 0.18]} rotation={[0.5 * Math.sin(a + 1), a, 0.4]}>
            <Ball r={w * 0.3} p={[0, 0, 0]} m={i % 2 ? leafMat() : leafMat2()} seg={8} />
          </group>
        );
      })}
    </group>
  );
}

export function PlantSmall({ w, h }: BuilderProps) {
  return (
    <group>
      <Cyl rTop={w * 0.4} rBot={w * 0.3} h={h * 0.45} p={[0, h * 0.225, 0]} m={fixedMat("pot2", () => new THREE.MeshStandardMaterial({ color: "#cfc6b8", roughness: 0.8 }))} seg={14} />
      {Array.from({ length: 5 }, (_, i) => {
        const a = (i / 5) * Math.PI * 2;
        return <Ball key={i} r={w * 0.26} p={[Math.cos(a) * w * 0.15, h * 0.62, Math.sin(a) * w * 0.15]} m={i % 2 ? leafMat() : leafMat2()} seg={8} />;
      })}
    </group>
  );
}

export function Mirror({ w, d, h, finishes }: BuilderProps) {
  return (
    <group>
      <Cyl rTop={w / 2} rBot={w / 2} h={IN(0.8)} rot={[Math.PI / 2, 0, 0]} p={[0, h / 2, 0]} m={mat(finishes.frame, "metal-brass")} seg={32} castShadow={false} />
      <Cyl rTop={w / 2 - IN(1)} rBot={w / 2 - IN(1)} h={IN(0.5)} rot={[Math.PI / 2, 0, 0]} p={[0, h / 2, IN(0.3)]} m={mirrorMat()} seg={32} castShadow={false} />
    </group>
  );
}

const ART_COLORS = [
  ["#d8c9b0", "#7d8a96", "#42546b"],
  ["#e3d6c2", "#a3795c", "#5d4a3a"],
  ["#ccd5cc", "#7c9885", "#3f5747"],
];

export function Art({ w, d, h }: BuilderProps) {
  const palette = ART_COLORS[Math.floor(w * 100) % ART_COLORS.length];
  return (
    <group>
      <Box s={[w, h, IN(1)]} p={[0, h / 2, 0]} m={fixedMat("frame-dark", () => new THREE.MeshStandardMaterial({ color: "#2c2a27", roughness: 0.6 }))} castShadow={false} />
      <Box s={[w - IN(2), h - IN(2), IN(0.3)]} p={[0, h / 2, IN(0.45)]} m={fixedMat(`art-${palette[0]}`, () => new THREE.MeshStandardMaterial({ color: palette[0], roughness: 0.9 }))} castShadow={false} />
      <Box s={[(w - IN(2)) * 0.55, (h - IN(2)) * 0.4, IN(0.1)]} p={[-(w - IN(2)) * 0.1, h * 0.55, IN(0.62)]} m={fixedMat(`art2-${palette[1]}`, () => new THREE.MeshStandardMaterial({ color: palette[1], roughness: 0.9 }))} castShadow={false} />
      <Box s={[(w - IN(2)) * 0.35, (h - IN(2)) * 0.3, IN(0.1)]} p={[(w - IN(2)) * 0.2, h * 0.4, IN(0.66)]} m={fixedMat(`art3-${palette[2]}`, () => new THREE.MeshStandardMaterial({ color: palette[2], roughness: 0.9 }))} castShadow={false} />
    </group>
  );
}

export function Vase({ w, h }: BuilderProps) {
  return (
    <group>
      <Cyl rTop={w * 0.22} rBot={w * 0.42} h={h * 0.75} p={[0, h * 0.375, 0]} m={fixedMat("vase-c", () => new THREE.MeshStandardMaterial({ color: "#c9b8a3", roughness: 0.5 }))} seg={16} />
      {Array.from({ length: 3 }, (_, i) => (
        <Cyl key={i} rTop={IN(0.1)} rBot={IN(0.1)} h={h * 0.45} p={[(i - 1) * IN(0.8), h * 0.85, (i % 2) * IN(0.5)]} rot={[0, 0, (i - 1) * 0.25]} m={fixedMat("stem", () => new THREE.MeshStandardMaterial({ color: "#8a7a5a", roughness: 1 }))} seg={6} castShadow={false} />
      ))}
    </group>
  );
}
