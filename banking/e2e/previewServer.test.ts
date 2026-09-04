import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { HarnessFailure } from './buildReport.ts';
import { findUnresolvedPlaceholders } from './previewBoot.ts';
import {
	APP_ROUTE,
	ASSET_BASE,
	SHARED_ASSET_BASE,
	startPreviewServer,
	type RunningPreviewServer
} from './previewServer.ts';

const SCRIPT_ASSET = 'assets/index-preview.js';
const STYLE_ASSET = 'assets/index-preview.css';
const SCRIPT_BODY = 'console.log("banking preview bundle");\n';

/** The icon the entry template falls back to when a site sets no favicon of its own. */
const FAVICON_ASSET = 'images/erpnext-favicon.svg';
const FAVICON_BODY = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>\n';

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
 * directory, the erpnext app's shared assets in the tree that contains it, and
 * the HTML entry copied to `erpnext/www/banking.html` with its Jinja
 * placeholders still unrendered. The entry is derived from the app's own
 * `index.html`, so the fixture cannot drift away from the real template.
 */
function createArtifacts(): { outDir: string; webEntry: string; sharedAssets: string } {
	const root = mkdtempSync(path.join(tmpdir(), 'banking-preview-server-'));
	temporaryRoots.push(root);

	// The output directory sits inside the shared tree, exactly as
	// `erpnext/public/banking` sits inside `erpnext/public` in a bench.
	const sharedAssets = path.join(root, 'public');
	const outDir = path.join(sharedAssets, 'banking');
	mkdirSync(path.join(outDir, 'assets'), { recursive: true });
	writeFileSync(path.join(outDir, SCRIPT_ASSET), SCRIPT_BODY, 'utf8');
	writeFileSync(path.join(outDir, STYLE_ASSET), ':root { --preview: 1 }\n', 'utf8');
	mkdirSync(path.join(sharedAssets, path.dirname(FAVICON_ASSET)), { recursive: true });
	writeFileSync(path.join(sharedAssets, FAVICON_ASSET), FAVICON_BODY, 'utf8');

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

	return { outDir, webEntry, sharedAssets };
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

test('the icon the page links to is served from the shared tree', async () => {
	const server = await startFixtureServer();

	const response = await fetch(`${server.origin}${SHARED_ASSET_BASE}${FAVICON_ASSET}`);
	const body = await response.text();

	assert.equal(response.status, 200);
	assert.equal(body, FAVICON_BODY);
	// A favicon served as `application/octet-stream` is downloaded, not drawn.
	assert.match(response.headers.get('content-type') ?? '', /image\/svg\+xml/);
});

test('every shared asset the rendered page references is actually served', async () => {
	const server = await startFixtureServer();

	const html = await (await fetch(`${server.origin}${APP_ROUTE}`)).text();
	// The template's favicon default carries a leading space inside its quotes,
	// which a browser strips before requesting — so the fixture strips it too.
	const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
		.map((match) => match[1].trim())
		.filter((reference) => reference.startsWith(SHARED_ASSET_BASE) && !reference.startsWith(ASSET_BASE));

	assert.ok(references.length > 0, 'the entry template references shared assets, starting with its icon');
	for (const reference of references) {
		const response = await fetch(`${server.origin}${reference}`);
		await response.arrayBuffer();
		assert.equal(response.status, 200, reference);
	}
});

test('a shared asset that does not exist is a 404', async () => {
	const server = await startFixtureServer();

	const response = await fetch(`${server.origin}${SHARED_ASSET_BASE}images/no-such-logo.png`);
	const body = await response.text();

	assert.equal(response.status, 404);
	assert.ok(!body.includes('<html'), 'a missing icon must not be answered with the page');
});

test('a shared asset path cannot escape the shared directory', async () => {
	const server = await startFixtureServer();

	for (const suffix of ['..%2fwww%2fbanking.html', '%2e%2e%2fwww%2fbanking.html']) {
		const response = await fetch(`${server.origin}${SHARED_ASSET_BASE}${suffix}`);
		const body = await response.text();

		assert.equal(response.status, 403, suffix);
		assert.ok(!body.includes('<html'), 'no file outside the shared directory may be returned');
	}
});

test('a preview started without shared assets says so instead of pretending', async () => {
	const { outDir, webEntry } = createArtifacts();
	const running = await startPreviewServer({ outDir, webEntry, port: 0 });
	runningServers.push(running);

	const response = await fetch(`http://${running.host}:${String(running.port)}${SHARED_ASSET_BASE}${FAVICON_ASSET}`);
	const body = await response.text();

	assert.equal(response.status, 404);
	assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
	// The reason names the preview's own configuration: the icon is missing from
	// this server, not from the app.
	assert.match(body, /shared asset/);
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

	// The built router is mounted at `/banking` (`.env.production` sets
	// `VITE_BASE_NAME`), so these are the addresses a reload can actually land on.
	for (const route of [
		APP_ROUTE,
		`${APP_ROUTE}/statement-importer`,
		`${APP_ROUTE}/statement-importer/BSI-1`
	]) {
		const response = await fetch(`${server.origin}${route}`);
		const html = await response.text();

		assert.equal(response.status, 200, route);
		assert.match(html, /<div id="root">/, route);
	}
});

test('the site root sends the browser to the app instead of serving a second copy of it', async () => {
	const server = await startFixtureServer();

	const response = await fetch(`${server.origin}/?from=preview`, { redirect: 'manual' });
	await response.text();

	assert.equal(response.status, 302);
	// The query survives the move: a link into the preview must not lose it.
	assert.equal(response.headers.get('location'), `${APP_ROUTE}?from=preview`);
});

test('a path outside the app route is a 404, not the page under the wrong base', async () => {
	const server = await startFixtureServer();

	const response = await fetch(`${server.origin}/statement-importer`);
	const body = await response.text();

	assert.equal(response.status, 404);
	assert.ok(!body.includes('<div id="root">'), 'the page must not answer to an address the app never uses');
});

test('a realtime connection attempt is refused in plain text, not with the page', async () => {
	const server = await startFixtureServer();

	const response = await fetch(`${server.origin}/socket.io/?EIO=4&transport=polling`);
	const body = await response.text();

	assert.ok(response.status >= 400, 'the preview has no realtime backend and must say so');
	assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
	assert.ok(!body.includes('<html'), 'socket.io must never be handed HTML');
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
