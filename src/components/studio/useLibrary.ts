"use client";

// Subscribes a component to the product library: triggers the one-time fetch
// and re-renders when the registries fill in.

import { useEffect, useSyncExternalStore } from "react";
import {
  ensureLibraryLoaded, getLibrary, getLibraryVersion, subscribeLibrary,
  type LibraryData,
} from "@/lib/studio/library";

export function useLibrary(): LibraryData {
  useEffect(() => {
    ensureLibraryLoaded();
  }, []);
  useSyncExternalStore(subscribeLibrary, getLibraryVersion, getLibraryVersion);
  return getLibrary();
}
