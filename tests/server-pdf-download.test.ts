import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchExactServerPdf } from '../src/lib/server-pdf-download';

const fakeFetch = (res: Response | Error): typeof fetch => (async () => { if (res instanceof Error) throw res; return res; }) as unknown as typeof fetch;
const pdf = (status: number, type: string) => new Response(new Uint8Array([37, 80, 68, 70]), { status, headers: { 'content-type': type } });

test('a 200 application/pdf answer returns the Blob', async () => {
    const blob = await fetchExactServerPdf('/x', fakeFetch(pdf(200, 'application/pdf')));
    assert.ok(blob);
    assert.equal(blob!.size, 4);
});

test('409, 404, a JSON 200 and a thrown error all return null (the screenshot is kept)', async () => {
    assert.equal(await fetchExactServerPdf('/x', fakeFetch(pdf(409, 'application/json'))), null);
    assert.equal(await fetchExactServerPdf('/x', fakeFetch(pdf(404, 'application/json'))), null);
    assert.equal(await fetchExactServerPdf('/x', fakeFetch(pdf(200, 'application/json'))), null);
    assert.equal(await fetchExactServerPdf('/x', fakeFetch(new Error('offline'))), null);
});

test('F7: a fetch that never answers is aborted at the deadline and returns null', async () => {
    const hanging: typeof fetch = ((_url: unknown, init?: RequestInit) => new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const started = Date.now();
    assert.equal(await fetchExactServerPdf('/x', hanging, 30), null);
    assert.ok(Date.now() - started < 2000);
});

test('F7: the deadline also covers the body', async () => {
    const slowBody: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
        const res = new Response(new Uint8Array([37]), { status: 200, headers: { 'content-type': 'application/pdf' } });
        res.blob = () => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
        return res;
    }) as unknown as typeof fetch;
    assert.equal(await fetchExactServerPdf('/x', slowBody, 30), null);
});
