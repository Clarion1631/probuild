import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendDispatchChatMessage } from '../src/lib/dispatch-chat-transport';

const message = { spaceName: 'spaces/verified-dm', text: "I'm Justin's AI assistant. Your reviewed plan.", messageId: 'client-dispatch-test', requestId: 'dispatch-test' };
test('transport creates a stable named message and recovers exact duplicate after ambiguous send', async () => {
    const urls: string[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
        urls.push(url);
        assert.equal(init.redirect, 'error');
        assert.equal((init.headers as Record<string,string>).Authorization, 'Bearer synthetic');
        if (init.method === 'POST') return new Response('', { status: 409 });
        return Response.json({ name: `${message.spaceName}/messages/${message.messageId}`, text: message.text });
    };
    const result = await sendDispatchChatMessage(message, 'synthetic', fetcher as typeof fetch);
    assert.equal(result, `${message.spaceName}/messages/${message.messageId}`);
    assert.ok(urls[0].includes('requestId=dispatch-test'));
    assert.ok(urls[0].includes('messageId=client-dispatch-test'));
    assert.equal(urls[1], `https://chat.googleapis.com/v1/${message.spaceName}/messages/${message.messageId}`);
});
test('a successful duplicate request echo is verified by reading the stored message', async () => {
    const methods: string[] = [];
    const fetcher = async (_url: string, init: RequestInit) => {
        methods.push(init.method!);
        return Response.json({ name: `${message.spaceName}/messages/${message.messageId}`, text: init.method === 'POST' ? message.text : 'changed provider content' });
    };
    await assert.rejects(sendDispatchChatMessage(message, 'synthetic', fetcher as typeof fetch), /identity or content/);
    assert.deepEqual(methods, ['POST', 'GET']);
});
test('transport refuses a conflicting existing message and invalid destination before send', async () => {
    let calls = 0;
    const fetcher = async (_url: string, init: RequestInit) => {
        calls++;
        return init.method === 'POST' ? new Response('', { status: 409 }) : Response.json({ name: `${message.spaceName}/messages/${message.messageId}`, text: 'different content' });
    };
    await assert.rejects(sendDispatchChatMessage(message, 'synthetic', fetcher as typeof fetch), /identity or content/);
    assert.equal(calls, 2);
    await assert.rejects(sendDispatchChatMessage({ ...message, spaceName: 'https://evil.invalid' }, 'synthetic', fetcher as typeof fetch), /destination/);
    assert.equal(calls, 2);
});
