/**
 * Job contacts: several named people per lead/project, informational only.
 *
 * In-memory fake Prisma (stateful, so primary clearing and conversion relinks
 * are observed end to end). Prisma and the conversion side-effect modules are
 * patched at require() time, same shape as tests/lead-conversion-attribution
 * test (no mock.module: CI is Node 20).
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";

type Row = Record<string, any>;

let contacts: Row[];
let seq: number;

function matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => {
        if (key === "OR") return (cond as Row[]).some(w => matches(row, w));
        if (key === "AND") return (cond as Row[]).every(w => matches(row, w));
        if (cond && typeof cond === "object" && "not" in cond) return row[key] !== cond.not;
        return row[key] === cond;
    });
}

const CLIENT = { id: "client-jason", name: "Jason England", email: "jason@example.test", primaryPhone: "(360) 555-0100" };

const jobContact = {
    create: async ({ data }: Row) => {
        const row = { id: `jc${++seq}`, email: null, phone: null, phoneE164: null, isOwner: false, isPrimaryContact: false, roleNote: null, leadId: null, projectId: null, createdAt: new Date(seq), ...data };
        contacts.push(row);
        return { ...row };
    },
    findMany: async ({ where }: Row) => contacts.filter(c => matches(c, where)).map(c => ({ ...c })),
    findUnique: async ({ where }: Row) => {
        const c = contacts.find(x => x.id === where.id);
        return c ? { ...c } : null;
    },
    updateMany: async ({ where, data }: Row) => {
        const hit = contacts.filter(c => matches(c, where));
        hit.forEach(c => Object.assign(c, data));
        return { count: hit.length };
    },
    update: async ({ where, data }: Row) => {
        const c = contacts.find(x => x.id === where.id);
        if (!c) throw new Error("no such contact");
        Object.assign(c, data);
        return { ...c };
    },
    delete: async ({ where }: Row) => {
        contacts = contacts.filter(c => c.id !== where.id);
        return {};
    },
};

let projects: Row[];

const fakeDb: any = {
    jobContact,
    lead: {
        findUnique: async ({ where }: Row) => (where.id === "lead-1" ? { id: "lead-1", name: "England Kitchen", clientId: CLIENT.id, location: "1 Main St", client: CLIENT } : null),
        update: async () => ({}),
    },
    project: {
        findUnique: async ({ where }: Row) => {
            if (where.leadId) return projects.find(p => p.leadId === where.leadId) ?? null;
            return projects.find(p => p.id === where.id) ?? null;
        },
        create: async ({ data }: Row) => {
            const p = { id: "proj-1", client: CLIENT, ...data };
            projects.push(p);
            return p;
        },
    },
    estimate: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    roomDesign: { updateMany: async () => ({ count: 0 }) },
    contract: { updateMany: async () => ({ count: 0 }) },
    projectFile: { updateMany: async () => ({ count: 0 }) },
    fileFolder: { updateMany: async () => ({ count: 0 }), create: async () => ({}) },
    scheduleTask: { updateMany: async () => ({ count: 0 }) },
    takeoff: { updateMany: async () => ({ count: 0 }) },
    clientMessage: { updateMany: async () => ({ count: 0 }) },
    userPermission: { findMany: async () => [] },
    projectAccess: { createMany: async () => ({ count: 0 }) },
    $queryRaw: async () => [],
    $queryRawUnsafe: async () => [],
    $transaction: async (fn: any) => fn(fakeDb),
};

let core: typeof import("../src/lib/job-contacts");
let convertLeadToProjectCore: (leadId: string) => Promise<{ id: string }>;
let originalRequire: typeof Module.prototype.require;

before(async () => {
    originalRequire = Module.prototype.require;
    (Module.prototype as unknown as { require: (id: string) => unknown }).require = function (this: NodeModule, id: string) {
        if (id === "@/lib/prisma") return { prisma: fakeDb };
        if (id === "./geocode" || id === "@/lib/geocode") return { geocodeJobSiteAddress: async () => null };
        if (id === "./project-folders" || id === "@/lib/project-folders") return { ensureStandardFolders: async () => {} };
        if (id === "@/lib/auto-grant-project-access") return { autoGrantProjectAccessToEligibleUsers: async () => {} };
        if (id === "./google-drive" || id === "@/lib/google-drive") return { createProjectDriveFolder: async () => ({ success: false }) };
        if (id === "next/cache") return { revalidatePath: () => {} };
        // eslint-disable-next-line prefer-rest-params
        return originalRequire.apply(this, arguments as unknown as [string]);
    } as typeof Module.prototype.require;

    core = await import("../src/lib/job-contacts");
    const conv: any = await import("../src/lib/lead-conversion-core");
    convertLeadToProjectCore = conv.convertLeadToProjectCore;
});

after(() => {
    Module.prototype.require = originalRequire;
});

beforeEach(() => {
    contacts = [];
    projects = [];
    seq = 0;
});

test("exactly one of leadId / projectId is required", async () => {
    assert.throws(() => core.resolveJobOwner({}), /leadId or a projectId/);
    assert.throws(() => core.resolveJobOwner({ leadId: "a", projectId: "b" }), /not both/);
    await assert.rejects(core.addJobContactCore({}, { name: "X" }, fakeDb), /leadId or a projectId/);
    await assert.rejects(core.listJobContactsCore({ leadId: "a", projectId: "b" }, fakeDb), /not both/);
});

test("name is required and the owner must exist", async () => {
    await assert.rejects(core.addJobContactCore({ leadId: "lead-1" }, { name: "  " }, fakeDb), /name is required/i);
    await assert.rejects(core.addJobContactCore({ leadId: "nope" }, { name: "A" }, fakeDb), /Lead not found/);
    await assert.rejects(core.addJobContactCore({ projectId: "nope" }, { name: "A" }, fakeDb), /Project not found/);
});

test("phone is normalized to E164 and kept in sync on update", async () => {
    const c = await core.addJobContactCore({ leadId: "lead-1" }, { name: "Pamela Ann England", phone: "(360) 555-0111" }, fakeDb);
    assert.equal(c.phone, "(360) 555-0111");
    assert.equal(c.phoneE164, "+13605550111");
    const { contact } = await core.updateJobContactCore(c.id, { phone: "425-555-0199" }, fakeDb);
    assert.equal(contact.phoneE164, "+14255550199");
    const cleared = await core.updateJobContactCore(c.id, { phone: "" }, fakeDb);
    assert.equal(cleared.contact.phone, null);
    assert.equal(cleared.contact.phoneE164, null);
    await assert.rejects(core.addJobContactCore({ leadId: "lead-1" }, { name: "B", email: "not-an-email" }, fakeDb), /Email is not valid/);
});

test("at most one primary contact per job; setting one clears the others", async () => {
    const a = await core.addJobContactCore({ leadId: "lead-1" }, { name: "A", isPrimaryContact: true }, fakeDb);
    const b = await core.addJobContactCore({ leadId: "lead-1" }, { name: "B", isPrimaryContact: true }, fakeDb);
    assert.equal(contacts.find(c => c.id === a.id)!.isPrimaryContact, false);
    assert.equal(contacts.find(c => c.id === b.id)!.isPrimaryContact, true);
    await core.updateJobContactCore(a.id, { isPrimaryContact: true }, fakeDb);
    assert.deepEqual(contacts.filter(c => c.isPrimaryContact).map(c => c.id), [a.id]);
    // Another job's primary is untouched.
    projects.push({ id: "proj-other", leadId: null, client: CLIENT });
    const other = await core.addJobContactCore({ projectId: "proj-other" }, { name: "Z", isPrimaryContact: true }, fakeDb);
    await core.updateJobContactCore(b.id, { isPrimaryContact: true }, fakeDb);
    assert.equal(contacts.find(c => c.id === other.id)!.isPrimaryContact, true);
});

test("multiple owners are allowed and a person can be owner and primary", async () => {
    await core.addJobContactCore({ leadId: "lead-1" }, { name: "Pamela", isOwner: true, isPrimaryContact: true }, fakeDb);
    await core.addJobContactCore({ leadId: "lead-1" }, { name: "Wayne", isOwner: true }, fakeDb);
    const listed = await core.listJobContactsCore({ leadId: "lead-1" }, fakeDb);
    assert.equal(listed.contacts.filter((c: any) => c.isOwner).length, 2);
    assert.equal(listed.mainClientIsPrimary, false);
});

test("main client is returned first and is the implied primary when none is marked", async () => {
    const listed = await core.listJobContactsCore({ leadId: "lead-1" }, fakeDb);
    assert.equal(listed.mainClient?.name, "Jason England");
    assert.equal(listed.mainClientIsPrimary, true);
});

test("remove deletes the contact and reports its owner", async () => {
    const c = await core.addJobContactCore({ leadId: "lead-1" }, { name: "A" }, fakeDb);
    const owner = await core.removeJobContactCore(c.id, fakeDb);
    assert.equal(owner.leadId, "lead-1");
    assert.equal(contacts.length, 0);
    await assert.rejects(core.removeJobContactCore(c.id, fakeDb), /not found/);
});

test("England case: contacts survive lead to project conversion", async () => {
    await core.addJobContactCore({ leadId: "lead-1" }, { name: "Pamela Ann England", isOwner: true, phone: "360-555-0111" }, fakeDb);
    await core.addJobContactCore({ leadId: "lead-1" }, { name: "Wayne Warren Traver", isOwner: true }, fakeDb);

    const { id: projectId } = await convertLeadToProjectCore("lead-1");
    assert.equal(projectId, "proj-1");

    const onProject = await core.listJobContactsCore({ projectId }, fakeDb);
    assert.equal(onProject.mainClient?.name, "Jason England");
    assert.deepEqual(onProject.contacts.map((c: any) => c.name).sort(), ["Pamela Ann England", "Wayne Warren Traver"]);
    assert.ok(onProject.contacts.every((c: any) => c.isOwner));
    // Relinked rows no longer point at the lead (cascade-FK pattern).
    assert.ok(contacts.every(c => c.leadId === null && c.projectId === projectId));
});

test("project reads also see rows still pointing at the converted lead, without duplicates", async () => {
    projects.push({ id: "proj-9", leadId: "lead-1", client: CLIENT });
    await core.addJobContactCore({ leadId: "lead-1" }, { name: "Left on lead" }, fakeDb);
    await core.addJobContactCore({ projectId: "proj-9" }, { name: "On project" }, fakeDb);
    const listed = await core.listJobContactsCore({ projectId: "proj-9" }, fakeDb);
    assert.deepEqual(listed.contacts.map((c: any) => c.name).sort(), ["Left on lead", "On project"]);
});

test("MCP tools are registered, audited, permissioned, and remove is not exposed", () => {
    const route = readFileSync("src/app/api/mcp/[transport]/route.ts", "utf8");
    for (const tool of ["list_job_contacts", "add_job_contact", "update_job_contact"]) {
        assert.ok(route.includes(`"${tool}",\n`) || route.includes(`"${tool}",\r\n`), `${tool} registered`);
    }
    assert.match(route, /WRITE_TOOLS = new Set\([\s\S]*"add_job_contact", "update_job_contact"[\s\S]*?\]\);/);
    assert.match(route, /ENTITY_TYPE_BY_TOOL[\s\S]*add_job_contact: "job_contact", update_job_contact: "job_contact"/);
    assert.ok(!route.includes("remove_job_contact") && !route.includes("delete_job_contact"));
    const help = readFileSync("src/lib/help-agent.ts", "utf8");
    for (const tool of ["list_job_contacts", "add_job_contact", "update_job_contact"]) {
        assert.match(help, new RegExp(`${tool}: "createLead"`));
    }
});
