"use client";

import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { X } from "lucide-react";
import { usePermissions } from "@/components/PermissionsProvider";
import FieldUpdatesNavItem from "@/components/FieldUpdatesNavItem";
import { NAV_ITEMS } from "@/components/nav/navItems";
import SearchPanel from "@/components/nav/SearchPanel";
import { useNavDrawer } from "@/components/nav/navDrawerStore";

// Off-canvas navigation for iPad-portrait + phones (< lg). The desktop rail
// (Sidebar) is hidden at these widths. Built on Radix Dialog for focus-trap,
// body scroll-lock, Esc + overlay-click close, and aria-modal semantics.
export default function MobileNavDrawer() {
  const open = useNavDrawer((s) => s.open);
  const setOpen = useNavDrawer((s) => s.setOpen);
  const { permissions, loaded } = usePermissions();
  const can = (key: string) => !!permissions[key];
  const pathname = usePathname();

  // Close on navigation (belt-and-suspenders with onNavigate on the links).
  useEffect(() => {
    setOpen(false);
  }, [pathname, setOpen]);

  const close = () => setOpen(false);
  const projects = NAV_ITEMS.find((i) => i.key === "projects")!;
  const isActive = (href: string) => pathname === href || pathname?.startsWith(href + "/");

  const rowClass = (href: string) =>
    `flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition ${
      isActive(href) ? "bg-[#2a2a2a] text-white" : "text-slate-300 hover:bg-[#2a2a2a] hover:text-white"
    }`;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="lg:hidden fixed inset-0 z-[60] bg-black/50 data-[state=open]:[animation:nav-overlay-in_200ms_ease-out]" />
        <Dialog.Content
          className="lg:hidden fixed left-0 top-0 z-[60] h-[100dvh] w-72 max-w-[85vw] bg-hui-sidebar text-white flex flex-col shadow-xl focus:outline-none pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] data-[state=open]:[animation:nav-drawer-in_200ms_ease-out]"
        >
          <Dialog.Title className="sr-only">Navigation</Dialog.Title>

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 flex-none">
            <Link href="/" onClick={close} className="flex items-center gap-2">
              <div className="w-8 h-8 bg-hui-primary rounded-md flex items-center justify-center font-bold">G</div>
              <span className="font-semibold">GTR Pro</span>
            </Link>
            <Dialog.Close className="p-2 -mr-2 text-slate-300 hover:text-white" aria-label="Close navigation">
              <X className="w-5 h-5" />
            </Dialog.Close>
          </div>

          {/* Primary nav */}
          <nav className="p-2 space-y-1 flex-none">
            <Link href={projects.href} onClick={close} className={rowClass(projects.href)}>
              <projects.Icon className="w-5 h-5 shrink-0" />
              <span>{projects.label}</span>
            </Link>
            {loaded &&
              NAV_ITEMS.filter((item) => item.key !== "projects" && item.show(can)).map((item) =>
                item.custom === "fieldUpdates" ? (
                  <FieldUpdatesNavItem key={item.key} variant="drawer" onNavigate={close} />
                ) : (
                  <Link key={item.key} href={item.href} onClick={close} className={rowClass(item.href)}>
                    <item.Icon className="w-5 h-5 shrink-0" />
                    <span>{item.label}</span>
                  </Link>
                )
              )}
          </nav>

          {/* Search + deep links (mirrors the desktop flyout) */}
          <div className="flex-1 min-h-0 flex flex-col bg-slate-50 text-slate-800 border-t border-white/10">
            <SearchPanel onNavigate={close} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
