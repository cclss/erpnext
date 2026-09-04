import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRecordingFetch } from './domRuntime.ts';

const ORIGIN = 'http://127.0.0.1:41234';

/** A stand-in for the process's fetch: it answers from a table and remembers what it was handed. */
function stubFetch(answers: Record<string, number>): { send: typeof fetch; seen: string[] } {
	const seen: string[] = [];
	const send = ((input: RequestInfo | URL) => {
		const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		seen.push(href);
		const status = answers[new URL(href).pathname] ?? 200;
		return Promise.resolve(new Response('', { status }));
	}) as typeof fetch;
	return { send, seen };
}

describe('createRecordingFetch', () => {
	it('puts the preview origin back on a relative address, the way a browser would', async () => {
		const { send, seen } = stubFetch({});
		const { fetch: page } = createRecordingFetch(send, ORIGIN);

		await page('/api/method/frappe.client.get_list');

		assert.deepEqual(seen, [`${ORIGIN}/api/method/frappe.client.get_list`]);
	});

	it('records the address and the status of every same-origin request, in order', async () => {
		const { send } = stubFetch({ '/api/method/gone': 404 });
		const { fetch: page, requests } = createRecordingFetch(send, ORIGIN);

		await page('/api/method/here');
		await page('/api/method/gone');

		assert.deepEqual(requests, [
			{ url: '/api/method/here', status: 200 },
			{ url: '/api/method/gone', status: 404 }
		]);
	});

	it('records the query string, because two calls to one endpoint are two different asks', async () => {
		const { send } = stubFetch({ '/api/resource/Bank': 404 });
		const { fetch: page, requests } = createRecordingFetch(send, ORIGIN);

		await page('/api/resource/Bank?limit=20');

		assert.deepEqual(requests, [{ url: '/api/resource/Bank?limit=20', status: 404 }]);
	});

	it('records an absolute address the page built itself, which is the same request', async () => {
		const { send } = stubFetch({ '/assets/erpnext/banking/assets/chunk.js': 404 });
		const { fetch: page, requests } = createRecordingFetch(send, ORIGIN);

		await page(`${ORIGIN}/assets/erpnext/banking/assets/chunk.js`);

		assert.deepEqual(requests, [{ url: '/assets/erpnext/banking/assets/chunk.js', status: 404 }]);
	});

	it('records a request made as a Request object, which is how a client library sends one', async () => {
		const { send } = stubFetch({ '/api/method/posted': 404 });
		const { fetch: page, requests } = createRecordingFetch(send, ORIGIN);

		await page(new Request(`${ORIGIN}/api/method/posted`, { method: 'POST' }));

		assert.deepEqual(requests, [{ url: '/api/method/posted', status: 404 }]);
	});

	it('leaves another server unrecorded, since it says nothing about this preview', async () => {
		const { send, seen } = stubFetch({});
		const { fetch: page, requests } = createRecordingFetch(send, ORIGIN);

		await page('https://fonts.example.com/inter.woff2');

		assert.deepEqual(requests, []);
		assert.deepEqual(seen, ['https://fonts.example.com/inter.woff2']);
	});

	it('records a request that got no answer, with the cause, and still lets the page see the failure', async () => {
		const send = (() => Promise.reject(new Error('fetch failed'))) as unknown as typeof fetch;
		const { fetch: page, requests } = createRecordingFetch(send, ORIGIN);

		await assert.rejects(() => page('/api/method/unreachable'), /fetch failed/);

		assert.deepEqual(requests, [{ url: '/api/method/unreachable', error: 'fetch failed' }]);
	});

	it('hands the page the answer unchanged, so the application behaves as it would in a browser', async () => {
		const { send } = stubFetch({ '/api/method/gone': 404 });
		const { fetch: page } = createRecordingFetch(send, ORIGIN);

		const response = await page('/api/method/gone');

		assert.equal(response.status, 404);
	});
});
