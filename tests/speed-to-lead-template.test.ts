import test from "node:test";
import assert from "node:assert/strict";
import {
    renderFirstName, renderBookingLink, substituteTokens, renderTemplateA,
    templateAContentHash, templateADeadlinePassed, createOutreachTemplate, type TemplateAFields,
} from "../src/lib/speed-to-lead/template";

const FIELDS: TemplateAFields = {
    subject: "Got your request, {firstName}",
    body: "Hi {firstName}, book here: {bookingLink}",
    footer: "Golden Touch Remodeling footer",
    fixedPhone: "+1 (360) 200-1521",
    bookingBaseUrl: "https://calendly.com/rlord-goldentouchremodeling/",
    fromAddress: "gtrsupport@goldentouchremodeling.com",
};

const COMPLIANT_FOOTER = "Golden Touch Remodeling, 5305 NE 121st Ave Suite 310, Vancouver, WA 98682. Reply 'no thanks' and I'll stop.";

test("createOutreachTemplate rejects a bookingBaseUrl that uses '..' to escape the required Calendly prefix", async () => {
    const fields = { ...FIELDS, footer: COMPLIANT_FOOTER, bookingBaseUrl: `${FIELDS.bookingBaseUrl}../other-owner/consult`, testOnly: true };
    await assert.rejects(() => createOutreachTemplate(fields, {} as never), /bookingBaseUrl/);
});

test("createOutreachTemplate rejects a footer with an opt-out word but no mailing address", async () => {
    const fields = { ...FIELDS, footer: "stop", testOnly: true };
    await assert.rejects(() => createOutreachTemplate(fields, {} as never), /mailing address/);
});

test("createOutreachTemplate accepts a footer with both the opt-out phrase and the mailing address", async () => {
    const created: unknown[] = [];
    const fakeDb = { outreachTemplate: { create: async (args: { data: unknown }) => { created.push(args.data); return args.data; } } };
    const fields = { ...FIELDS, footer: COMPLIANT_FOOTER, testOnly: true };
    await createOutreachTemplate(fields, fakeDb as never);
    assert.equal(created.length, 1);
});

test("renderFirstName takes the first word, letters/apostrophe/hyphen only", () => {
    assert.equal(renderFirstName("Jane Doe"), "Jane");
    assert.equal(renderFirstName("O'Brien Smith"), "O'Brien");
    assert.equal(renderFirstName("Anne-Marie Jones"), "Anne-Marie");
});

test("renderFirstName strips digits/punctuation from the first word", () => {
    assert.equal(renderFirstName("Jane2 Doe"), "Jane");
});

test("renderFirstName falls back to 'there' for empty, all-symbol, or overlong input", () => {
    assert.equal(renderFirstName(""), "there");
    assert.equal(renderFirstName("123"), "there");
    assert.equal(renderFirstName("a".repeat(31)), "there");
});

test("renderFirstName allows exactly 30 characters", () => {
    assert.equal(renderFirstName("a".repeat(30)), "a".repeat(30));
});

test("renderBookingLink appends name and email as query params", () => {
    const link = renderBookingLink(FIELDS.bookingBaseUrl, "Jane Doe", "jane@example.com");
    const url = new URL(link);
    assert.equal(url.searchParams.get("name"), "Jane Doe");
    assert.equal(url.searchParams.get("email"), "jane@example.com");
    assert.ok(link.startsWith(FIELDS.bookingBaseUrl));
});

test("substituteTokens replaces both {firstName} and {bookingLink}, nothing else", () => {
    const text = substituteTokens(FIELDS.body, FIELDS, { name: "Jane Doe", email: "jane@example.com" });
    assert.ok(text.includes("Jane"));
    assert.ok(text.includes("calendly.com"));
    assert.ok(!text.includes("{firstName}"));
    assert.ok(!text.includes("{bookingLink}"));
});

test("renderTemplateA renders subject, body and passes footer through unchanged", () => {
    const rendered = renderTemplateA(FIELDS, { name: "Jane Doe", email: "jane@example.com" });
    assert.ok(rendered.subject.includes("Jane"));
    assert.ok(rendered.body.includes("Jane"));
    assert.equal(rendered.footer, FIELDS.footer);
});

test("templateAContentHash is deterministic for identical fields", () => {
    assert.equal(templateAContentHash(FIELDS), templateAContentHash({ ...FIELDS }));
});

test("templateAContentHash changes when any single field changes", () => {
    const base = templateAContentHash(FIELDS);
    for (const key of Object.keys(FIELDS) as (keyof TemplateAFields)[]) {
        const changed = templateAContentHash({ ...FIELDS, [key]: FIELDS[key] + " changed" });
        assert.notEqual(changed, base, `changing ${key} should change the hash`);
    }
});

test("templateADeadlinePassed is false at exactly the 15-minute boundary and true just after", () => {
    const intakeReceivedAt = new Date("2026-01-01T00:00:00.000Z");
    const atBoundary = new Date(intakeReceivedAt.getTime() + 15 * 60 * 1000);
    const justAfter = new Date(intakeReceivedAt.getTime() + 15 * 60 * 1000 + 1);
    assert.equal(templateADeadlinePassed(intakeReceivedAt, atBoundary), false);
    assert.equal(templateADeadlinePassed(intakeReceivedAt, justAfter), true);
});
