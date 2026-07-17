"use client";

// Room Studio - procedural builders: outdoor structures, patio furniture,
// landscaping. Same local-space contract as builders-kitchen: y=0 at the
// item's bottom, x = width, z = depth, +Z faces the viewer at rotation 0.

import * as THREE from "three";
import { inches } from "@/lib/studio/units";
import {
  Box, Cyl, Ball, mat, matShade, fixedMat, flameMat, soilMat, leafMat, leafMat2,
} from "./parts";
import type { BuilderProps } from "./builders";

const IN = inches;

const barkMat = () =>
  fixedMat("bark", () => new THREE.MeshStandardMaterial({ color: "#6B5138", roughness: 1 }));

const pineMat = () =>
  fixedMat("pine", () => new THREE.MeshStandardMaterial({ color: "#3E5C40", roughness: 0.9 }));

const pineMat2 = () =>
  fixedMat("pine2", () => new THREE.MeshStandardMaterial({ color: "#4A6B49", roughness: 0.9 }));

const stoneMat = () =>
  fixedMat("stone-gray", () => new THREE.MeshStandardMaterial({ color: "#8B8680", roughness: 0.95 }));

const charMat = () =>
  fixedMat("char", () => new THREE.MeshStandardMaterial({ color: "#211d1a", roughness: 1 }));

const FLOWER_COLORS = ["#C24B57", "#D9A03C", "#B287C2", "#E0E4DE", "#D8756B"];

const flowerMat = (i: number) =>
  fixedMat(`flower-${i % FLOWER_COLORS.length}`, () =>
    new THREE.MeshStandardMaterial({ color: FLOWER_COLORS[i % FLOWER_COLORS.length], roughness: 0.85 }));

/** Half-torus arch in the XY plane (for the garden arbor). */
function Arch({ r, tube, p, m }: { r: number; tube: number; p: [number, number, number]; m: THREE.Material }) {
  return (
    <mesh position={p} material={m} castShadow receiveShadow>
      <torusGeometry args={[r, tube, 8, 20, Math.PI]} />
    </mesh>
  );
}

// -------------------------------- Structures --------------------------------

/**
 * Low deck platform: board top over a skirt. Furniture placed on top of it is
 * seeded with y = platform height in the outdoor templates.
 */
export function DeckPlatform({ w, d, h, finishes }: BuilderProps) {
  const boardD = IN(5.6);
  const n = Math.max(4, Math.round(d / boardD));
  const step = d / n;
  return (
    <group>
      {/* skirt / joist body */}
      <Box s={[w - IN(1), Math.max(IN(2), h - IN(1.1)), d - IN(1)]} p={[0, Math.max(IN(2), h - IN(1.1)) / 2, 0]} m={matShade(finishes.wood, 0.22, "wood-cedar")} />
      {/* deck boards with slight alternating shade */}
      {Array.from({ length: n }, (_, i) => (
        <Box
          key={i}
          s={[w, IN(1.1), step - IN(0.35)]}
          p={[0, h - IN(0.55), -d / 2 + step * (i + 0.5)]}
          m={i % 2 ? mat(finishes.wood, "wood-cedar") : matShade(finishes.wood, 0.07, "wood-cedar")}
          castShadow={false}
        />
      ))}
    </group>
  );
}

export function Pergola({ w, d, h, finishes }: BuilderProps) {
  const wood = mat(finishes.wood, "wood-cedar");
  const woodD = matShade(finishes.wood, 0.1, "wood-cedar");
  const post = IN(5.5);
  const px = w / 2 - post / 2 - IN(4);
  const pz = d / 2 - post / 2 - IN(4);
  const beamY = h - IN(9);
  const rafters = Math.max(4, Math.round(w / IN(20)));
  return (
    <group>
      {/* posts */}
      {[[-px, -pz], [px, -pz], [-px, pz], [px, pz]].map(([x, z], i) => (
        <Box key={i} s={[post, beamY, post]} p={[x, beamY / 2, z]} m={wood} />
      ))}
      {/* twin carrying beams along X */}
      {[-pz, pz].map((z, i) => (
        <Box key={i} s={[w, IN(7), IN(2)]} p={[0, beamY + IN(3.5), z]} m={woodD} />
      ))}
      {/* rafters across Z, ends past the beams */}
      {Array.from({ length: rafters }, (_, i) => {
        const x = -w / 2 + IN(6) + ((w - IN(12)) / (rafters - 1)) * i;
        return <Box key={i} s={[IN(2), IN(5.5), d]} p={[x, h - IN(2.75), 0]} m={wood} />;
      })}
      {/* top shade slats along X */}
      {Array.from({ length: 5 }, (_, i) => (
        <Box key={i} s={[w - IN(8), IN(1.2), IN(1.6)]} p={[0, h + IN(0.6), -d / 2 + IN(8) + ((d - IN(16)) / 4) * i]} m={woodD} castShadow={false} />
      ))}
    </group>
  );
}

/** Open gabled porch: corner posts carrying a peaked roof, ridge along X. */
export function GablePorch({ w, d, h, finishes }: BuilderProps) {
  const postM = mat(finishes.post, "paint-pure-white");
  const roofM = mat(finishes.roof, "paint-graphite");
  const post = IN(6);
  const rise = Math.min(d * 0.35, h * 0.32);
  const eaveY = h - rise;
  const overX = IN(8);
  const overZ = IN(6);
  const halfSpan = d / 2 + overZ;
  const slopeLen = Math.hypot(halfSpan, rise);
  const angle = Math.atan2(rise, halfSpan);
  const px = w / 2 - post / 2 - IN(2);
  const pz = d / 2 - post / 2 - IN(2);
  return (
    <group>
      {/* posts */}
      {[[-px, -pz], [px, -pz], [-px, pz], [px, pz]].map(([x, z], i) => (
        <Box key={i} s={[post, eaveY, post]} p={[x, eaveY / 2, z]} m={postM} />
      ))}
      {/* header beams tying the posts, front + back and sides */}
      {[-pz, pz].map((z, i) => (
        <Box key={`fb${i}`} s={[w, IN(7), IN(4)]} p={[0, eaveY - IN(3.5), z]} m={postM} />
      ))}
      {[-px, px].map((x, i) => (
        <Box key={`s${i}`} s={[IN(4), IN(7), d - post * 2]} p={[x, eaveY - IN(3.5), 0]} m={postM} castShadow={false} />
      ))}
      {/* roof panels meeting at the ridge */}
      {[-1, 1].map((sgn) => (
        <group key={sgn} position={[0, eaveY + rise / 2, sgn * halfSpan / 2]} rotation={[sgn * angle, 0, 0]}>
          <Box s={[w + overX * 2, IN(2.5), slopeLen]} p={[0, 0, 0]} m={roofM} />
        </group>
      ))}
      {/* ridge cap */}
      <Box s={[w + overX * 2, IN(2.2), IN(5)]} p={[0, h + IN(0.4), 0]} m={matShade(finishes.roof, 0.15, "paint-graphite")} castShadow={false} />
      {/* gable end fascia boards under each roof edge */}
      {[-1, 1].map((sgn) => (
        <group key={sgn}>
          <Box s={[IN(1.5), IN(6), d + overZ * 2]} p={[sgn * (w / 2 + overX - IN(1)), eaveY + rise * 0.45, 0]} m={postM} castShadow={false} />
        </group>
      ))}
    </group>
  );
}

/** Garden archway / arbor: side lattice frames + arched top. */
export function GardenArbor({ w, d, h, finishes }: BuilderProps) {
  const wood = mat(finishes.wood, "paint-pure-white");
  const woodD = matShade(finishes.wood, 0.08, "paint-pure-white");
  const r = w / 2 - IN(2);
  const postH = h - r;
  const px = w / 2 - IN(1.5);
  const pz = d / 2 - IN(1.25);
  return (
    <group>
      {/* four corner posts */}
      {[[-px, -pz], [px, -pz], [-px, pz], [px, pz]].map(([x, z], i) => (
        <Box key={i} s={[IN(2.5), postH, IN(2.5)]} p={[x, postH / 2, z]} m={wood} />
      ))}
      {/* side lattice rungs */}
      {[-1, 1].map((sx) =>
        Array.from({ length: 4 }, (_, i) => (
          <Box key={`${sx}-${i}`} s={[IN(1), IN(1), d - IN(2)]} p={[sx * px, postH * (0.25 + i * 0.2), 0]} m={woodD} castShadow={false} />
        )),
      )}
      {/* front + back arches */}
      {[-pz, pz].map((z, i) => (
        <Arch key={i} r={r} tube={IN(1.2)} p={[0, postH, z]} m={wood} />
      ))}
      {/* slats over the arch crown */}
      {Array.from({ length: 5 }, (_, i) => {
        const a = Math.PI * (0.2 + i * 0.15);
        const x = Math.cos(a) * r;
        const y = postH + Math.sin(a) * r;
        return <Box key={i} s={[IN(1.4), IN(1), d + IN(2)]} p={[x, y, 0]} m={woodD} castShadow={false} />;
      })}
    </group>
  );
}

/** Privacy fence panel: end posts, rails, vertical boards. */
export function FencePanel({ w, h, finishes }: BuilderProps) {
  const wood = mat(finishes.wood, "wood-cedar");
  const woodD = matShade(finishes.wood, 0.1, "wood-cedar");
  const boardW = IN(5.5);
  const n = Math.max(3, Math.round((w - IN(8)) / (boardW + IN(0.4))));
  const step = (w - IN(8)) / n;
  return (
    <group>
      {/* end posts with caps */}
      {[-1, 1].map((sgn) => (
        <group key={sgn} position={[sgn * (w / 2 - IN(2)), 0, 0]}>
          <Box s={[IN(4), h, IN(4)]} p={[0, h / 2, 0]} m={wood} />
          <Box s={[IN(5), IN(1.2), IN(5)]} p={[0, h + IN(0.6), 0]} m={woodD} castShadow={false} />
        </group>
      ))}
      {/* rails */}
      {[h * 0.18, h * 0.55, h * 0.88].map((y, i) => (
        <Box key={i} s={[w - IN(8), IN(3), IN(1.4)]} p={[0, y, -IN(0.9)]} m={woodD} castShadow={false} />
      ))}
      {/* boards */}
      {Array.from({ length: n }, (_, i) => (
        <Box
          key={i}
          s={[step - IN(0.4), h - IN(3), IN(0.9)]}
          p={[-(w - IN(8)) / 2 + step * (i + 0.5), (h - IN(3)) / 2 + IN(1.5), IN(0.4)]}
          m={i % 2 ? wood : matShade(finishes.wood, 0.05, "wood-cedar")}
          castShadow={false}
        />
      ))}
    </group>
  );
}

export function PlanterBox({ w, d, h, finishes }: BuilderProps) {
  const wood = mat(finishes.wood, "wood-cedar");
  const soilY = h - IN(2);
  const blooms = Math.max(3, Math.round(w / IN(9)));
  return (
    <group>
      {/* walls */}
      <Box s={[w, h, IN(1.2)]} p={[0, h / 2, d / 2 - IN(0.6)]} m={wood} />
      <Box s={[w, h, IN(1.2)]} p={[0, h / 2, -d / 2 + IN(0.6)]} m={wood} />
      <Box s={[IN(1.2), h, d]} p={[-w / 2 + IN(0.6), h / 2, 0]} m={wood} />
      <Box s={[IN(1.2), h, d]} p={[w / 2 - IN(0.6), h / 2, 0]} m={wood} />
      {/* cap rim: four strips so the soil stays open */}
      <Box s={[w + IN(1.5), IN(1), IN(2)]} p={[0, h - IN(0.5), d / 2 - IN(0.25)]} m={matShade(finishes.wood, 0.1, "wood-cedar")} castShadow={false} />
      <Box s={[w + IN(1.5), IN(1), IN(2)]} p={[0, h - IN(0.5), -d / 2 + IN(0.25)]} m={matShade(finishes.wood, 0.1, "wood-cedar")} castShadow={false} />
      <Box s={[IN(2), IN(1), d + IN(1.5)]} p={[-w / 2 + IN(0.25), h - IN(0.5), 0]} m={matShade(finishes.wood, 0.1, "wood-cedar")} castShadow={false} />
      <Box s={[IN(2), IN(1), d + IN(1.5)]} p={[w / 2 - IN(0.25), h - IN(0.5), 0]} m={matShade(finishes.wood, 0.1, "wood-cedar")} castShadow={false} />
      {/* soil */}
      <Box s={[w - IN(2.5), IN(0.8), d - IN(2.5)]} p={[0, soilY, 0]} m={soilMat()} castShadow={false} />
      {/* greenery + blooms */}
      {Array.from({ length: blooms }, (_, i) => {
        const x = -w / 2 + IN(4) + ((w - IN(8)) / Math.max(1, blooms - 1)) * i;
        const z = ((i % 3) - 1) * (d * 0.18);
        return (
          <group key={i} position={[x, soilY, z]}>
            <Ball r={IN(3.2)} p={[0, IN(2.5), 0]} m={i % 2 ? leafMat() : leafMat2()} seg={8} />
            <Ball r={IN(1.4)} p={[IN(1), IN(5.2), 0]} m={flowerMat(i)} seg={8} />
          </group>
        );
      })}
    </group>
  );
}

// ----------------------------- Patio furniture -----------------------------

export function PatioTable({ w, d, h, finishes }: BuilderProps) {
  const wood = mat(finishes.wood, "wood-teak");
  const metal = mat(finishes.metal, "metal-matte-black");
  const slats = Math.max(5, Math.round(w / IN(7)));
  const slatW = (w - IN(2)) / slats;
  return (
    <group>
      {/* slatted top */}
      {Array.from({ length: slats }, (_, i) => (
        <Box key={i} s={[slatW - IN(0.4), IN(1.2), d]} p={[-(w - IN(2)) / 2 + slatW * (i + 0.5), h - IN(0.6), 0]} m={i % 2 ? wood : matShade(finishes.wood, 0.06, "wood-teak")} />
      ))}
      {/* apron + legs */}
      <Box s={[w - IN(6), IN(2.5), d - IN(6)]} p={[0, h - IN(2.5), 0]} m={metal} castShadow={false} />
      {[[-w / 2 + IN(3), -d / 2 + IN(3)], [w / 2 - IN(3), -d / 2 + IN(3)], [-w / 2 + IN(3), d / 2 - IN(3)], [w / 2 - IN(3), d / 2 - IN(3)]].map(([x, z], i) => (
        <Box key={i} s={[IN(1.6), h - IN(1.2), IN(1.6)]} p={[x, (h - IN(1.2)) / 2, z]} m={metal} />
      ))}
    </group>
  );
}

export function PatioChair({ w, d, h, finishes }: BuilderProps) {
  const metal = mat(finishes.metal, "metal-matte-black");
  const fab = mat(finishes.fabric, "fab-charcoal");
  const seatH = IN(17);
  return (
    <group>
      {/* legs */}
      {[[-w / 2 + IN(1), -d / 2 + IN(1.2)], [w / 2 - IN(1), -d / 2 + IN(1.2)], [-w / 2 + IN(1), d / 2 - IN(1.2)], [w / 2 - IN(1), d / 2 - IN(1.2)]].map(([x, z], i) => (
        <Cyl key={i} rTop={IN(0.6)} rBot={IN(0.7)} h={seatH} p={[x, seatH / 2, z]} m={metal} seg={8} />
      ))}
      {/* seat + slightly reclined back (back at -Z) */}
      <Box s={[w, IN(2), d * 0.9]} p={[0, seatH + IN(1), IN(0.5)]} m={fab} />
      <group position={[0, seatH + IN(2), -d / 2 + IN(2.5)]} rotation={[-0.12, 0, 0]}>
        <Box s={[w - IN(1), h - seatH - IN(2), IN(2)]} p={[0, (h - seatH - IN(2)) / 2, 0]} m={fab} />
      </group>
      {/* armrests */}
      {[-1, 1].map((sgn) => (
        <group key={sgn}>
          <Box s={[IN(1.6), IN(1), d * 0.7]} p={[sgn * (w / 2 - IN(0.8)), seatH + IN(7.5), 0]} m={metal} castShadow={false} />
          <Box s={[IN(1), IN(7), IN(1)]} p={[sgn * (w / 2 - IN(0.8)), seatH + IN(3.5), d / 2 - IN(3)]} m={metal} castShadow={false} />
        </group>
      ))}
    </group>
  );
}

export function Adirondack({ w, d, h, finishes }: BuilderProps) {
  const wood = mat(finishes.wood, "wood-white");
  const woodD = matShade(finishes.wood, 0.07, "wood-white");
  const backSlats = 5;
  const slatW = (w - IN(6)) / backSlats;
  return (
    <group>
      {/* sloped seat (drops toward the back) */}
      <group position={[0, IN(13), IN(1)]} rotation={[-0.2, 0, 0]}>
        <Box s={[w - IN(5), IN(1.2), d * 0.6]} p={[0, 0, 0]} m={wood} />
      </group>
      {/* fanned back, taller in the middle, leaning back (back at -Z) */}
      {Array.from({ length: backSlats }, (_, i) => {
        const x = -(w - IN(6)) / 2 + slatW * (i + 0.5);
        const tall = h - IN(12) - Math.abs(i - (backSlats - 1) / 2) * IN(2.2);
        return (
          <group key={i} position={[x, IN(10), -d / 2 + IN(7)]} rotation={[-0.32, 0, 0]}>
            <Box s={[slatW - IN(0.5), tall, IN(1)]} p={[0, tall / 2, 0]} m={i % 2 ? wood : woodD} />
          </group>
        );
      })}
      {/* wide flat arms */}
      {[-1, 1].map((sgn) => (
        <Box key={sgn} s={[IN(5), IN(1.1), d * 0.85]} p={[sgn * (w / 2 - IN(2.5)), IN(23), 0]} m={wood} />
      ))}
      {/* legs */}
      {[[-w / 2 + IN(2.5), d / 2 - IN(3), IN(22)], [w / 2 - IN(2.5), d / 2 - IN(3), IN(22)], [-w / 2 + IN(2.5), -d / 2 + IN(4), IN(16)], [w / 2 - IN(2.5), -d / 2 + IN(4), IN(16)]].map(([x, z, lh], i) => (
        <Box key={i} s={[IN(1.4), lh, IN(1.4)]} p={[x, lh / 2, z]} m={woodD} />
      ))}
    </group>
  );
}

export function ChaiseLounge({ w, d, h, finishes }: BuilderProps) {
  const frame = mat(finishes.frame, "wood-teak");
  const fab = mat(finishes.fabric, "fab-oat");
  const baseH = IN(9);
  const flatD = d * 0.62;
  const backD = d * 0.36;
  return (
    <group>
      {/* frame + legs */}
      <Box s={[w, IN(2.5), d]} p={[0, baseH, 0]} m={frame} />
      {[[-w / 2 + IN(2), -d / 2 + IN(3)], [w / 2 - IN(2), -d / 2 + IN(3)], [-w / 2 + IN(2), d / 2 - IN(3)], [w / 2 - IN(2), d / 2 - IN(3)]].map(([x, z], i) => (
        <Box key={i} s={[IN(1.6), baseH, IN(1.6)]} p={[x, baseH / 2, z]} m={frame} />
      ))}
      {/* flat cushion (feet toward +Z) */}
      <Box s={[w - IN(1), IN(3.5), flatD]} p={[0, baseH + IN(3), d / 2 - flatD / 2]} m={fab} />
      {/* raised back cushion: hinges at the flat cushion, rises toward the head end (-Z) */}
      <group position={[0, baseH + IN(3), -d / 2 + backD]} rotation={[0.55, 0, 0]}>
        <Box s={[w - IN(1), IN(3.5), backD + IN(2)]} p={[0, IN(1), -(backD + IN(2)) / 2 + IN(1)]} m={fab} />
      </group>
    </group>
  );
}

export function OutdoorSofa({ w, d, h, finishes }: BuilderProps) {
  const frame = mat(finishes.frame, "wood-teak");
  const fab = mat(finishes.fabric, "fab-cloud");
  const fabD = matShade(finishes.fabric, 0.07, "fab-cloud");
  const baseH = IN(11);
  const armW = IN(6);
  const seats = Math.max(2, Math.round((w - armW * 2) / IN(28)));
  const cushW = (w - armW * 2) / seats;
  return (
    <group>
      {/* chunky teak frame: base, low back, wide flat arms - all grounded */}
      <Box s={[w, baseH, d]} p={[0, baseH / 2, 0]} m={frame} />
      <Box s={[w, h - baseH, IN(3)]} p={[0, baseH + (h - baseH) / 2, -d / 2 + IN(1.5)]} m={frame} />
      {[-1, 1].map((sgn) => (
        <group key={sgn}>
          <Box s={[armW, h * 0.62, d]} p={[sgn * (w / 2 - armW / 2), h * 0.31, 0]} m={frame} />
          <Box s={[armW + IN(1), IN(1.2), d]} p={[sgn * (w / 2 - armW / 2), h * 0.62, 0]} m={matShade(finishes.frame, 0.08, "wood-teak")} castShadow={false} />
        </group>
      ))}
      {/* cushions */}
      {Array.from({ length: seats }, (_, i) => {
        const x = -w / 2 + armW + cushW * (i + 0.5);
        return (
          <group key={i}>
            <Box s={[cushW - IN(1), IN(5), d - armW - IN(4)]} p={[x, baseH + IN(2), IN(1.5)]} m={fab} />
            <Box s={[cushW - IN(1.5), h - baseH - IN(1), IN(4.5)]} p={[x, baseH + IN(1) + (h - baseH - IN(1)) / 2, -d / 2 + IN(5.5)]} m={fabD} />
          </group>
        );
      })}
    </group>
  );
}

export function FirePit({ w, h, lightsOn }: BuilderProps) {
  const r = w / 2;
  return (
    <group>
      {/* stone ring */}
      <Cyl rTop={r} rBot={r * 0.92} h={h} p={[0, h / 2, 0]} m={stoneMat()} seg={18} />
      <Cyl rTop={r - IN(3)} rBot={r - IN(3)} h={h} p={[0, h / 2 + IN(0.4), 0]} m={charMat()} seg={16} castShadow={false} />
      {/* logs */}
      {Array.from({ length: 3 }, (_, i) => (
        <Cyl key={i} rTop={IN(1.6)} rBot={IN(1.6)} h={r * 1.1} p={[0, h - IN(1), 0]} rot={[Math.PI / 2, 0, (i / 3) * Math.PI]} m={barkMat()} seg={8} castShadow={false} />
      ))}
      {lightsOn && (
        <>
          {/* flame cones */}
          <Cyl rTop={IN(0.2)} rBot={IN(4.5)} h={IN(9)} p={[0, h + IN(3.5), 0]} m={flameMat()} seg={10} castShadow={false} />
          <Cyl rTop={IN(0.2)} rBot={IN(2.8)} h={IN(6)} p={[IN(3), h + IN(2), IN(2)]} m={flameMat()} seg={8} castShadow={false} />
          <pointLight position={[0, h + IN(10), 0]} intensity={0.8} distance={4} color="#ff9a3c" decay={2} />
        </>
      )}
    </group>
  );
}

export function Grill({ w, d, h, finishes }: BuilderProps) {
  const metal = mat(finishes.metal, "metal-stainless");
  const dark = mat("metal-black-stainless", "metal-black-stainless");
  const bodyW = w * 0.62;
  const bodyTop = h - IN(10);
  return (
    <group>
      {/* cart */}
      <Box s={[bodyW, IN(16), d - IN(2)]} p={[-w / 2 + bodyW / 2, bodyTop - IN(16) - IN(6), 0]} m={dark} />
      {[[-w / 2 + IN(3), -d / 2 + IN(3)], [-w / 2 + bodyW - IN(3), -d / 2 + IN(3)], [-w / 2 + IN(3), d / 2 - IN(3)], [-w / 2 + bodyW - IN(3), d / 2 - IN(3)]].map(([x, z], i) => (
        <Box key={i} s={[IN(1.5), bodyTop - IN(22), IN(1.5)]} p={[x, (bodyTop - IN(22)) / 2, z]} m={dark} castShadow={false} />
      ))}
      {/* wheels */}
      {[-d / 2 + IN(3), d / 2 - IN(3)].map((z, i) => (
        <Cyl key={i} rTop={IN(3)} rBot={IN(3)} h={IN(1.4)} p={[-w / 2 + IN(4), IN(3), z]} rot={[0, 0, Math.PI / 2]} m={charMat()} seg={14} castShadow={false} />
      ))}
      {/* firebox + domed lid + handle */}
      <Box s={[bodyW, IN(7), d]} p={[-w / 2 + bodyW / 2, bodyTop - IN(2.5), 0]} m={metal} />
      <group position={[-w / 2 + bodyW / 2, bodyTop + IN(1), 0]}>
        <Ball r={Math.min(bodyW, d) / 2 - IN(1)} p={[0, 0, 0]} m={metal} seg={16} half />
        <Cyl rTop={IN(0.5)} rBot={IN(0.5)} h={bodyW * 0.5} p={[0, IN(4.5), d / 2 - IN(1)]} rot={[0, 0, Math.PI / 2]} m={dark} seg={8} castShadow={false} />
      </group>
      {/* side shelf */}
      <Box s={[w - bodyW - IN(2), IN(1.4), d - IN(4)]} p={[w / 2 - (w - bodyW - IN(2)) / 2, bodyTop - IN(0.7), 0]} m={metal} />
    </group>
  );
}

export function MarketUmbrella({ w, h, finishes }: BuilderProps) {
  const metal = mat(finishes.metal, "metal-matte-black");
  const fab = mat(finishes.fabric, "fab-rust");
  const canopyH = IN(16);
  return (
    <group>
      {/* base + pole */}
      <Cyl rTop={IN(9)} rBot={IN(11)} h={IN(2.5)} p={[0, IN(1.25), 0]} m={metal} seg={16} />
      <Cyl rTop={IN(0.9)} rBot={IN(0.9)} h={h - IN(4)} p={[0, (h - IN(4)) / 2 + IN(2.5), 0]} m={metal} seg={10} castShadow={false} />
      {/* canopy cone + finial */}
      <Cyl rTop={IN(1.5)} rBot={w / 2} h={canopyH} p={[0, h - canopyH / 2 - IN(2), 0]} m={fab} seg={10} />
      <Ball r={IN(1.3)} p={[0, h - IN(1), 0]} m={metal} seg={8} />
    </group>
  );
}

// ------------------------------- Landscaping -------------------------------

export function TreeShade({ w, h }: BuilderProps) {
  const canopyBase = h * 0.42;
  return (
    <group>
      <Cyl rTop={IN(3)} rBot={IN(5.5)} h={canopyBase + h * 0.1} p={[0, (canopyBase + h * 0.1) / 2, 0]} m={barkMat()} seg={10} />
      {Array.from({ length: 7 }, (_, i) => {
        const a = (i / 7) * Math.PI * 2;
        const rr = i === 0 ? 0 : w * 0.22;
        const y = canopyBase + h * (0.28 + ((i * 2) % 3) * 0.09) + (i === 0 ? h * 0.12 : 0);
        return (
          <Ball
            key={i}
            r={w * (i === 0 ? 0.34 : 0.26)}
            p={[Math.cos(a) * rr, y, Math.sin(a) * rr]}
            m={i % 2 ? leafMat() : leafMat2()}
            seg={10}
          />
        );
      })}
    </group>
  );
}

export function TreeEvergreen({ w, h }: BuilderProps) {
  const trunkH = h * 0.14;
  const tiers = 4;
  return (
    <group>
      <Cyl rTop={IN(2.5)} rBot={IN(4)} h={trunkH + h * 0.1} p={[0, (trunkH + h * 0.1) / 2, 0]} m={barkMat()} seg={8} />
      {Array.from({ length: tiers }, (_, i) => {
        const t = i / (tiers - 1);
        const r = (w / 2) * (1 - t * 0.62);
        const tierH = (h - trunkH) * 0.4;
        const y = trunkH + (h - trunkH) * (0.12 + t * 0.62);
        return (
          <Cyl key={i} rTop={IN(0.5)} rBot={r} h={tierH} p={[0, y, 0]} m={i % 2 ? pineMat() : pineMat2()} seg={12} />
        );
      })}
    </group>
  );
}

export function Shrub({ w, h }: BuilderProps) {
  return (
    <group>
      {Array.from({ length: 6 }, (_, i) => {
        const a = (i / 6) * Math.PI * 2;
        const rr = i === 0 ? 0 : w * 0.18;
        const r = w * (i === 0 ? 0.38 : 0.3);
        // ring balls sit on the ground; the center ball domes to full height
        const y = i === 0 ? h - r : r + ((i * 3) % 2) * IN(2);
        return (
          <Ball key={i} r={r} p={[Math.cos(a) * rr, y, Math.sin(a) * rr]} m={i % 2 ? leafMat() : leafMat2()} seg={9} />
        );
      })}
    </group>
  );
}

export function Hedge({ w, d, h }: BuilderProps) {
  const bumps = Math.max(3, Math.round(w / IN(14)));
  return (
    <group>
      <Box s={[w, h - IN(4), d]} p={[0, (h - IN(4)) / 2, 0]} m={leafMat()} />
      {Array.from({ length: bumps }, (_, i) => {
        const x = -w / 2 + (w / bumps) * (i + 0.5);
        // clamp so the bumps stay inside the declared footprint
        const r = Math.min(d * 0.4, w / (2 * bumps), IN(9));
        return (
          <Ball key={i} r={r} p={[x, h - r * 0.6, ((i % 2) - 0.5) * d * 0.2]} m={i % 2 ? leafMat2() : leafMat()} seg={8} />
        );
      })}
    </group>
  );
}

export function FlowerBed({ w, d, h }: BuilderProps) {
  const bedH = Math.min(h, IN(5));
  const cols = Math.max(3, Math.round(w / IN(12)));
  const rows = Math.max(2, Math.round(d / IN(12)));
  return (
    <group>
      {/* stone edging */}
      <Box s={[w, bedH, IN(2)]} p={[0, bedH / 2, d / 2 - IN(1)]} m={stoneMat()} castShadow={false} />
      <Box s={[w, bedH, IN(2)]} p={[0, bedH / 2, -d / 2 + IN(1)]} m={stoneMat()} castShadow={false} />
      <Box s={[IN(2), bedH, d]} p={[-w / 2 + IN(1), bedH / 2, 0]} m={stoneMat()} castShadow={false} />
      <Box s={[IN(2), bedH, d]} p={[w / 2 - IN(1), bedH / 2, 0]} m={stoneMat()} castShadow={false} />
      {/* mulch */}
      <Box s={[w - IN(3), bedH - IN(1), d - IN(3)]} p={[0, (bedH - IN(1)) / 2 + IN(0.6), 0]} m={soilMat()} castShadow={false} />
      {/* flowers on stems, deterministic jitter */}
      {Array.from({ length: cols }, (_, cI) =>
        Array.from({ length: rows }, (_, rI) => {
          const i = cI * rows + rI;
          const jx = (((i * 37) % 10) - 5) * IN(0.4);
          const jz = (((i * 53) % 10) - 5) * IN(0.3);
          const x = -w / 2 + IN(6) + ((w - IN(12)) / Math.max(1, cols - 1)) * cI + jx;
          const z = -d / 2 + IN(6) + ((d - IN(12)) / Math.max(1, rows - 1)) * rI + jz;
          const stemH = IN(4.5) + ((i * 7) % 4) * IN(0.8);
          return (
            <group key={i} position={[x, bedH, z]}>
              <Cyl rTop={IN(0.15)} rBot={IN(0.15)} h={stemH} p={[0, stemH / 2, 0]} m={leafMat()} seg={5} castShadow={false} />
              <Ball r={IN(1.5)} p={[0, stemH + IN(0.8), 0]} m={flowerMat(i)} seg={8} />
            </group>
          );
        }),
      )}
    </group>
  );
}
