import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createRecordingFetch, locateBundle, pageAddress, renderEntry } from './domRuntime.ts';

const ORIGIN = 'http://127.0.0.1:41234';

/** Public directory the preview serves the built chunks from. */
const BUNDLE_BASE = '/assets/erpnext/banking/assets/';

/** The page a bundle mounts into, with nothing in it the DOM would try to load. */
const EMPTY_PAGE = '<html><body><div id="root"></div></body></html>';

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

	it('records a chunk the bundle asked for by file path as the address the preview serves it at', async () => {
		const { send, seen } = stubFetch({ [`${BUNDLE_BASE}Importer-xyz.js`]: 404 });
		const bundle = locateBundle('/tmp/bench/assets/index-abc.js', `${BUNDLE_BASE}index-abc.js`);
		const { fetch: page, requests } = createRecordingFetch(send, ORIGIN, bundle);

		await page('file:///tmp/bench/assets/Importer-xyz.js');

		// Sent to the preview, and recorded as the address a browser would have
		// asked for — a chunk the preview does not serve is a `404` here, not a
		// file this process happened to find on disk.
		assert.deepEqual(seen, [`${ORIGIN}${BUNDLE_BASE}Importer-xyz.js`]);
		assert.deepEqual(requests, [{ url: `${BUNDLE_BASE}Importer-xyz.js`, status: 404 }]);
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

describe('pageAddress', () => {
	const bundle = locateBundle('/tmp/bench/erpnext/public/banking/assets/index-abc.js', `${BUNDLE_BASE}index-abc.js`);

	it('finds the bundle from the two addresses the entry module has', () => {
		assert.deepEqual(bundle, {
			directory: '/tmp/bench/erpnext/public/banking/assets',
			base: BUNDLE_BASE
		});
	});

	it('asks the preview for a chunk whose public path a file URL was built from', () => {
		// Vite's module preloader resolves each chunk against `import.meta.url`,
		// which is a file URL here, so the public path comes back with the wrong
		// scheme on it. The address the page means is the preview's.
		const url = pageAddress(`file://${BUNDLE_BASE}Importer-xyz.js`, ORIGIN, bundle);
		assert.equal(url.href, `${ORIGIN}${BUNDLE_BASE}Importer-xyz.js`);
	});

	it('asks the preview for a chunk the bundle names by file path', () => {
		// The bundle is imported from disk, so its `import.meta.url` is a file
		// URL and Vite's module preloader derives the chunks' addresses from it.
		// In a browser those are the preview's own addresses.
		const url = pageAddress('file:///tmp/bench/erpnext/public/banking/assets/Importer-xyz.js', ORIGIN, bundle);
		assert.equal(url.href, `${ORIGIN}${BUNDLE_BASE}Importer-xyz.js`);
	});

	it('leaves a file outside the bundle alone, because the preview does not serve it', () => {
		const url = pageAddress('file:///etc/passwd', ORIGIN, bundle);
		assert.equal(url.protocol, 'file:');
	});

	it('puts the page origin back on a relative address, the way a browser resolves one', () => {
		assert.equal(pageAddress('/api/method/x', ORIGIN, bundle).href, `${ORIGIN}/api/method/x`);
	});

	it('leaves somebody else\'s server where it is', () => {
		assert.equal(pageAddress('https://fonts.example/inter.woff2', ORIGIN, bundle).origin, 'https://fonts.example');
	});
});

describe('renderEntry', () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'banking-entry-'));

	after(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	/**
	 * A stand-in for the built bundle: it mounts the landmark the entry screen is
	 * recognised by. Each test gets its own file, because a module Node has
	 * already run is not run again — the same reason a page is opened in a
	 * process of its own.
	 */
	function writeStubEntry(name: string): string {
		const file = path.join(directory, `${name}.mjs`);
		writeFileSync(
			file,
			[
				"const nav = document.createElement('nav');",
				"nav.setAttribute('aria-label', 'breadcrumb');",
				"nav.textContent = 'Banking';",
				"document.querySelector('#root').append(nav);"
			].join('\n')
		);
		return file;
	}

	it('reports the screen the bundle rendered into the page it was given', async () => {
		const entry = await renderEntry({
			html: EMPTY_PAGE,
			url: `${ORIGIN}/banking`,
			moduleFile: writeStubEntry('rendered'),
			moduleAddress: `${BUNDLE_BASE}rendered.mjs`,
			settleMs: 0,
			timeoutMs: 2_000
		});
		entry.close();

		assert.equal(entry.breadcrumbText, 'Banking');
		assert.ok(entry.mountHtml.includes('aria-label="breadcrumb"'));
		assert.deepEqual(entry.pageErrors, []);
	});

	it('reports each page at the address it was opened at', async () => {
		const entry = await renderEntry({
			html: EMPTY_PAGE,
			url: `${ORIGIN}/banking/statement-importer/BSI.2026.1`,
			moduleFile: writeStubEntry('address'),
			moduleAddress: `${BUNDLE_BASE}address.mjs`,
			settleMs: 0,
			timeoutMs: 2_000
		});
		entry.close();

		assert.equal(entry.address, `${ORIGIN}/banking/statement-importer/BSI.2026.1`);
	});
});
