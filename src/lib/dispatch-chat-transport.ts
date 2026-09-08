export type DispatchChatMessage = {
    spaceName: string;
    messageId: string;
    requestId: string;
    text: string;
};

/** Named messages + requestId make an ambiguous send safely retryable.
 * https://developers.google.com/workspace/chat/api/reference/rest/v1/spaces.messages/create
 * No credentials are loaded here; callers must supply the pinned principal's token.
 */
export async function sendDispatchChatMessage(
    message: DispatchChatMessage,
    accessToken: string,
    fetcher: typeof fetch = fetch,
): Promise<string> {
    if (!/^spaces\/[A-Za-z0-9_-]+$/.test(message.spaceName)) throw new Error('Invalid dispatch Chat destination');
    if (!/^client-[a-z0-9-]{1,56}$/.test(message.messageId) || !message.requestId) throw new Error('Invalid dispatch message identity');
    if (!accessToken || Buffer.byteLength(message.text, 'utf8') > 30_000) throw new Error('Dispatch credential missing or message too long');
    const root = `https://chat.googleapis.com/v1/${message.spaceName}/messages`;
    const query = new URLSearchParams({ requestId: message.requestId, messageId: message.messageId });
    const options = { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000), redirect: 'error' as const };
    const created = await fetcher(`${root}?${query}`, { ...options, method: 'POST', body: JSON.stringify({ text: message.text }) });
    if (!created.ok && created.status !== 409) throw new Error(`Dispatch Chat returned HTTP ${created.status}`);
    // A requestId replay can echo the submitted body. Always read the stored
    // named message; even a successful create response is not readback proof.
    const response = await fetcher(`${root}/${message.messageId}`, { ...options, method: 'GET' });
    if (!response.ok) throw new Error(`Dispatch Chat returned HTTP ${response.status}`);
    const body = await response.json() as { name?: string; text?: string };
    if (!body.name?.startsWith(`${message.spaceName}/messages/`) || body.text !== message.text) {
        throw new Error('Dispatch Chat message identity or content mismatch');
    }
    return body.name;
}
