/**
 * MoveToJobModal, rendered for real (PR #534 R2/R3 follow-up, Codex xhigh
 * post-merge review): it moved onto Radix Dialog for a genuine focus trap
 * and an inert background, which the plain hand-rolled `<div role="dialog">`
 * it replaced never had.
 *
 * ITS OWN FILE, and that is load-bearing, not stylistic. Radix's
 * `@radix-ui/react-use-layout-effect` decides, ONCE, at module-IMPORT time,
 * whether `globalThis.document` exists yet:
 *
 *     var useLayoutEffect2 = globalThis?.document ? React.useLayoutEffect : () => {};
 *
 * If it does not, every Radix primitive built on it (Presence, FocusScope,
 * DismissableLayer -- the whole Dialog) permanently loses its mount/focus
 * setup for the rest of THIS PROCESS. No jsdom `document` swapped in later
 * undoes it; the no-op closed over the answer at import time. Tried inline
 * in tests/qbo-expense-sync-ui.test.tsx first: that file's own top-level
 * `import ExpensesTab` pulls in MoveToJobModal (and so Radix) before any
 * test runs, in the plain Node environment with no `document` at all --
 * the dialog rendered nothing, silently, every time.
 *
 * `before()` installs a throwaway jsdom `document` and imports
 * MoveToJobModal ONCE, dynamically, to force that decision the right way --
 * this file never imports ExpensesTab, so nothing else can load Radix
 * earlier and force it the wrong way. Not a top-level `await import`: this
 * file compiles to CJS (same as the rest of this suite), which does not
 * support top-level await at all.
 *
 * EACH TEST then gets its OWN fresh jsdom document, installed and torn down
 * around just that test (withJsdomGlobals). Radix's own real
 * `useLayoutEffect` (now locked in) reads `document` at CALL time, not at
 * import time, so it follows each test's swap correctly -- only the
 * INITIAL decision in `before()` needed a document to exist at all. A
 * shared, file-lifetime document was tried first and is why this comment
 * exists: two Dialogs sharing one DOM tree and one `useId()` sequence
 * across sequential tests fed Radix's focus guards stale nodes from the
 * previous test, and the second test hung for a full minute before an
 * out-of-memory crash. Fresh per test avoids that category of bug entirely.
 *
 * No mock.module: CI is Node 20.
 */
import assert from "node:assert/strict";
import test, { before } from "node:test";
import type { ComponentType } from "react";

// The repo ships jsdom without its optional declaration package (same
// adapter as tests/time-entry-void-control.test.tsx and
// tests/qbo-expense-sync-ui.test.tsx). A plain `require`, not a hoisted
// `import`: it has to run before the dynamic `import()` calls below, in
// file order, and `require` is what actually gives that guarantee.
const { JSDOM } = require("jsdom") as { JSDOM: new (html: string, options?: { url: string }) => { window: Window & typeof globalThis } };

/**
 * Radix's internals (FocusScope, DismissableLayer, Presence, the
 * `aria-hidden` package) reach for a much fuller browser global surface than
 * a plain hand-rolled div ever needed: MutationObserver, getComputedStyle,
 * NodeFilter, every HTML*Element constructor, and more. Rather than chasing
 * each one by name as Radix's internals change, this copies every
 * CLASS/CONSTRUCTOR-shaped global from jsdom's `window` -- own-property
 * names starting with an uppercase letter -- plus the one lowercase function
 * actually needed. Deliberately NOT a blind full copy: jsdom's own
 * `queueMicrotask` recurses into itself once assigned onto `globalThis`
 * (and other timer/scheduling globals likely would too), so only
 * class-shaped globals are taken.
 */
async function withJsdomGlobals<T>(dom: InstanceType<typeof JSDOM>, fn: () => Promise<T>): Promise<T> {
    const extraLowercase = new Set(["getComputedStyle"]);
    const names = Object.getOwnPropertyNames(dom.window).filter(
        (key) => /^[A-Z]/.test(key) || extraLowercase.has(key),
    );
    names.push("window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT");
    const saved = new Map<string, PropertyDescriptor | undefined>();
    for (const key of new Set(names)) {
        try {
            saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
            const value = key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as any)[key];
            Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        } catch {
            // Non-configurable globals (Infinity, NaN) -- fine to skip.
        }
    }
    try {
        return await fn();
    } finally {
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
    }
}

let ImportedAwareMoveToJobModal: ComponentType<Record<string, unknown>>;
let RECEIPT_EXPENSE_DOUBLE_NOTE: string;
let createElement: typeof import("react").createElement;
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;

before(async () => {
    // A throwaway document, just to force @radix-ui/react-use-layout-effect's
    // real-vs-no-op decision the right way, once, for the whole process (see
    // the file header). Not kept: each test below installs its own.
    const bootstrapDom = new JSDOM("<!doctype html>");
    await withJsdomGlobals(bootstrapDom, async () => {
        const moveToJobModalModule = await import("../src/app/projects/[id]/time-expenses/MoveToJobModal");
        const bookedExpenseRulesModule = await import("../src/lib/receipt-intake/booked-expense-rules");
        const reactModule = await import("react");
        const reactDomClientModule = await import("react-dom/client");
        ImportedAwareMoveToJobModal = moveToJobModalModule.default as unknown as ComponentType<Record<string, unknown>>;
        RECEIPT_EXPENSE_DOUBLE_NOTE = bookedExpenseRulesModule.RECEIPT_EXPENSE_DOUBLE_NOTE;
        createElement = reactModule.createElement;
        act = reactModule.act;
        createRoot = reactDomClientModule.createRoot;
    });
    bootstrapDom.window.close();
});

test("MoveToJobModal: title, double note, Shop help, current job absent, Move disabled", async () => {
    const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://example.test" });
    let markup = "";
    try {
        await withJsdomGlobals(dom, async () => {
            const root = createRoot(dom.window.document.getElementById("root")!);
            try {
                await act(async () => {
                    root.render(createElement(ImportedAwareMoveToJobModal, {
                        expenseId: "exp-receipt",
                        vendor: "Lowe's",
                        amountLabel: "$146.32",
                        dateLabel: "9/2/2026",
                        changeOrderLabel: null,
                        projectId: "job-1",
                        jobOptions: [
                            { id: "job-1", name: "Sample Job A" },
                            { id: "job-2", name: "Sample Job B" },
                            { id: "shop-id", name: "Shop" },
                        ],
                        onClose: () => {},
                        onMoved: async () => {},
                    }));
                });
                // Dialog.Portal renders into document.body, a sibling of #root.
                markup = dom.window.document.body.innerHTML;
            } finally {
                await act(async () => { root.unmount(); });
            }
        });
    } finally {
        dom.window.close();
    }

    assert.match(markup, />Move to another job</);
    // A real DOM's innerHTML does not entity-escape apostrophes in text
    // content the way React's SSR string renderer does.
    const escapedNote = RECEIPT_EXPENSE_DOUBLE_NOTE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(markup, new RegExp(escapedNote));
    assert.match(markup, /Pick Shop if it isn't a job cost\./);

    // The current job (job-1) is absent from the options; Shop is present.
    assert.doesNotMatch(markup, />Sample Job A</);
    assert.match(markup, />Sample Job B</);
    assert.match(markup, />Shop</);

    // Move is disabled until a job is picked.
    const moveAt = markup.indexOf(">Move<");
    assert.ok(moveAt > -1, "the Move button (not yet clicked, so not \"Moving…\") must render");
    const buttonStart = markup.lastIndexOf("<button", moveAt);
    assert.match(markup.slice(buttonStart, moveAt), /disabled/);
});

test("MoveToJobModal: dialog semantics, focus enters on open and returns to the trigger on close, Escape cancels", async () => {
    const dom = new JSDOM(
        "<!doctype html><button id='trigger'>Move to job</button><div id='root'></div>",
        { url: "https://example.test" },
    );
    try {
        await withJsdomGlobals(dom, async () => {
            const trigger = dom.window.document.getElementById("trigger") as HTMLButtonElement;
            trigger.focus();
            const root = createRoot(dom.window.document.getElementById("root")!);
            let closes = 0;
            try {
                await act(async () => {
                    root.render(createElement(ImportedAwareMoveToJobModal, {
                        expenseId: "exp-receipt", vendor: "Lowe's", amountLabel: "$146.32", dateLabel: "9/2/2026",
                        changeOrderLabel: null, projectId: "job-1",
                        jobOptions: [{ id: "job-2", name: "Sample Job B" }],
                        onClose: () => { closes++; },
                        onMoved: async () => {},
                    }));
                });

                const dialog = dom.window.document.querySelector('[role="dialog"]');
                assert.ok(dialog, "renders with role=dialog");
                assert.equal(dialog!.getAttribute("aria-modal"), "true");
                const labelledBy = dialog!.getAttribute("aria-labelledby");
                assert.ok(labelledBy, "aria-labelledby is set");
                assert.equal(dom.window.document.getElementById(labelledBy!)?.textContent, "Move to another job");
                // Radix's FocusScope focuses the first TABBABLE candidate inside the
                // container (here, the job <select>), falling back to the container
                // itself only when there is no candidate to move to -- unlike the old
                // hand-rolled `<div tabIndex={-1}>` this replaced, which always focused
                // itself unconditionally. Asserting containment (not equality to the
                // container) matches Radix's real, working-as-designed behavior.
                //
                // `assert.ok` on a precomputed boolean, not `assert.equal` on the two
                // raw nodes: a jsdom Element carries React's fiber tree on hidden
                // `__reactFiber$…`/`__reactProps$…` properties, a huge, circular object
                // graph. `assert.equal` builds a diff of its two arguments when they are
                // NOT equal, and diffing that graph is what actually hung this process
                // for ~50s and then crashed it with `RangeError: Array buffer allocation
                // failed` when this assertion's premise (equal to the CONTAINER) was
                // wrong under the new Radix implementation. A boolean has nothing to diff.
                assert.ok(dialog!.contains(dom.window.document.activeElement), "focus moved inside the dialog on open");
                assert.equal(
                    (dom.window.document.activeElement as HTMLElement | null)?.tagName,
                    "SELECT",
                    "the first tabbable control (the job select) gets focus, not the dialog container",
                );

                await act(async () => {
                    dialog!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
                });
                assert.equal(closes, 1, "Escape triggers onClose, same as Cancel");

                await act(async () => { root.unmount(); });
                // Same reasoning as the dialog-containment check above: a boolean, not
                // a raw-node `assert.equal`, so a future regression here fails fast
                // instead of hanging on a fiber-graph diff.
                assert.ok(dom.window.document.activeElement === trigger, "focus returns to the trigger once closed");
            } finally {
                await act(async () => { try { root.unmount(); } catch { /* already unmounted */ } });
            }
        });
    } finally {
        dom.window.close();
    }
});
