import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type { ComponentType, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let sessionRole = "ADMIN";
let loaderViewerMode: "STAFF_PREVIEW" | "CLIENT" = "STAFF_PREVIEW";
let PortalChangeOrderPage: (input: {
    params: Promise<{ id: string }>;
}) => Promise<ReactElement>;
let originalRequire: typeof Module.prototype.require;

const sentChangeOrder = {
    id: "co-staff-preview",
    projectId: "project-1",
    code: "CO-00001",
    title: "Staff preview",
    description: null,
    status: "Sent",
    revision: 2,
    pricingType: "FIXED",
    createdAt: "2026-08-17T12:00:00.000Z",
    approvedAt: null,
    approvedBy: null,
    clientSignatureUrl: null,
    companySignatureUrl: null,
    companySignedBy: null,
    companySignedAt: null,
    items: [],
    paymentSchedules: [],
    estimate: null,
    project: {
        id: "project-1",
        name: "Kitchen Remodel",
        location: "Seattle, WA",
        client: { name: "Client Owner" },
    },
};

before(async () => {
    originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (
        this: NodeModule,
        id: string,
    ) {
        if (id === "@/lib/actions") {
            return {
                getChangeOrderForPortal: async () => ({ ...sentChangeOrder, portalViewerMode: loaderViewerMode }),
                getPublicCompanySettings: async () => ({ companyName: "Golden Touch Remodeling" }),
                getPortalVisibility: async () => ({ showChangeOrders: true }),
                approveChangeOrder: async () => {
                    throw new Error("the read-only staff preview must not expose an approval path");
                },
            };
        }
        if (id === "next-auth") {
            return {
                getServerSession: async () => ({
                    user: { email: "staff@example.com", role: sessionRole },
                }),
            };
        }
        if (id === "@/lib/auth") return { authOptions: {} };
        if (id === "@/lib/secure-storage") return { resolveDocUrl: async () => null };
        if (id === "@/lib/build-pdf") {
            return { buildPdf: async () => ({ save: () => undefined }) };
        }
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    const mod = await import("../src/app/portal/change-orders/[id]/page");
    PortalChangeOrderPage = mod.default as unknown as typeof PortalChangeOrderPage;
});

after(() => {
    Module.prototype.require = originalRequire;
});

for (const role of ["ADMIN", "MANAGER"]) {
    test(`${role} change-order portal preview renders as read-only without client signing controls`, async () => {
        sessionRole = role;
        loaderViewerMode = "STAFF_PREVIEW";

        const element = await PortalChangeOrderPage({
            params: Promise.resolve({ id: sentChangeOrder.id }),
        });
        const markup = renderToStaticMarkup(element);

        assert.match(markup, /Staff preview/i);
        assert.match(markup, /read.only/i);
        assert.match(markup, /Manual Approve/);
        assert.doesNotMatch(markup, /Sign &amp; Approve Change Order/);
        assert.doesNotMatch(markup, /Ready to Approve\?/);
    });
}

test("a non-staff client viewing the same Sent change order still receives the signing controls", async () => {
    sessionRole = "CLIENT";
    loaderViewerMode = "CLIENT";

    const element = await PortalChangeOrderPage({
        params: Promise.resolve({ id: sentChangeOrder.id }),
    });
    const markup = renderToStaticMarkup(element);

    assert.match(markup, /Ready to Approve\?/);
    assert.match(markup, /Sign &amp; Approve Change Order/);
    assert.doesNotMatch(markup, /Staff preview.+read.only/i);
});

test("the live loader's staff-preview mode wins over a stale client-looking JWT", async () => {
    sessionRole = "CLIENT";
    loaderViewerMode = "STAFF_PREVIEW";

    const element = await PortalChangeOrderPage({
        params: Promise.resolve({ id: sentChangeOrder.id }),
    });
    const markup = renderToStaticMarkup(element);

    assert.match(markup, /read.only/i);
    assert.doesNotMatch(markup, /Sign &amp; Approve Change Order/);
});
