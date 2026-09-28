/**
 * Front Desk v1 acceptance tests 31–34 (TwiML exactness and sanitization).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    escapeXmlAttr, escapeXmlText, sanitizeScreenText, inboundDialTwiml, screenGatherTwiml,
    screenAcceptedTwiml, screenRejectedTwiml, actionHangupTwiml, actionMissLineTwiml, rejectTwiml,
} from "../src/lib/front-desk/twiml";

test("inboundDialTwiml: Dial first, answerOnBridge, timeout=15, callerId=bridge, &amp;-escaped URLs", () => {
    const xml = inboundDialTwiml({ baseUrl: "https://probuild.example.com", bridgeE164: "+13605551234", richardE164: "+13602071549", transferId: "abc123" });
    assert.match(xml, /<Response><Dial answerOnBridge="true" timeout="15" callerId="\+13605551234" method="POST" action="[^"]*">/);
    assert.match(xml, /action="https:\/\/probuild\.example\.com\/api\/front-desk\/bridge-twiml\?step=action&amp;t=abc123"/);
    assert.match(xml, /<Number method="POST" url="[^"]*">\+13602071549<\/Number>/);
    assert.match(xml, /url="https:\/\/probuild\.example\.com\/api\/front-desk\/bridge-twiml\?step=screen&amp;t=abc123"/);
    assert.doesNotMatch(xml, /&[^a]/); // the only entity present is &amp;
});

test("a retry with the same CallSid produces the identical TwiML (idempotent by construction — same inputs, same output)", () => {
    const params = { baseUrl: "https://x.test", bridgeE164: "+1", richardE164: "+2", transferId: "t1" };
    assert.equal(inboundDialTwiml(params), inboundDialTwiml(params));
});

test("no prepared transfer: reject TwiML is exact", () => {
    assert.equal(rejectTwiml(), '<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
});

test("screenGatherTwiml: numDigits=1, timeout=6, actionOnEmptyResult=false, trailing Hangup", () => {
    const xml = screenGatherTwiml({ baseUrl: "https://x.test", transferId: "t1", isTest: false, callerFirstName: "Jane", project: "Kitchen remodel", city: "Vancouver", spanish: false });
    assert.match(xml, /<Gather numDigits="1" timeout="6" actionOnEmptyResult="false" method="POST" action="[^"]*">/);
    assert.match(xml, /<\/Gather><Hangup\/><\/Response>$/);
    assert.match(xml, /Golden Touch front desk: Jane, Kitchen remodel in Vancouver\./);
    assert.doesNotMatch(xml, /Spanish speaker/);
    assert.doesNotMatch(xml, /Test call/);
});

test("screenGatherTwiml: TEST prefix and Spanish note appear when flagged", () => {
    const xml = screenGatherTwiml({ baseUrl: "https://x.test", transferId: "t1", isTest: true, callerFirstName: "Jane", project: "Bath", city: "Camas", spanish: true });
    assert.match(xml, /^<\?xml[^>]*><Response><Gather[^>]*><Say>Test call\. Golden Touch front desk: Jane, Bath in Camas\. Spanish speaker\./);
});

test("an <, > or & payload in caller-supplied text cannot break the XML", () => {
    const xml = screenGatherTwiml({
        baseUrl: "https://x.test", transferId: "t1", isTest: false,
        callerFirstName: '<script>alert(1)</script>', project: "A&B <Dial>hack</Dial>", city: "X\"Y'Z", spanish: false,
    });
    // The whole document still parses as exactly one Say with no injected tags.
    const sayMatches = xml.match(/<Say>/g) ?? [];
    assert.equal(sayMatches.length, 1);
    assert.doesNotMatch(xml, /<script>|<Dial>|<\/Dial>/);
    assert.doesNotMatch(xml, /&(?!amp;)/); // sanitizeScreenText strips raw "&" before this point; only &amp; from escaping (of URLs) may appear
});

test("sanitizeScreenText strips everything outside [A-Za-z0-9 .,'-] and truncates", () => {
    assert.equal(sanitizeScreenText("Jane <script>&\"'"), "Jane script'");
    assert.equal(sanitizeScreenText("x".repeat(100), 40).length, 40);
});

test("screen-result: accepted has no Hangup (legs bridge); rejected hangs up", () => {
    assert.doesNotMatch(screenAcceptedTwiml(), /Hangup/);
    assert.match(screenRejectedTwiml(), /<Hangup\/>/);
});

test("action: connected/miss-off hangs up; miss-on says the fixed line then hangs up", () => {
    assert.equal(actionHangupTwiml(), '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    assert.match(actionMissLineTwiml(), /<Say>Richard couldn't pick up\. He has your details and will call you back shortly\. You can also book at goldentouchremodeling\.com\.<\/Say><Hangup\/>/);
});

test("escapeXmlAttr/escapeXmlText escape &, <, > and (attr only) \"", () => {
    assert.equal(escapeXmlText(`a&b<c>d`), "a&amp;b&lt;c&gt;d");
    assert.equal(escapeXmlAttr(`a"b`), "a&quot;b");
});
