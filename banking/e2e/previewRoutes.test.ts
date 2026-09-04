import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_ROUTE, ASSET_BASE, classifyRequest, SOCKET_ROUTE } from './previewRoutes.ts';

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

test('a path outside the app route is not the page', () => {
	// The built bundle never navigates here — answering with HTML would hide the
	// fact that the caller is using the wrong base.
	for (const route of ['/statement-importer', '/statement-importer/BSI-1', '/app', '/login']) {
		assert.deepEqual(classifyRequest(route), { kind: 'unserved' }, route);
	}
});

test('a request that names a file is never answered with the page', () => {
	for (const route of [`${APP_ROUTE}/vite.svg`, `${APP_ROUTE}/assets/index.js`, '/favicon.ico']) {
		assert.notEqual(classifyRequest(route).kind, 'page', route);
	}
});

test('built assets are claimed by their public base', () => {
	assert.deepEqual(classifyRequest(`${ASSET_BASE}assets/index-abc123.js`), { kind: 'asset' });
	// Claimed by base, not by what is on disk: a missing bundle must stay a
	// question about a bundle rather than becoming a page.
	assert.deepEqual(classifyRequest(`${ASSET_BASE}assets/does-not-exist.js`), { kind: 'asset' });
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
