import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
// The repo ships jsdom without its optional declaration package. Keep this
// test adapter typed to the browser surface it exercises.
const { JSDOM } = require("jsdom") as { JSDOM: new (html: string, options: { url: string }) => { window: Window & typeof globalThis } };

test("manager confirms the exact rendered entry; invalid, pending and failed requests stay safe", async () => {
    const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://example.test" });
    const globals = ["window", "document", "HTMLElement", "HTMLDialogElement", "FormData", "IS_REACT_ACT_ENVIRONMENT"];
    const saved = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as any)[key] });
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event("close")); };
    const { createRoot } = await import("react-dom/client");
    const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
    const { default: VoidTimeEntryButton } = await import("../src/app/manager/time-entries/VoidTimeEntryButton");
    const root = createRoot(dom.window.document.getElementById("root")!);
    const originalFetch = globalThis.fetch;
    let refreshes = 0; const calls: Array<{ url: string; init: RequestInit }> = [];
    let finish!: (response: Response) => void;
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return new Promise(resolve => { finish = resolve; }); };
    const entry = { id: "entry-reviewed", employee: "Justin Adkins", project: "Shop", startTime: "2026-09-01T01:31:03.182Z", endTime: "2026-09-02T01:22:00.000Z", paidHours: 22.85, updatedAt: "2026-09-06T21:23:02.266Z" };
    const render = async (role: string, displayed = entry) => act(async () => { root.render(createElement(AppRouterContext.Provider, { value: { refresh: () => { refreshes++; } } as any }, createElement(VoidTimeEntryButton, { role, entry: displayed, timeZone: "America/Los_Angeles" }))); });
    try {
        await render("FIELD_CREW"); assert.equal(dom.window.document.querySelector("button"), null);
        await render("MANAGER");
        await act(async () => { dom.window.document.querySelector<HTMLButtonElement>("button")!.click(); });
        const dialog = dom.window.document.querySelector("dialog")!;
        assert.equal(dialog.open, true); assert.match(dialog.textContent!, /Justin Adkins/); assert.match(dialog.textContent!, /Shop/);
        assert.match(dialog.textContent!, /Aug 31, 2026/); assert.match(dialog.textContent!, /Sep 1, 2026/); assert.match(dialog.textContent!, /PDT/);
        const form = dialog.querySelector("form")!;
        const reason = form.querySelector("textarea")!; assert.equal(reason.value, "", "never invent a correction reason");
        const confirmation = form.querySelector<HTMLInputElement>("input[type=checkbox]")!;
        await render("MANAGER", { ...entry, updatedAt: "2026-09-07T05:00:00.000Z" });
        const submit = async () => act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
        reason.value = "  "; confirmation.checked = true; await submit(); assert.equal(calls.length, 0);
        reason.value = "Confirmed test"; confirmation.checked = false; await submit(); assert.equal(calls.length, 0);
        confirmation.checked = true; await submit(); assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "/api/time-entries/entry-reviewed/void");
        assert.equal(calls[0].init.credentials, "same-origin");
        assert.deepEqual(JSON.parse(String(calls[0].init.body)), { reason: "Confirmed test", expectedUpdatedAt: entry.updatedAt });
        await submit(); assert.equal(calls.length, 1, "pending submission cannot duplicate");
        await act(async () => { finish(Response.json({ error: "This entry changed. Refresh and review it." }, { status: 409 })); });
        assert.equal(dialog.open, true); assert.match(dialog.textContent!, /This entry changed/); assert.equal(refreshes, 0);
        assert.equal(reason.value, "Confirmed test", "failure preserves the entered reason");
        await submit(); await act(async () => { finish(Response.json({ id: entry.id, voidedAt: "2026-09-07T05:00:00Z" })); });
        assert.equal(dialog.open, false); assert.equal(refreshes, 1);
        assert.ok(!("Authorization" in (calls[0].init.headers as Record<string, string>)), "uses the real same-origin manager session");
    } finally {
        await act(async () => root.unmount()); globalThis.fetch = originalFetch;
        for (const key of globals) { const descriptor = saved.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
        dom.window.close();
    }
});
