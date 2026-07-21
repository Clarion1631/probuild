import type { ReactNode } from "react";

// Single source of truth for the primary navigation, consumed by both the
// desktop icon rail (Sidebar.tsx) and the mobile drawer (MobileNavDrawer.tsx).
// Icons are components so each surface can pass its own className (the rail
// stacks icon+label vertically; the drawer lays them out as horizontal rows).

type IconProps = { className?: string };

const svg = (children: ReactNode) => ({ className }: IconProps) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    {children}
  </svg>
);

const DashboardIcon = svg(
  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
);
const ProjectsIcon = svg(
  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
);
const LeadsIcon = svg(
  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
);
const FinancialsIcon = svg(
  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
);
const ReportsIcon = svg(
  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
);
const TimeClockIcon = svg(
  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
);
const CompanyIcon = svg(
  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
);
const TasksIcon = svg(
  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-5 9l2 2 4-4" />
);
const SettingsIcon = svg(
  <>
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </>
);

export type NavItem = {
  key: string;
  href: string;
  label: string;
  Icon: (props: IconProps) => ReactNode;
  /** Returns whether the current user can see this item. */
  show: (can: (key: string) => boolean) => boolean;
  /** Special-cased renderers (e.g. the Field Updates item has a live unread badge). */
  custom?: "fieldUpdates";
};

export const NAV_ITEMS: NavItem[] = [
  { key: "dashboard", href: "/company-dashboard", label: "Dashboard", Icon: DashboardIcon, show: (can) => can("financialReports") },
  // Projects is always visible (the API filters by ProjectAccess).
  { key: "projects", href: "/projects", label: "Projects", Icon: ProjectsIcon, show: () => true },
  { key: "leads", href: "/leads", label: "Leads", Icon: LeadsIcon, show: (can) => can("leadAccess") },
  { key: "tasks", href: "/tasks", label: "Tasks", Icon: TasksIcon, show: (can) => can("manageTeamMembers") },
  { key: "financials", href: "/invoices", label: "Financials", Icon: FinancialsIcon, show: (can) => can("invoices") || can("financialReports") },
  { key: "reports", href: "/reports", label: "Reports", Icon: ReportsIcon, show: (can) => can("financialReports") },
  { key: "field", href: "/manager/field-updates", label: "Field", Icon: ReportsIcon, show: (can) => can("schedules"), custom: "fieldUpdates" },
  { key: "timeclock", href: "/time-clock", label: "Time Clock", Icon: TimeClockIcon, show: (can) => can("timeClock") },
  { key: "company", href: "/company/team-members", label: "Company", Icon: CompanyIcon, show: (can) => can("manageTeamMembers") || can("companySettings") },
  { key: "settings", href: "/settings/company", label: "Settings", Icon: SettingsIcon, show: (can) => can("companySettings") },
];

export const SearchIcon = svg(
  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
);
