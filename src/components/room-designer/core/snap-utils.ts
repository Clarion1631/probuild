import type { Asset } from "@/lib/room-designer/asset-registry";
import { getAsset } from "@/lib/room-designer/asset-registry";
import { resolveDimensions } from "@/lib/room-designer/asset-resolve";
import type { PlacedAsset, Wall } from "@/components/room-designer/types";

export const WALL_SNAP_DISTANCE = 0.1524; // 6"
export const ADJACENT_SNAP_DISTANCE = 0.1524; // 6"

export interface AABB {
    x1: number; x2: number;
    y1: number; y2: number;
    z1: number; z2: number;
}

export function snap(value: number, grid: number): number {
    return Math.round(value / grid) * grid;
}

export function aabbOf(placed: PlacedAsset): AABB | null {
    const reg = getAsset(placed.assetId);
    if (!reg) return null;
    const { width, height, depth } = resolveDimensions(placed, reg);
    const cx = placed.position.x;
    const cz = placed.position.z;
    const cy = placed.position.y + height / 2;
    return {
        x1: cx - width / 2, x2: cx + width / 2,
        y1: cy - height / 2, y2: cy + height / 2,
        z1: cz - depth / 2, z2: cz + depth / 2,
    };
}

export function aabbFromPose(asset: Asset, x: number, z: number, yOffset: number): AABB {
    const { width, height, depth } = asset.dimensions;
    const cy = yOffset + height / 2;
    return {
        x1: x - width / 2, x2: x + width / 2,
        y1: cy - height / 2, y2: cy + height / 2,
        z1: z - depth / 2, z2: z + depth / 2,
    };
}

export function overlaps(a: AABB, b: AABB): boolean {
    return (
        a.x1 < b.x2 && a.x2 > b.x1 &&
        a.y1 < b.y2 && a.y2 > b.y1 &&
        a.z1 < b.z2 && a.z2 > b.z1
    );
}

export function pointSegmentDistance(
    px: number, pz: number,
    sx: number, sz: number,
    ex: number, ez: number,
): { dist: number; proj: { x: number; z: number } } {
    const dx = ex - sx, dz = ez - sz;
    const len2 = dx * dx + dz * dz;
    if (len2 === 0) {
        const d = Math.hypot(px - sx, pz - sz);
        return { dist: d, proj: { x: sx, z: sz } };
    }
    let t = ((px - sx) * dx + (pz - sz) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const projX = sx + t * dx;
    const projZ = sz + t * dz;
    return {
        dist: Math.hypot(px - projX, pz - projZ),
        proj: { x: projX, z: projZ },
    };
}

export function sideOfWall(px: number, pz: number, wall: Wall): number {
    const dx = wall.end.x - wall.start.x;
    const dz = wall.end.z - wall.start.z;
    const cross = dx * (pz - wall.start.z) - dz * (px - wall.start.x);
    return Math.sign(cross) || 1;
}

export function snapToWall(
    assetDepth: number,
    x: number,
    z: number,
    walls: Wall[],
): { x: number; z: number; rotationY: number; snapped: boolean } {
    let best: { wall: Wall; dist: number; proj: { x: number; z: number } } | null = null;
    for (const wall of walls) {
        const { dist, proj } = pointSegmentDistance(x, z, wall.start.x, wall.start.z, wall.end.x, wall.end.z);
        if (dist < WALL_SNAP_DISTANCE && (!best || dist < best.dist)) {
            best = { wall, dist, proj };
        }
    }
    if (!best) return { x, z, rotationY: 0, snapped: false };

    const wall = best.wall;
    const dx = wall.end.x - wall.start.x;
    const dz = wall.end.z - wall.start.z;
    if (dx === 0 && dz === 0) return { x, z, rotationY: 0, snapped: false };

    const wallAngle = Math.atan2(dz, dx);
    const side = sideOfWall(x, z, wall);
    const rotationY = wallAngle + (side > 0 ? Math.PI / 2 : -Math.PI / 2);

    const pushDist = assetDepth / 2;
    const len = Math.hypot(dx, dz);
    const outX = (-side * dz) / len;
    const outZ = (side * dx) / len;
    return {
        x: best.proj.x + outX * pushDist,
        z: best.proj.z + outZ * pushDist,
        rotationY,
        snapped: true,
    };
}

export function snapToAdjacent(
    width: number,
    depth: number,
    x: number,
    z: number,
    otherBoxes: AABB[],
): { x: number; z: number } {
    let adjustedX = x;
    let adjustedZ = z;
    let bestDistX = ADJACENT_SNAP_DISTANCE;
    let bestDistZ = ADJACENT_SNAP_DISTANCE;

    for (const other of otherBoxes) {
        const dRight = Math.abs((x + width / 2) - other.x1);
        const dLeft = Math.abs((x - width / 2) - other.x2);
        if (dRight < bestDistX) {
            bestDistX = dRight;
            adjustedX = other.x1 - width / 2;
        }
        if (dLeft < bestDistX) {
            bestDistX = dLeft;
            adjustedX = other.x2 + width / 2;
        }

        const dFront = Math.abs((z + depth / 2) - other.z1);
        const dBack = Math.abs((z - depth / 2) - other.z2);
        if (dFront < bestDistZ) {
            bestDistZ = dFront;
            adjustedZ = other.z1 - depth / 2;
        }
        if (dBack < bestDistZ) {
            bestDistZ = dBack;
            adjustedZ = other.z2 + depth / 2;
        }
    }

    return { x: adjustedX, z: adjustedZ };
}
