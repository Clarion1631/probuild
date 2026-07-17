"use client";

import { create } from "zustand";

// Shared open/close state for the mobile nav drawer. The hamburger lives in
// Header.tsx and the drawer in MobileNavDrawer.tsx — they're separate layout
// regions, so a tiny module-level store (no provider) is the simplest bridge.
// Mirrors the house zustand pattern in components/studio/store.ts.
interface NavDrawerState {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
}

export const useNavDrawer = create<NavDrawerState>((set) => ({
  open: false,
  setOpen: (v) => set({ open: v }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
