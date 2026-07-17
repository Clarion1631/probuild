"use client";

// Room Studio - room list for a project or lead: thumbnails, create-from-
// template modal, rename, delete.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, X, Home } from "lucide-react";
import { toast } from "sonner";
import { ROOM_TEMPLATES, type RoomType } from "@/lib/studio/templates";

interface RoomRow {
  id: string;
  name: string;
  roomType: string;
  thumbnail: string | null;
  updatedAt: string;
}

export interface RoomListProps {
  ownerKind: "project" | "lead";
  ownerId: string;
}

const ROOM_TYPE_OPTIONS: Array<{ value: RoomType; label: string }> = [
  { value: "kitchen", label: "Kitchen" },
  { value: "bathroom", label: "Bathroom" },
  { value: "laundry", label: "Laundry" },
  { value: "bedroom", label: "Bedroom" },
  { value: "outdoor", label: "Outdoor / Patio" },
  { value: "other", label: "Living / Other" },
];

export function RoomList({ ownerKind, ownerId }: RoomListProps) {
  const router = useRouter();
  const [rooms, setRooms] = useState<RoomRow[] | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const basePath = `/${ownerKind === "project" ? "projects" : "leads"}/${ownerId}/room-designer`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/rooms?${ownerKind === "project" ? "projectId" : "leadId"}=${ownerId}`);
      if (!res.ok) throw new Error(String(res.status));
      setRooms(await res.json());
    } catch {
      setRooms([]);
      toast.error("Couldn't load rooms");
    }
  }, [ownerKind, ownerId]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (room: RoomRow) => {
    if (!window.confirm(`Delete "${room.name}"? This can't be undone.`)) return;
    const res = await fetch(`/api/rooms/${room.id}`, { method: "DELETE" });
    if (res.ok) {
      setRooms((rs) => (rs ?? []).filter((r) => r.id !== room.id));
      toast.success("Room deleted");
    } else {
      toast.error("Couldn't delete room");
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Room Designer</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Lay out kitchens, baths, living spaces, and outdoor areas in 3D - then share them with your client.
          </p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          New Room
        </button>
      </div>

      {rooms === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-48 animate-pulse rounded-2xl bg-slate-100" />
          ))}
        </div>
      ) : rooms.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-white px-6 py-14 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-blue-50">
            <Home className="h-6 w-6 text-blue-500" />
          </div>
          <h3 className="text-base font-bold text-slate-800">No rooms yet</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">
            Start from a fully-furnished template - kitchens, baths, living rooms - or an empty room.
          </p>
          <button
            onClick={() => setModalOpen(true)}
            className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700"
          >
            + New Room
          </button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rooms.map((room) => (
            <div
              key={room.id}
              className="group relative cursor-pointer overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
              onClick={() => router.push(`${basePath}/${room.id}`)}
            >
              {room.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={room.thumbnail} alt={room.name} className="h-36 w-full bg-slate-100 object-cover" />
              ) : (
                <div className="flex h-36 w-full items-center justify-center bg-gradient-to-br from-slate-50 to-slate-200 text-slate-300">
                  <Home className="h-8 w-8" />
                </div>
              )}
              <div className="flex items-center justify-between p-3.5">
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold text-slate-800">{room.name}</div>
                  <div className="text-[11px] capitalize text-slate-400">
                    {room.roomType} - updated {new Date(room.updatedAt).toLocaleDateString()}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(room);
                  }}
                  className="rounded-lg p-2 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:bg-red-50 hover:text-red-500 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:outline-none [@media(hover:none)]:opacity-100"
                  title="Delete room"
                  aria-label={"Delete " + room.name}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modalOpen && (
        <CreateRoomModal
          ownerKind={ownerKind}
          ownerId={ownerId}
          onClose={() => setModalOpen(false)}
          onCreated={(roomId) => router.push(`${basePath}/${roomId}`)}
        />
      )}
    </div>
  );
}

function CreateRoomModal({
  ownerKind, ownerId, onClose, onCreated,
}: {
  ownerKind: "project" | "lead";
  ownerId: string;
  onClose: () => void;
  onCreated: (roomId: string) => void;
}) {
  const [name, setName] = useState("");
  const [roomType, setRoomType] = useState<RoomType>("kitchen");
  const [templateKey, setTemplateKey] = useState<string>("kitchen_l");
  const [busy, setBusy] = useState(false);

  const templates = Object.values(ROOM_TEMPLATES);
  const selected = templateKey ? ROOM_TEMPLATES[templateKey] : null;
  const effectiveType = selected?.roomType ?? roomType;

  const create = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim() || selected?.label || "New Room",
        roomType: effectiveType,
      };
      if (ownerKind === "project") body.projectId = ownerId;
      else body.leadId = ownerId;
      if (templateKey) body.templateKey = templateKey;
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      const room = await res.json();
      onCreated(room.id);
    } catch {
      toast.error("Couldn't create room");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-800">New Room</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:outline-none"
            title="Close"
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mb-1 block text-xs font-semibold text-slate-500">Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={selected?.label ?? "Kitchen"}
          className="mb-3 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
        />

        <label className="mb-1 block text-xs font-semibold text-slate-500">Start from</label>
        <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto pb-1">
          <TemplateCard
            label="Empty room"
            sub="12' x 10' blank canvas"
            active={templateKey === ""}
            onClick={() => setTemplateKey("")}
          />
          {templates.map((t) => (
            <TemplateCard
              key={t.key}
              label={t.label}
              sub={`${t.widthFt}' x ${t.lengthFt}' - ${t.description}`}
              active={templateKey === t.key}
              onClick={() => setTemplateKey(t.key)}
            />
          ))}
        </div>

        {!templateKey && (
          <div className="mt-3">
            <label className="mb-1 block text-xs font-semibold text-slate-500">Room type</label>
            <select
              value={roomType}
              onChange={(e) => setRoomType(e.target.value as RoomType)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
            >
              {ROOM_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-semibold text-slate-500 hover:bg-slate-100">
            Cancel
          </button>
          <button
            onClick={create}
            disabled={busy}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? "Creating..." : "Create Room"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TemplateCard({ label, sub, active, onClick }: {
  label: string; sub: string; active: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border p-3 text-left transition ${
        active ? "border-blue-500 bg-blue-50 ring-2 ring-blue-200" : "border-slate-200 hover:border-slate-300"
      }`}
    >
      <div className="text-xs font-bold text-slate-800">{label}</div>
      <div className="mt-0.5 text-[10.5px] leading-snug text-slate-400">{sub}</div>
    </button>
  );
}
