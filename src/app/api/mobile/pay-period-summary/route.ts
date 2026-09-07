
import { nonVoidedTimeEntryWhere } from "@/lib/time-entry-void";
import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/prisma-helpers";
import { authenticateMobileOrSession } from "@/lib/mobile-auth";
import { resolveCompanyTimeZone } from "@/lib/company-timezone";
import { createPayPeriodSummaryHandlers } from "@/lib/pay-period-summary-core";

export const dynamic = "force-dynamic";

// Production wiring only — see src/lib/pay-period-summary-core.ts for the
// route's actual logic and its documentation.
//
// mobile-auth.ts is a STATIC import here (not deferred) on purpose: it
// throws at MODULE LOAD if NEXTAUTH_SECRET is unset, and that fail-fast
// belongs at deployment/startup time, not first-request. The core logic
// lives in pay-period-summary-core.ts precisely so it — and
// createPayPeriodSummaryHandlers — can be imported by tests without ever
// touching mobile-auth.ts or requiring that secret.
const handlers = createPayPeriodSummaryHandlers({
    authenticate: async (req) => {
        const result = await authenticateMobileOrSession(req);
        if (!result.ok) return result;
        return { ok: true, user: { id: result.user.id, role: result.user.role } };
    },
    getUser: async (userId) => {
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, email: true, hourlyRate: true, burdenRate: true },
        });
        if (!user) return null;
        return {
            id: user.id,
            name: user.name,
            email: user.email,
            hourlyRate: toNum(user.hourlyRate),
            burdenRate: toNum(user.burdenRate),
        };
    },
    getTimeEntries: async (userId, rangeStart, rangeEnd) => {
        const entries = await prisma.timeEntry.findMany({
            where: nonVoidedTimeEntryWhere({ userId, startTime: { gte: rangeStart, lt: rangeEnd } }),
            select: { startTime: true, durationHours: true, laborCost: true, burdenCost: true },
            orderBy: { startTime: "asc" },
        });
        return entries.map((e) => ({
            startTime: e.startTime,
            durationHours: e.durationHours ?? 0,
            laborCost: e.laborCost != null ? toNum(e.laborCost) : null,
            burdenCost: e.burdenCost != null ? toNum(e.burdenCost) : null,
        }));
    },
    resolveTimeZone: resolveCompanyTimeZone,
});

export const GET = handlers.GET;
