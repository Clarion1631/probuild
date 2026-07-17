import type { ContentBlock } from "@anthropic-ai/sdk/resources/messages";

export function getAnthropicText(content: ContentBlock[]): string {
    return content
        .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
}
