/**
 * The new-expense form offers THIS JOB'S phases (Codex round 19, item 5).
 *
 * It was handed every active cost code in the company. The server refuses
 * anything that is not a phase of the job — so most of the options were errors,
 * and the ones that were not looked exactly the same. A picker that invites a
 * refusal is a bug in the picker, not in the person using it.
 *
 * The modal is rendered directly (the page client needs an app-router context
 * that a static render cannot provide), and the wiring test below pins that the
 * page actually hands it the scoped list.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ComponentType } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import NewExpenseEntryModal from "../src/app/projects/[id]/time-expenses/NewExpenseEntryModal";

const Modal = NewExpenseEntryModal as unknown as ComponentType<Record<string, unknown>>;

/** Every active code in the company — two of them belong to another job. */
const COMPANY_CODES = [
    { id: "cc-plumb", code: "03-PLUMB", name: "Plumbing" },
    { id: "cc-frame", code: "02-FRAME", name: "Framing" },
    { id: "cc-roof", code: "07-ROOF", name: "Roofing" },
];

/** ...and only one of them is a phase of THIS job. */
const PROJECT_PHASES = [{ id: "cc-plumb", code: "03-PLUMB", name: "Plumbing" }];

function render(costCodes: { id: string; code: string; name: string }[]) {
    return renderToStaticMarkup(createElement(Modal, {
        projectId: "job-1",
        estimates: [{ id: "est-1", title: "EST-1", items: [] }],
        costCodes,
        costTypes: [],
        companyTimeZone: "America/Los_Angeles",
        changeOrders: [],
        onClose: () => {},
    }));
}

test("the phase picker offers exactly what it was given", () => {
    const markup = render(PROJECT_PHASES);
    assert.ok(markup.includes("03-PLUMB"), "this job's phase is offered");
    assert.ok(!markup.includes("07-ROOF"), "a phase of another job must not be");
    assert.ok(!markup.includes("02-FRAME"), "nor one this job does not carry");
    assert.ok(markup.includes(">None<"), "and 'no phase' stays available");
});

test("an empty list offers no phases at all, only None", () => {
    // A job with no eligible estimate items has no phases, and the server
    // refuses every code for it. Offering the company list would only reproduce
    // that dead end.
    const markup = render([]);
    for (const code of ["03-PLUMB", "02-FRAME", "07-ROOF"]) {
        assert.ok(!markup.includes(code), `${code} must not be offered`);
    }
    assert.ok(markup.includes(">None<"));
});

test("the page passes the SCOPED list to it, never data.costCodes", () => {
    // The renders above prove the modal shows what it is given; this proves it
    // is given the right thing. A refactor that reintroduces the company-wide
    // list fails here, by name.
    const source = readFileSync(
        path.join(__dirname, "..", "src/app/projects/[id]/time-expenses/TimeExpensesClient.tsx"),
        "utf8",
    );
    const modal = source.slice(source.indexOf("<NewExpenseEntryModal"));
    const props = modal.slice(0, modal.indexOf("/>"));
    assert.match(props, /costCodes=\{phases\.map/, "the expense modal gets the project's phases");
    assert.ok(!/costCodes=\{data\.costCodes\}/.test(props), "and never the company-wide list");
});
