import * as THREE from "three";
import { USDZExporter } from "three/examples/jsm/exporters/USDZExporter.js";
import { prisma } from "@/lib/prisma";
import { getFinish } from "@/lib/studio/materials";
import { wallSegments, roomHeightAt } from "@/lib/studio/geometry";
import { getItemDef } from "@/lib/studio/catalog";
import { getSupabase, STORAGE_BUCKET } from "@/lib/supabase";
import type { DesignDoc, PlacedItem } from "@/lib/studio/doc";

export async function generateUsdzForRoom(roomId: string): Promise<string | null> {
    const room = await prisma.roomDesign.findUnique({
        where: { id: roomId },
        select: { id: true, name: true, projectId: true, leadId: true, layoutJson: true },
    });
    if (!room) return null;

    let doc: DesignDoc;
    try {
        doc = typeof room.layoutJson === "string" ? JSON.parse(room.layoutJson) : (room.layoutJson as unknown as DesignDoc);
    } catch (e) {
        console.error("Failed to parse room layoutJson:", e);
        return null;
    }

    if (!doc || doc.version !== 2 || !doc.room || !doc.room.points) {
        console.error("Invalid room design layout format");
        return null;
    }

    console.log(`Generating USDZ scene for room: ${room.name} (${room.id})...`);
    const scene = new THREE.Scene();

    // 1. Floor
    const floorShape = new THREE.Shape();
    doc.room.points.forEach((p, i) => {
        if (i === 0) floorShape.moveTo(p.x, p.z);
        else floorShape.lineTo(p.x, p.z);
    });
    floorShape.closePath();

    const floorFinish = getFinish(doc.surfaces.floor, "floor-oak-natural");
    const floorMaterial = new THREE.MeshStandardMaterial({
        color: new THREE.Color(floorFinish.hex),
        roughness: floorFinish.roughness ?? 0.6,
        metalness: floorFinish.metalness ?? 0.0,
    });
    const floorMesh = new THREE.Mesh(new THREE.ShapeGeometry(floorShape), floorMaterial);
    floorMesh.rotation.x = -Math.PI / 2; // Lie flat on Y=0
    scene.add(floorMesh);

    // 2. Walls with Openings Cut out
    const walls = wallSegments(doc.room.points);
    const thickness = doc.room.wallThickness ?? 0.127;
    const shell = { points: doc.room.points, height: doc.room.height, slope: doc.room.slope };

    for (const w of walls) {
        const hStart = roomHeightAt(shell, w.a);
        const hEnd = roomHeightAt(shell, w.b);
        const angle = Math.atan2(w.b.z - w.a.z, w.b.x - w.a.x);

        const outline = new THREE.Shape();
        outline.moveTo(0, 0);
        outline.lineTo(w.length, 0);
        outline.lineTo(w.length, hEnd);
        outline.lineTo(0, hStart);
        outline.closePath();

        // Openings (doors/windows)
        for (const it of doc.items) {
            const def = getItemDef(it.defId);
            if (!def || (def.category !== "doors-windows" && !def.cutsWall)) continue;
            
            const apx = it.x - w.a.x;
            const apz = it.z - w.a.z;
            const t = (apx * w.dir.x + apz * w.dir.z) / w.length;
            if (t < -0.05 || t > 1.05) continue;
            
            const cx = w.a.x + w.dir.x * w.length * t;
            const cz = w.a.z + w.dir.z * w.length * t;
            const d = Math.hypot(it.x - cx, it.z - cz);
            if (d > thickness * 2 + 0.08) continue;
            
            const itemW = it.w ?? def.w;
            const itemH = it.h ?? def.h;
            const y0 = it.y ?? def.elevation ?? 0;
            
            const start = Math.max(0.01, t * w.length - itemW / 2);
            const end = Math.min(w.length - 0.01, t * w.length + itemW / 2);
            if (end - start < 0.02) continue;
            
            const heightAt = (x: number) => hStart + (hEnd - hStart) * (x / w.length);
            const maxTop = Math.min(heightAt(start), heightAt(end)) - 0.04;
            const y1 = Math.min(y0 + itemH, maxTop);
            if (y1 - y0 < 0.02) continue;

            const hole = new THREE.Path();
            hole.moveTo(start, y0);
            hole.lineTo(end, y0);
            hole.lineTo(end, y1);
            hole.lineTo(start, y1);
            hole.closePath();
            outline.holes.push(hole);
        }

        const geo = new THREE.ExtrudeGeometry(outline, { depth: thickness, bevelEnabled: false });
        const paintFor = doc.surfaces.walls[String(w.index)] ?? doc.surfaces.walls.all ?? "paint-soft-chalk";
        const finish = getFinish(paintFor, "paint-soft-chalk");
        const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(finish.hex),
            roughness: finish.roughness ?? 0.9,
            side: THREE.DoubleSide,
        });
        const wallMesh = new THREE.Mesh(geo, mat);
        wallMesh.position.set(w.a.x, 0, w.a.z);
        wallMesh.rotation.y = -angle;
        scene.add(wallMesh);
    }

    // 3. Placed Items
    for (const it of doc.items) {
        const def = getItemDef(it.defId);
        if (!it || !def) continue;

        const w = it.w ?? def.w;
        const d = it.d ?? def.d;
        const h = it.h ?? def.h;
        const y = it.y ?? def.elevation ?? 0;

        let mesh: THREE.Object3D;

        if (def.category === "doors-windows") {
            const frameGeo = new THREE.BoxGeometry(w, h, 0.04);
            const frameMat = new THREE.MeshStandardMaterial({
                color: def.id.includes("window") ? 0xffffff : 0xdddddd,
                roughness: 0.5,
            });
            const frameMesh = new THREE.Mesh(frameGeo, frameMat);
            frameMesh.position.y = h / 2;

            if (def.id.includes("window")) {
                const glassGeo = new THREE.BoxGeometry(w - 0.08, h - 0.08, 0.01);
                const glassMat = new THREE.MeshStandardMaterial({
                    color: 0x90caf9,
                    transparent: true,
                    opacity: 0.4,
                    roughness: 0.1,
                });
                const glassMesh = new THREE.Mesh(glassGeo, glassMat);
                frameMesh.add(glassMesh);
            }
            mesh = frameMesh;
        } else {
            const group = new THREE.Group();

            if (def.category === "cabinets") {
                const isWall = def.mount === "wall";
                const isTall = h > 1.5;
                const bodyH = isTall || isWall ? h : h - 0.04;

                const cabFinish = it.finishes?.cabinet ?? def.finishes?.cabinet ?? "cab-white";
                const cabColor = getFinish(cabFinish, "cab-white").hex;
                const bodyGeo = new THREE.BoxGeometry(w, bodyH, d);
                const bodyMat = new THREE.MeshStandardMaterial({
                    color: new THREE.Color(cabColor),
                    roughness: 0.7,
                });
                const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
                bodyMesh.position.y = bodyH / 2;
                group.add(bodyMesh);

                if (!isWall && !isTall) {
                    const counterFinish = it.finishes?.counter ?? def.finishes?.counter ?? "counter-quartz-white";
                    const counterColor = getFinish(counterFinish, "counter-quartz-white").hex;
                    const counterGeo = new THREE.BoxGeometry(w + 0.01, 0.04, d + 0.01);
                    const counterMat = new THREE.MeshStandardMaterial({
                        color: new THREE.Color(counterColor),
                        roughness: 0.3,
                    });
                    const counterMesh = new THREE.Mesh(counterGeo, counterMat);
                    counterMesh.position.y = h - 0.02;
                    group.add(counterMesh);
                }
            } else if (def.category === "appliances") {
                const bodyGeo = new THREE.BoxGeometry(w, h, d);
                const appFinish = it.finishes?.metal ?? def.finishes?.metal ?? "metal-stainless";
                const appColor = getFinish(appFinish, "metal-stainless").hex;
                const isStainless = appColor === "#888888" || appFinish.includes("stainless");
                const bodyMat = new THREE.MeshStandardMaterial({
                    color: new THREE.Color(appColor),
                    roughness: isStainless ? 0.35 : 0.6,
                    metalness: isStainless ? 0.8 : 0.1,
                });
                const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
                bodyMesh.position.y = h / 2;
                group.add(bodyMesh);
            } else if (def.category === "furniture") {
                const bodyGeo = new THREE.BoxGeometry(w, h, d);
                const fabFinish = it.finishes?.fabric ?? def.finishes?.fabric ?? "fab-oat";
                const fabColor = getFinish(fabFinish, "fab-oat").hex;
                const bodyMat = new THREE.MeshStandardMaterial({
                    color: new THREE.Color(fabColor),
                    roughness: 0.9,
                });
                const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
                bodyMesh.position.y = h / 2;
                group.add(bodyMesh);
            } else {
                const bodyGeo = new THREE.BoxGeometry(w, h, d);
                const bodyMat = new THREE.MeshStandardMaterial({
                    color: 0xcccccc,
                    roughness: 0.6,
                });
                const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
                bodyMesh.position.y = h / 2;
                group.add(bodyMesh);
            }
            mesh = group;
        }

        mesh.position.set(it.x, y, it.z);
        mesh.rotation.y = it.rotation;
        scene.add(mesh);
    }

    // 4. Export to USDZ
    const exporter = new USDZExporter();
    let arrayBuffer: any;
    try {
        arrayBuffer = await exporter.parseAsync(scene);
    } catch (e) {
        console.error("USDZExporter parse failed:", e);
        return null;
    }

    const buffer = Buffer.from(arrayBuffer);

    // 5. Upload to Supabase Storage
    const supabase = getSupabase();
    if (!supabase) {
        console.error("Supabase client not configured");
        return null;
    }

    const storagePath = room.projectId
        ? `projects/${room.projectId}/rooms/${room.id}.usdz`
        : `leads/${room.leadId}/rooms/${room.id}.usdz`;

    console.log(`Uploading USDZ export to Supabase: ${storagePath} (${buffer.byteLength} bytes)...`);
    const { error: uploadError } = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, buffer, {
        contentType: "model/vnd.usdz+zip",
        upsert: true,
    });

    if (uploadError) {
        console.error("Supabase upload failed:", uploadError);
        return null;
    }

    const { data: urlData } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(storagePath);
    const url = urlData.publicUrl;

    // Update RoomDesign
    await prisma.roomDesign.update({
        where: { id: roomId },
        data: { scanUsdzUrl: url },
    });

    // 6. Mirror to Google Drive if lead room
    if (room.leadId) {
        try {
            const { mirrorUrlToLeadFolder } = await import("@/lib/lead-drive");
            await mirrorUrlToLeadFolder({
                leadId: room.leadId,
                url,
                name: `${room.name}.usdz`,
                mimeType: "model/vnd.usdz+zip",
            });
            console.log(`USDZ mirrored to Google Drive folder for lead: ${room.leadId}`);
        } catch (driveErr) {
            console.warn("Mirroring USDZ to lead folder failed:", driveErr);
        }
    }

    return url;
}
