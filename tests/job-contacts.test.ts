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
let log: string[];
let onFirstLock: (() => void) | null;

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
        log.push(`read:${where.id}`);
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
    // Row locks: FOR NO KEY UPDATE on the Lead (or a lead-less Project). Answers
    // with the row when it exists, [] when it does not.
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("?");
        assert.match(text, /FOR NO KEY UPDATE/);
        const id = String(values[0]);
        const table = /"Lead"/.test(text) ? "lead" : "project";
        log.push(`lock:${table}:${id}`);
        if (onFirstLock) { const f = onFirstLock; onFirstLock = null; f(); }
        if (table === "lead") return id === "lead-1" ? [{ id }] : [];
        return projects.some(p => p.id === id) ? [{ id }] : [];
    },
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
    log = [];
    onFirstLock = null;
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

test("alias regression: primary A on the project, primary B via the OLD leadId -> one primary, B, on the project", async () => {
    projects.push({ id: "proj-9", leadId: "lead-1", client: CLIENT });
    const a = await core.addJobContactCore({ projectId: "proj-9" }, { name: "A", isPrimaryContact: true }, fakeDb);
    const b = await core.addJobContactCore({ leadId: "lead-1" }, { name: "B", isPrimaryContact: true }, fakeDb);
    const primaries = contacts.filter(c => c.isPrimaryContact);
    assert.deepEqual(primaries.map(c => c.id), [b.id]);
    assert.equal(contacts.find(c => c.id === a.id)!.isPrimaryContact, false);
    assert.equal(b.projectId, "proj-9");
    assert.ok(!b.leadId);
});

test("add on a converted lead lands on the project; the lead page shows the project's contacts", async () => {
    projects.push({ id: "proj-9", leadId: "lead-1", client: CLIENT });
    const c = await core.addJobContactCore({ leadId: "lead-1" }, { name: "Wayne" }, fakeDb);
    assert.equal(c.projectId, "proj-9");
    assert.ok(!c.leadId);
    const viaLead = await core.listJobContactsCore({ leadId: "lead-1" }, fakeDb);
    assert.deepEqual(viaLead.contacts.map((x: any) => x.name), ["Wayne"]);
});

test("locks the LEAD row when the job has a lead (also via the project), the project row only without one", async () => {
    projects.push({ id: "proj-9", leadId: "lead-1", client: CLIENT }, { id: "proj-nolead", leadId: null, client: CLIENT });
    await core.addJobContactCore({ projectId: "proj-9" }, { name: "A" }, fakeDb);
    await core.addJobContactCore({ leadId: "lead-1" }, { name: "B" }, fakeDb);
    await core.addJobContactCore({ projectId: "proj-nolead" }, { name: "C" }, fakeDb);
    assert.deepEqual(log.filter(l => l.startsWith("lock:")), ["lock:lead:lead-1", "lock:lead:lead-1", "lock:project:proj-nolead"]);
});

test("update takes the lock FIRST, re-reads the contact, and uses the fresh owner (conversion between read and lock)", async () => {
    const c = await core.addJobContactCore({ leadId: "lead-1" }, { name: "Pamela", isPrimaryContact: true }, fakeDb);
    const other = await core.addJobContactCore({ leadId: "lead-1" }, { name: "Wayne" }, fakeDb);
    log.length = 0;
    // The conversion commits while update waits for the lead lock.
    onFirstLock = () => {
        projects.push({ id: "proj-9", leadId: "lead-1", client: CLIENT });
        contacts.forEach(x => { x.projectId = "proj-9"; x.leadId = null; });
    };
    const { contact, owner } = await core.updateJobContactCore(other.id, { isPrimaryContact: true }, fakeDb);
    assert.deepEqual(owner, { projectId: "proj-9" });
    assert.equal(contact.isPrimaryContact, true);
    assert.equal(contacts.find(x => x.id === c.id)!.isPrimaryContact, false);
    const lockAt = log.findIndex(l => l.startsWith("lock:"));
    const reads = log.map((l, i) => (l === `read:${other.id}` ? i : -1)).filter(i => i >= 0);
    assert.ok(reads.length >= 2 && reads[0] < lockAt && reads[reads.length - 1] > lockAt, "fresh read happens after the lock");
});

test("help-agent: update_job_contact is scoped through contactId (project assignment / lead access)", async () => {
    process.env.NEXTAUTH_SECRET ??= "test-only-secret"; // help-agent pulls in mobile-auth, which requires one at load
    const { projectScopeDenial } = await import("../src/lib/help-agent");
    projects.push({ id: "proj-9", leadId: "lead-1", client: CLIENT });
    contacts.push({ id: "jc-proj", projectId: "proj-9", leadId: null }, { id: "jc-lead", projectId: null, leadId: "lead-1" });
    const crew: any = { id: "u1", role: "FIELD_CREW", projectAccess: [], assignedProjects: [], permissions: {} };
    const assigned: any = { ...crew, projectAccess: [{ projectId: "proj-9" }] };
    const denied = await projectScopeDenial(crew, "update_job_contact", { contactId: "jc-proj" });
    assert.match(denied ?? "", /access to that project/);
    assert.equal(await projectScopeDenial(assigned, "update_job_contact", { contactId: "jc-proj" }), null);
    // A lead-owned row on a converted lead is gated as the project.
    assert.match((await projectScopeDenial(crew, "update_job_contact", { contactId: "jc-lead" })) ?? "", /access to that project/);
    assert.equal(await projectScopeDenial(assigned, "update_job_contact", { contactId: "jc-lead" }), null);
    assert.equal(await projectScopeDenial({ ...crew, role: "ADMIN" }, "update_job_contact", { contactId: "jc-proj" }), null);
});

test("MCP audit owner for update_job_contact resolves the contact's project/lead, id and name", async () => {
    const { resolveAuditOwner } = await import("../src/app/api/mcp/[transport]/route");
    contacts.push({ id: "jc-1", projectId: "proj-9", leadId: null, name: "Pamela Ann England" });
    assert.deepEqual(await resolveAuditOwner("update_job_contact", { contactId: "jc-1" }), {
        projectId: "proj-9", leadId: null, entityId: "jc-1", entityName: "Pamela Ann England",
    });
});

const leadOnlyUser: any = { id: "u2", role: "FIELD_CREW", permissions: { leadAccess: true }, projectAccess: [], assignedProjects: [] };

test("help-agent: a converted lead's id is authorized against its project, not just leadAccess (list and add)", async () => {
    process.env.NEXTAUTH_SECRET ??= "test-only-secret";
    const { projectScopeDenial } = await import("../src/lib/help-agent");
    projects.push({ id: "proj-9", leadId: "lead-1", client: CLIENT });
    for (const tool of ["list_job_contacts", "add_job_contact"]) {
        assert.match((await projectScopeDenial(leadOnlyUser, tool, { leadId: "lead-1" })) ?? "", /access to that project/, tool);
        const assigned = { ...leadOnlyUser, projectAccess: [{ projectId: "proj-9" }] };
        assert.equal(await projectScopeDenial(assigned, tool, { leadId: "lead-1" }), null, tool);
    }
    // An unconverted lead still needs only leadAccess.
    projects.length = 0;
    assert.equal(await projectScopeDenial(leadOnlyUser, "list_job_contacts", { leadId: "lead-1" }), null);
});

async function authorizerFor(user: any) {
    const { canAccessJobScope } = await import("../src/lib/access-rules");
    return (scope: { projectId: string | null; leadId: string | null }) => {
        if (!canAccessJobScope(user, scope)) throw new Error("Forbidden");
    };
}

test("authorization runs inside the transaction on the canonical owner: denied writes change nothing", async () => {
    projects.push({ id: "proj-9", leadId: "lead-1", client: CLIENT });
    const admin: any = { id: "a", role: "ADMIN" };
    const seeded = await core.addJobContactCore({ projectId: "proj-9" }, { name: "A", isPrimaryContact: true }, fakeDb, await authorizerFor(admin));
    const denyUser = await authorizerFor(leadOnlyUser);
    const snapshot = JSON.stringify(contacts);

    // The caller names the LEAD; the canonical owner is the project the user cannot reach.
    await assert.rejects(core.addJobContactCore({ leadId: "lead-1" }, { name: "B", isPrimaryContact: true }, fakeDb, denyUser), /Forbidden/);
    await assert.rejects(core.updateJobContactCore(seeded.id, { name: "Hacked", isPrimaryContact: false }, fakeDb, denyUser), /Forbidden/);
    await assert.rejects(core.removeJobContactCore(seeded.id, fakeDb, denyUser), /Forbidden/);
    assert.equal(JSON.stringify(contacts), snapshot);

    // The authorizer was consulted AFTER the lock was taken.
    log.length = 0;
    await assert.rejects(core.addJobContactCore({ leadId: "lead-1" }, { name: "C" }, fakeDb, (scope) => {
        assert.ok(log.some(l => l.startsWith("lock:")), "lock held before authorize");
        assert.equal(scope.projectId, "proj-9");
        throw new Error("Forbidden");
    }), /Forbidden/);

    // An allowed user succeeds.
    const ok = await core.updateJobContactCore(seeded.id, { name: "A2" }, fakeDb, await authorizerFor({ ...leadOnlyUser, projectAccess: [{ projectId: "proj-9" }] }));
    assert.equal(ok.contact.name, "A2");
});

test("lock-key mismatch throws a retryable error and the WHOLE transaction is retried once (no second lock in one tx)", async () => {
    projects.push({ id: "p-a", leadId: null, client: CLIENT });
    const c = await core.addJobContactCore({ projectId: "p-a" }, { name: "Mover" }, fakeDb);
    let transactions = 0;
    const counting: any = { ...fakeDb, $transaction: async (fn: any) => { transactions++; return fakeDb.$transaction(fn); } };
    log.length = 0;
    // While the first transaction waits for the project lock, the contact moves to a lead-owned job.
    onFirstLock = () => {
        const row = contacts.find(x => x.id === c.id)!;
        row.projectId = null; row.leadId = "lead-1";
    };
    const { contact, owner } = await core.updateJobContactCore(c.id, { name: "Moved" }, counting);
    assert.equal(transactions, 2);
    assert.equal(contact.name, "Moved");
    assert.deepEqual(owner, { leadId: "lead-1" });
    assert.deepEqual(log.filter(l => l.startsWith("lock:")), ["lock:project:p-a", "lock:lead:lead-1"]);
});

test("a contact that keeps moving fails after the single retry", async () => {
    projects.push({ id: "p-a", leadId: null, client: CLIENT });
    const c = await core.addJobContactCore({ projectId: "p-a" }, { name: "Mover" }, fakeDb);
    let transactions = 0;
    const counting: any = { ...fakeDb, $transaction: async (fn: any) => { transactions++; return fakeDb.$transaction(fn); } };
    const flip = () => {
        const row = contacts.find(x => x.id === c.id)!;
        if (row.projectId) { row.projectId = null; row.leadId = "lead-1"; } else { row.leadId = null; row.projectId = "p-a"; }
        onFirstLock = flip;
    };
    onFirstLock = flip;
    await assert.rejects(core.updateJobContactCore(c.id, { name: "X" }, counting), /try again/);
    assert.equal(transactions, 2);
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
        assert.match(help, new RegExp(`${tool}: "${tool === "list_job_contacts" ? "leadAccess" : "createLead"}"`));
    }
});
