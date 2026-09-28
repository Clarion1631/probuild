import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";

// One place for the Claude model ids (model policy 2026-09-28: Sonnet 5.5 is
// the default, Opus 5.5 is for judgment work). Sonnet 5.5 / Opus 5.5 think
// adaptively whenever `thinking` is omitted (and Opus 5.5 cannot turn it off),
// so `content[0]` may be a thinking block, thinking tokens count against
// `max_tokens`, and `output_config.effort` should always be set explicitly.
export const CLAUDE_SONNET_MODEL = "claude-sonnet-5-5";
export const CLAUDE_OPUS_MODEL = "claude-opus-5-5";

/** Concatenated text of every `text` block. Skips thinking / tool_use blocks. */
export function getAnthropicText(content: ContentBlock[]): string {
    return content
        .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
}

/** Thrown when the model declined the request (`stop_reason: "refusal"`). */
export class AnthropicRefusalError extends Error {
    constructor() {
        super("The AI declined this request");
        this.name = "AnthropicRefusalError";
    }
}

/**
 * Text of a Messages response, read by block type. A refusal is a normal 200
 * whose content is empty or partial, so it is checked BEFORE reading content
 * and surfaces as an AnthropicRefusalError the caller's error path handles.
 */
export function getAnthropicMessageText(message: { stop_reason: string | null; content: ContentBlock[] }): string {
    if (message.stop_reason === "refusal") throw new AnthropicRefusalError();
    return getAnthropicText(message.content);
}
