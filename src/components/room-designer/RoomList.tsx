"use client";

// Card grid listing all rooms for a project or lead. Shared by both the
// /projects/[id]/room-designer and /leads/[id]/room-designer pages.
//
// "New Room" opens a small inline modal (name + roomType). We keep it in this
// file so the server pages remain tiny and focused on data loading.

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { RoomType } from "./types";

interface RoomSummary {
    id: string;
    name: string;
    roomType: string;
    thumbnail: string | null;
    createdAt: string | Date;
    updatedAt: string | Date;
}

interface RoomListProps {
    rooms: RoomSummary[];
    ownerType: "project" | "lead";
    ownerId: string;
}

const ROOM_TYPE_OPTIONS: { value: RoomType; label: string }[] = [
    { value: "kitchen", label: "Kitchen" },
    { value: "bathroom", label: "Bathroom" },
    { value: "laundry", label: "Laundry" },
    { value: "bedroom", label: "Bedroom" },
    { value: "other", label: "Other" },
];

const ROOM_TYPE_COLOR: Record<string, string> = {
    kitchen: "#c9a06b",
    bathroom: "#9cc7e8",
    laundry: "#b7c3cf",
    bedroom: "#d8b8a1",
    other: "#bcbcbc",
};

const ROOM_TYPE_ICON: Record<string, string> = {
    kitchen: "🍳",
    bathroom: "🚿",
    laundry: "🧺",
    bedroom: "🛏️",
    other: "🏠",
};

export function RoomList({ rooms, ownerType, ownerId }: RoomListProps) {
    const router = useRouter();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [name, setName] = useState("");
    const [roomType, setRoomType] = useState<RoomType>("kitchen");
    const [creating, setCreating] = useState(false);
    const [, startTransition] = useTransition();

    const basePath = ownerType === "project" ? `/projects/${ownerId}/room-designer` : `/leads/${ownerId}/room-designer`;

    async function handleCreate(e: React.FormEvent) {
        e.preventDefault();
        if (!name.trim()) return;
        setCreating(true);
        try {
            const body: Record<string, string> = { name: name.trim(), roomType };
            if (ownerType === "project") body.projectId = ownerId;
            else body.leadId = ownerId;
            const res = await fetch("/api/rooms", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(await res.text());
            const created = await res.json();
            toast.success("Room created");
            setIsModalOpen(false);
            setName("");
            router.push(`${basePath}/${created.id}`);
        } catch (err) {
            toast.error("Couldn't create room");
            // eslint-disable-next-line no-console
            console.error(err);
        } finally {
            setCreating(false);
        }
    }

    async function handleDelete(roomId: string) {
        if (!confirm("Delete this room? This cannot be undone.")) return;
        try {
            const res = await fetch(`/api/rooms/${roomId}`, { method: "DELETE" });
            if (!res.ok) throw new Error(await res.text());
            toast.success("Room deleted");
            startTransition(() => router.refresh());
        } catch (err) {
            toast.error("Couldn't delete room");
            // eslint-disable-next-line no-console
            console.error(err);
        }
    }

    return (
        <div className="max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-hui-textMain">Room Designer</h1>
                    <p className="text-sm text-hui-textMuted mt-1">
                        Lay out kitchens, baths, and other rooms in 3D.
                    </p>
                </div>
                <button onClick={() => setIsModalOpen(true)} className="hui-btn hui-btn-green">
                    + New Room
                </button>
            </div>

            {rooms.length === 0 ? (
                <div className="hui-card p-10 text-center">
                    <div className="text-4xl mb-3">🏠</div>
                    <h2 className="text-lg font-semibold text-slate-900 mb-1">No rooms yet</h2>
                    <p className="text-sm text-slate-500 mb-4">
                        Create your first room to start laying out cabinets, appliances, and fixtures.
                    </p>
                    <button onClick={() => setIsModalOpen(true)} className="hui-btn hui-btn-green">
                        + New Room
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {rooms.map((room) => (
                        <div
                            key={room.id}
                            className="hui-card group flex flex-col overflow-hidden transition hover:shadow-md"
                        >
                            <Link href={`${basePath}/${room.id}`} className="block">
                                {room.thumbnail ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                        src={room.thumbnail}
                                        alt={room.name}
                                        className="aspect-video w-full object-cover"
                                    />
                                ) : (
                                    <div
                                        className="flex aspect-video w-full items-center justify-center text-5xl"
                                        style={{ backgroundColor: ROOM_TYPE_COLOR[room.roomType] ?? "#bcbcbc" }}
                                    >
                                        <span className="drop-shadow-sm">
                                            {ROOM_TYPE_ICON[room.roomType] ?? "🏠"}
                                        </span>
                                    </div>
                                )}
                            </Link>
                            <div className="flex items-center justify-between p-4">
                                <div className="min-w-0 flex-1">
                                    <Link href={`${basePath}/${room.id}`}>
                                        <h3 className="truncate text-sm font-semibold text-slate-900 hover:underline">
                                            {room.name}
                                        </h3>
                                    </Link>
                                    <p className="text-xs capitalize text-slate-500">
                                        {room.roomType} · Edited {new Date(room.updatedAt).toLocaleDateString()}
                                    </p>
                                </div>
                                <button
                                    onClick={() => handleDelete(room.id)}
                                    className="ml-2 rounded-md p-1.5 text-slate-400 opacity-0 pointer-events-none transition group-hover:opacity-100 group-hover:pointer-events-auto [@media(hover:none)]:opacity-100 [@media(hover:none)]:pointer-events-auto hover:bg-red-50 hover:text-red-600"
                                    title="Delete room"
                                    aria-label="Delete room"
                                >
                                    🗑
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {isModalOpen && (
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
                    onClick={() => setIsModalOpen(false)}
                >
                    <form
                        onSubmit={handleCreate}
                        onClick={(e) => e.stopPropagation()}
                        className="hui-card w-full max-w-md space-y-4 p-6"
                    >
                        <h2 className="text-lg font-semibold text-slate-900">New Room</h2>
                        <div>
                            <label className="mb-1 block text-xs font-medium text-slate-700">Name</label>
                            <input
                                autoFocus
                                className="hui-input w-full"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Master Bathroom"
                                required
                                maxLength={120}
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-xs font-medium text-slate-700">Room type</label>
                            <select
                                className="hui-input w-full"
                                value={roomType}
                                onChange={(e) => setRoomType(e.target.value as RoomType)}
                            >
                                {ROOM_TYPE_OPTIONS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="flex justify-end gap-2 pt-2">
                            <button
                                type="button"
                                onClick={() => setIsModalOpen(false)}
                                className="hui-btn hui-btn-secondary"
                            >
                                Cancel
                            </button>
                            <button type="submit" disabled={creating} className="hui-btn hui-btn-green">
                                {creating ? "Creating…" : "Create Room"}
                            </button>
                        </div>
                    </form>
                </div>
            )}
        </div>
    );
}
