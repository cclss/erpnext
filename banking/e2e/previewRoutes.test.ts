import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_ROUTE, ASSET_BASE, SHARED_ASSET_BASE, classifyRequest, SOCKET_ROUTE } from './previewRoutes.ts';

test('the site root sends the client to the address the app is built for', () => {
	assert.deepEqual(classifyRequest('/'), { kind: 'redirect', location: APP_ROUTE });
});

test('the app route and everything under it is the page', () => {
	// These are the built router's own paths: `.env.production` mounts it at
	// `/banking`, so a reload of any of them has to come back as the page.
	for (const route of [
		APP_ROUTE,
		`${APP_ROUTE}/`,
		`${APP_ROUTE}/statement-importer`,
		`${APP_ROUTE}/statement-importer/BSI-1`
	]) {
		assert.deepEqual(classifyRequest(route), { kind: 'page' }, route);
	}
});

test('a document name with dots in it is a screen, not a file', () => {
	// Frappe naming series separate their parts with dots, so this is what a
	// shared link to an import log looks like. Read as a file name, `.1` is an
	// extension and the address that opened a screen answers `404` instead.
	for (const route of [
		`${APP_ROUTE}/statement-importer/BSI.2026.1`,
		`${APP_ROUTE}/statement-importer/ACC-BSI-2026.00001`,
		`${APP_ROUTE}/statement-importer/BSI.2026.REVISED`
	]) {
		assert.deepEqual(classifyRequest(route), { kind: 'page' }, route);
	}
});

test('a path outside the app route is not the page', () => {
	// The built bundle never navigates here — answering with HTML would hide the
	// fact that the caller is using the wrong base.
	for (const route of ['/statement-importer', '/statement-importer/BSI-1', '/app', '/login']) {
		assert.deepEqual(classifyRequest(route), { kind: 'unserved' }, route);
	}
});

test('a request that names a file is never answered with the page', () => {
	// Every extension a Vite build emits, including the longest one: a bundle
	// answered with HTML is a `200` that fails deep inside the browser instead.
	for (const route of [
		`${APP_ROUTE}/vite.svg`,
		`${APP_ROUTE}/assets/index.js`,
		`${APP_ROUTE}/assets/index-abc123.css`,
		`${APP_ROUTE}/assets/inter.woff2`,
		'/favicon.ico'
	]) {
		assert.notEqual(classifyRequest(route).kind, 'page', route);
	}
});

test('built assets are claimed by their public base', () => {
	assert.deepEqual(classifyRequest(`${ASSET_BASE}assets/index-abc123.js`), { kind: 'asset' });
	// Claimed by base, not by what is on disk: a missing bundle must stay a
	// question about a bundle rather than becoming a page.
	assert.deepEqual(classifyRequest(`${ASSET_BASE}assets/does-not-exist.js`), { kind: 'asset' });
});

test('the shared tree the build output lives in is its own kind of asset', () => {
	// The page links to this favicon and the app loads its bank logos from the
	// same tree; they are bench's files, served from a different directory than
	// anything this build produced.
	for (const route of [
		`${SHARED_ASSET_BASE}images/erpnext-favicon.svg`,
		`${SHARED_ASSET_BASE}images/bank-logos/hdfc.png`
	]) {
		assert.deepEqual(classifyRequest(route), { kind: 'shared-asset' }, route);
	}
});

test('the build output keeps its own base inside the shared one', () => {
	// `/assets/erpnext/banking/` is a prefix of `/assets/erpnext/`; matching the
	// wider base first would send every bundle looking in the wrong directory.
	assert.ok(ASSET_BASE.startsWith(SHARED_ASSET_BASE), 'the build output is served from inside the shared tree');
	assert.deepEqual(classifyRequest(`${ASSET_BASE}assets/index-abc123.js`), { kind: 'asset' });
});

test('backend calls are claimed before any page rule can reach them', () => {
	assert.deepEqual(classifyRequest('/api/method/frappe.client.get_count'), { kind: 'api' });
	assert.deepEqual(classifyRequest('/api/resource/Company'), { kind: 'api' });
});

test('the realtime endpoint is its own kind, not a page', () => {
	// socket.io polls this path expecting a protocol payload; HTML there is
	// answered as if the transport worked and fails somewhere else entirely.
	for (const route of [SOCKET_ROUTE, `${SOCKET_ROUTE}/`]) {
		assert.deepEqual(classifyRequest(route), { kind: 'socket' }, route);
	}
});
