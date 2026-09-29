import test from "node:test";
import assert from "node:assert/strict";
import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";
import {
    AnthropicRefusalError,
    CLAUDE_OPUS_MODEL,
    CLAUDE_SONNET_MODEL,
    getAnthropicMessageText,
    getAnthropicText,
} from "../src/lib/anthropic";

const thinking = { type: "thinking", thinking: "", signature: "sig" } as ContentBlock;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as ContentBlock;
const toolUse = { type: "tool_use", id: "tu_1", name: "x", input: {} } as ContentBlock;

test("model ids are the 2026-09-28 policy ids", () => {
    assert.equal(CLAUDE_SONNET_MODEL, "claude-sonnet-5-5");
    assert.equal(CLAUDE_OPUS_MODEL, "claude-opus-5-5");
});

test("a leading thinking block does not hide the text block", () => {
    assert.equal(getAnthropicText([thinking, text("  hello ")]), "hello");
});

test("multiple text blocks join in order and non-text blocks are skipped", () => {
    assert.equal(getAnthropicText([thinking, text("a"), toolUse, text("b")]), "a\nb");
});

test("no text block gives an empty string, not a throw", () => {
    assert.equal(getAnthropicText([thinking]), "");
    assert.equal(getAnthropicText([]), "");
});

test("getAnthropicMessageText reads text by type from a normal response", () => {
    assert.equal(getAnthropicMessageText({ stop_reason: "end_turn", content: [thinking, text("answer")] }), "answer");
    assert.equal(getAnthropicMessageText({ stop_reason: "max_tokens", content: [text("cut")] }), "cut");
});

test("a refusal throws AnthropicRefusalError before content is read", () => {
    assert.throws(
        () => getAnthropicMessageText({ stop_reason: "refusal", content: [text("partial")] }),
        (err: unknown) => err instanceof AnthropicRefusalError && err.name === "AnthropicRefusalError",
    );
});
