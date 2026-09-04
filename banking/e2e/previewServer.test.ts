import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { HarnessFailure } from './buildReport.ts';
import { findUnresolvedPlaceholders } from './previewBoot.ts';
import { APP_ROUTE, ASSET_BASE, startPreviewServer, type RunningPreviewServer } from './previewServer.ts';

const SCRIPT_ASSET = 'assets/index-preview.js';
const STYLE_ASSET = 'assets/index-preview.css';
const SCRIPT_BODY = 'console.log("banking preview bundle");\n';

const temporaryRoots: string[] = [];
const runningServers: RunningPreviewServer[] = [];

after(async () => {
	await Promise.all(runningServers.map((server) => server.close()));
	for (const root of temporaryRoots) {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * Writes what a successful build leaves behind: hashed bundles under the output
 * directory, and the HTML entry copied to `erpnext/www/banking.html` with its
 * Jinja placeholders still unrendered. The entry is derived from the app's own
 * `index.html`, so the fixture cannot drift away from the real template.
 */
function createArtifacts(): { outDir: string; webEntry: string } {
	const root = mkdtempSync(path.join(tmpdir(), 'banking-preview-server-'));
	temporaryRoots.push(root);

	const outDir = path.join(root, 'public', 'banking');
	mkdirSync(path.join(outDir, 'assets'), { recursive: true });
	writeFileSync(path.join(outDir, SCRIPT_ASSET), SCRIPT_BODY, 'utf8');
	writeFileSync(path.join(outDir, STYLE_ASSET), ':root { --preview: 1 }\n', 'utf8');

	const built = readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(
		'<script type="module" src="/src/main.tsx"></script>',
		`<script type="module" crossorigin src="${ASSET_BASE}${SCRIPT_ASSET}"></script>\n` +
			`  <link rel="stylesheet" crossorigin href="${ASSET_BASE}${STYLE_ASSET}">`
	);

	const webDir = path.join(root, 'www');
	mkdirSync(webDir, { recursive: true });
	const webEntry = path.join(webDir, 'banking.html');
	writeFileSync(webEntry, built, 'utf8');
	writeFileSync(path.join(outDir, 'index.html'), built, 'utf8');

	return { outDir, webEntry };
}

/** Starts a server on an ephemeral port so the suite never collides with a real preview. */
async function startFixtureServer(): Promise<RunningPreviewServer & { origin: string }> {
	const running = await startPreviewServer({ ...createArtifacts(), port: 0 });
	runningServers.push(running);
	return { ...running, origin: `http://${running.host}:${String(running.port)}` };
}

test('the app entry is served fully rendered', async () => {
	const server = await startFixtureServer();

	const response = await fetch(`${server.origin}${APP_ROUTE}`);
	const html = await response.text();

	assert.equal(response.status, 200);
	assert.match(response.headers.get('content-type') ?? '', /text\/html/);
	assert.deepEqual(findUnresolvedPlaceholders(html), [], 'the browser must never receive an unrendered placeholder');
	assert.match(html, /frappe\.boot = JSON\.parse\("/, 'the boot payload is inlined as JSON text');
	assert.ok(html.includes(`${ASSET_BASE}${SCRIPT_ASSET}`), 'the page points at the built bundle');
});

test('the entry hands the browser a signed-in session cookie', async () => {
	const server = await startFixtureServer();

	const response = await fetch(`${server.origin}${APP_ROUTE}`);
	await response.text();

	// The app sends a guest straight to the login page; without this cookie the
	// preview would navigate away from the screen it exists to show.
	const cookie = response.headers.get('set-cookie') ?? '';
	assert.match(cookie, /user_id=/);
	assert.ok(!cookie.includes('user_id=Guest'));
});

test('built assets are served under the base the page references', async () => {
	const server = await startFixtureServer();

	const script = await fetch(`${server.origin}${ASSET_BASE}${SCRIPT_ASSET}`);
	const body = await script.text();
	const style = await fetch(`${server.origin}${ASSET_BASE}${STYLE_ASSET}`);
	await style.text();

	assert.equal(script.status, 200);
	assert.equal(body, SCRIPT_BODY);
	assert.match(script.headers.get('content-type') ?? '', /text\/javascript/);
	assert.equal(style.status, 200);
	assert.match(style.headers.get('content-type') ?? '', /text\/css/);
});

test('every asset the rendered page references is actually served', async () => {
	const server = await startFixtureServer();

	const html = await (await fetch(`${server.origin}${APP_ROUTE}`)).text();
	const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
		.map((match) => match[1])
		.filter((reference) => reference.startsWith(ASSET_BASE));

	assert.ok(references.length > 0, 'the fixture page references built assets');
	for (const reference of references) {
		const response = await fetch(`${server.origin}${reference}`);
		await response.arrayBuffer();
		assert.equal(response.status, 200, reference);
	}
});

test('a missing asset is a 404, not the page pretending to be a bundle', async () => {
	const server = await startFixtureServer();

	const response = await fetch(`${server.origin}${ASSET_BASE}assets/does-not-exist.js`);
	await response.text();

	assert.equal(response.status, 404);
});

test('an asset path cannot escape the build output directory', async () => {
	const server = await startFixtureServer();

	// Percent-encoded, because a plain `../` is collapsed by the client before
	// the request is ever sent — the encoded form is what actually arrives.
	for (const suffix of ['..%2f..%2fwww%2fbanking.html', '%2e%2e%2f%2e%2e%2fwww%2fbanking.html']) {
		const response = await fetch(`${server.origin}${ASSET_BASE}${suffix}`);
		const body = await response.text();

		assert.equal(response.status, 403, suffix);
		assert.ok(!body.includes('<html'), 'no file outside the output directory may be returned');
	}
});

test('client-side routes reload into the app instead of a 404', async () => {
	const server = await startFixtureServer();

	for (const route of ['/', APP_ROUTE, `${APP_ROUTE}/statement-importer`, '/statement-importer']) {
		const response = await fetch(`${server.origin}${route}`);
		const html = await response.text();

		assert.equal(response.status, 200, route);
		assert.match(html, /<div id="root">/, route);
	}
});

test('backend calls answer with an empty payload rather than an error', async () => {
	const server = await startFixtureServer();

	const count = await fetch(`${server.origin}/api/method/frappe.client.get_count?doctype=Bank%20Transaction`);
	const companies = await fetch(`${server.origin}/api/resource/Company?limit_page_length=0`);
	const reconcile = await fetch(`${server.origin}/api/method/frappe.desk.query_report.run`, { method: 'POST' });

	assert.equal(count.status, 200);
	assert.deepEqual(await count.json(), { message: 0 });
	assert.equal(companies.status, 200);
	assert.deepEqual(await companies.json(), { data: [] });
	assert.equal(reconcile.status, 200);
	assert.deepEqual(await reconcile.json(), {
		message: { prepared_report: false, report_summary: [], result: [], columns: [], add_total_row: false }
	});
});

test('a missing build output is reported as a preview failure, not a stack trace', async () => {
	const { outDir, webEntry } = createArtifacts();
	rmSync(webEntry);

	await assert.rejects(
		() => startPreviewServer({ outDir, webEntry, port: 0 }),
		(error: unknown) => {
			assert.ok(error instanceof HarnessFailure);
			assert.equal(error.report.stage, 'verify');
			assert.match(error.message, /build_failed/);
			return true;
		}
	);
});

test('an entry with values the preview cannot fill refuses to be served', async () => {
	const { outDir, webEntry } = createArtifacts();
	writeFileSync(webEntry, '<html><body>{{ frappe.session.user }}</body></html>', 'utf8');

	await assert.rejects(
		() => startPreviewServer({ outDir, webEntry, port: 0 }),
		(error: unknown) => {
			assert.ok(error instanceof HarnessFailure);
			assert.equal(error.report.stage, 'verify');
			assert.ok(
				error.report.details.some((detail) => detail.value.includes('frappe.session.user')),
				'the report names the placeholder it could not fill'
			);
			return true;
		}
	);
});

test('an address already in use is reported with the address that is taken', async () => {
	const first = await startFixtureServer();

	await assert.rejects(
		() => startPreviewServer({ ...createArtifacts(), port: first.port, host: first.host }),
		(error: unknown) => {
			assert.ok(error instanceof HarnessFailure);
			assert.equal(error.report.stage, 'serve');
			assert.match(error.report.reason, /EADDRINUSE/);
			return true;
		}
	);
});
