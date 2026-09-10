import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function harness(pending = false) {
    const effects = { emails: 0, fetches: 0, moves: [] as string[], notices: [] as string[], beacons: [] as string[] };
    let persisted: any = { qboRoute: "api" };
    const blob = { getBytes: () => [1], getName: () => "receipt.png", getContentType: () => "image/png" };
    const file = { getId: () => "new-capture", getName: () => "receipt.png", getBlob: () => blob,
        getDescription: () => JSON.stringify(persisted),
        setDescription: (value: string) => {persisted=JSON.parse(value)},
        moveTo: (where: string) => effects.moves.push(where) };
    const context = vm.createContext({
        Session: { getEffectiveUser: () => ({getEmail: () => "test@example.com"}) },
        Logger: { log() {} }, PropertiesService: { getScriptProperties: () => ({getProperty: (key: string) => key === "QBO_API_PUSH_ENABLED" ? "true" : "test"}) },
        Utilities: { base64Encode: () => "AQ==" },
        UrlFetchApp: { fetch: () => { effects.fetches++; return { getResponseCode: () => 409,
            getContentText: () => JSON.stringify(pending
                ? {ok:false,reason:"duplicate-create-pending",reviewRequired:true,pendingFileIds:["unresolved-source"]}
                : { ok: false, reason: "duplicate-purchase-review", reviewRequired: true,
                    candidates: [{ id: "6761", date: "2024-09-08", amount: 575 }], attachment: "already-attached" }) }; } },
        MailApp: { sendEmail: (...args: string[]) => effects.notices.push(args.join("\n")) },
    });
    vm.runInContext(readFileSync("docs/apps-script/runReceiptAutomation.gs", "utf8"), context);
    vm.runInContext(readFileSync("docs/apps-script/sendToQBOviaAPI.gs", "utf8"), context);
    Object.assign(context, { getState: () => structuredClone(persisted),
        setState: (_file: unknown, state: unknown) => { persisted = structuredClone(state); },
        sendToQBO: () => { effects.emails++; }, cleanMoney: () => 0,
        reportStageBeacon_: (_file: unknown, stage: string, status: string, reason: string) => {
            if (status !== "parked") return;
            assert.equal(persisted.parkReason, reason);
            assert.ok(effects.moves.includes("review"), "beacon follows the durable park and move");
            effects.beacons.push([stage, status, reason].join(":"));
        }, displayCategory: () => "" });
    const send = () => context.sendReceiptToQuickBooksViaAPI(file, {projectName: "Test"}, {vendor: "Bigfoot"},
        false, 575, "2026-09-08", "", "", "NoInv", false, blob, persisted);
    return { context, file, effects, send, state: () => persisted, reset: () => { persisted = {}; } };
}

test("legacy bot persists duplicate review, never emails it, and only retries alert/move", () => {
    const h = harness();
    assert.equal(h.send().parked, true);
    assert.equal(h.state().parkReason, "qboDuplicate");
    assert.equal(h.state().qboDuplicateReview.candidates[0].id, "6761");
    assert.equal(h.state().qboApi, undefined);
    assert.equal(h.effects.emails, 0);
    h.send(); // Even a direct helper replay cannot call QBO again.
    assert.equal(h.effects.fetches, 1);
    h.context.processSingleFile(h.file, {projectName: "Test"}, "archive", "review");
    assert.deepEqual(h.effects.moves, ["review"]);
    assert.match(h.effects.notices[0], /6761/);
    assert.match(h.effects.notices[0], /Do not forward/);
    assert.equal(h.state().emailed, undefined);
    assert.equal(h.effects.emails, 0);
    assert.equal(h.effects.fetches, 1);
});

test("a pre-persisted duplicate hold emits its park beacon once after recovery", () => {
    for (const pending of [false, true]) {
        const h = harness(pending);
        h.send();
        const sendAlert = h.context.MailApp.sendEmail;
        h.context.MailApp.sendEmail = () => { throw new Error("temporary alert failure"); };
        h.context.processSingleFile(h.file, {projectName: "Test"}, "archive", "review");
        assert.deepEqual(h.effects.beacons, []);
        h.context.MailApp.sendEmail = sendAlert;
        h.context.processSingleFile(h.file, {projectName: "Test"}, "archive", "review");
        assert.deepEqual(h.effects.beacons, ["read:parked:qboDuplicate"]);
        h.context.processSingleFile(h.file, {projectName: "Test"}, "archive", "review");
        assert.equal(h.effects.beacons.length, 1);
        assert.equal(h.effects.fetches, 1);
        assert.equal(h.effects.emails, 0);
    }
});

test("manual and automatic outage requeues allow a fresh beacon on the next park", () => {
    for (const helper of ["requeueParkedReceipts", "selfHeal"]) {
        const h=harness();
        vm.runInContext(readFileSync(`docs/apps-script/${helper}.gs`,"utf8"),h.context);
        const iterator=(items:any[])=>{let index=0;return{hasNext:()=>index<items.length,next:()=>items[index++]}};
        const folder={getName:()=>"_Needs Review",getFiles:()=>iterator([h.file])};
        Object.assign(h.context,{
            DriveApp:{getFoldersByName:()=>iterator([folder]),getFolderById:()=>"inbox"},
            getOrCreateFolder:()=>folder,
            PropertiesService:{getScriptProperties:()=>({setProperty:()=>{}})},
            checkVisionModels_:()=>[{ok:true}],selfHealAlert_:()=>{},
        });
        const park=()=>h.context.parkWithAlert_(h.file,h.context.getState(h.file),"aiUnavailable","subject","body","review");
        park();park();
        assert.equal(h.effects.beacons.length,1,"a replay without requeue does not repeat the attempt");
        if(helper==="selfHeal")h.context.pipelineSelfHeal();
        else {
            h.context.previewParkedReceipts();
            assert.equal(h.state().parkBeaconAttemptedReason,"aiUnavailable","preview cannot reset the attempt");
            h.context.requeueParkedReceipts();
        }
        assert.equal(h.state().parkReason,undefined);
        assert.equal(h.state().qboRoute,"api","unrelated routing evidence survives requeue");
        park();
        assert.deepEqual(h.effects.beacons,["read:parked:aiUnavailable","read:parked:aiUnavailable"],helper);
        assert.equal(h.effects.fetches+h.effects.emails,0);
    }
});

test("failed review alert retains the hold and retries without sending a receipt", () => {
    const h = harness();
    h.send();
    h.context.MailApp.sendEmail = () => { throw new Error("quota"); };
    h.context.processSingleFile(h.file, {projectName: "Test"}, "archive", "review");
    assert.equal(h.state().parkReason, "qboDuplicate");
    assert.deepEqual(h.effects.moves, []);
    assert.equal(h.effects.emails, 0);
    assert.equal(h.effects.fetches, 1);
});

test("an earlier unknown create parks with the source id instead of inventing a QBO id", () => {
    const h = harness(true);
    assert.equal(h.send().parked,true);
    h.context.processSingleFile(h.file,{projectName:"Test"},"archive","review");
    assert.deepEqual(h.effects.moves,["review"]);
    assert.match(h.effects.notices[0],/outcome unresolved or Purchase not yet visible.*unresolved-source/);
    assert.equal(h.effects.emails,0);
    assert.equal(h.state().emailed,undefined);
});

test("a terminal refusal after a prior API attempt cannot divert to email", () => {
    for (const reason of ["qbo-fault", "push-disabled", "push-paused", "missing-fields", "project-not-matched", "amount-mismatch"]) {
        const h = harness();
        h.context.UrlFetchApp.fetch = () => ({ getResponseCode: () => 200,
            getContentText: () => JSON.stringify({ ok: false, reason }) });
        assert.equal(h.send().parked, true);
        assert.equal(h.state().qboRoute, "api");
        assert.equal(h.state().parkReason, "qboDuplicate");
        assert.deepEqual(Array.from(h.state().qboDuplicateReview.pendingFileIds), ["new-capture"]);
        h.context.processSingleFile(h.file, {projectName: "Test"}, "archive", "review");
        assert.deepEqual(h.effects.moves, ["review"]);
        assert.equal(h.effects.emails, 0);
        assert.equal(h.state().emailed, undefined);
    }
});

test("a definite first-attempt refusal retains the existing email route", () => {
    const h = harness(); h.reset();
    h.context.UrlFetchApp.fetch = () => ({ getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ ok: false, reason: "project-not-matched" }) });
    h.send();
    assert.equal(h.effects.emails, 1);
    assert.equal(h.state().qboRoute, "email");
    assert.equal(h.state().parkReason, undefined);
});

test("a mixed duplicate hold preserves both kinds of evidence in state and the review notice", () => {
    const h=harness();
    h.context.UrlFetchApp.fetch=()=>({getResponseCode:()=>409,getContentText:()=>JSON.stringify({
        ok:false,reason:"duplicate-create-pending",reviewRequired:true,pendingFileIds:["capture-A"],
        candidates:[{id:"6761",date:"2024-09-08",amount:575}],
    })});
    assert.equal(h.send().parked,true);
    assert.deepEqual(Array.from(h.state().qboDuplicateReview.pendingFileIds),["capture-A"]);
    assert.equal(h.state().qboDuplicateReview.candidates[0].id,"6761");
    h.context.processSingleFile(h.file,{projectName:"Test"},"archive","review");
    assert.match(h.effects.notices[0],/Purchase 6761/);assert.match(h.effects.notices[0],/outcome unresolved or Purchase not yet visible.*capture-A/);
    assert.deepEqual(h.effects.moves,["review"]);assert.equal(h.effects.emails,0);assert.equal(h.state().emailed,undefined);
});
