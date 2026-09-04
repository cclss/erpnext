import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_PATH = fileURLToPath(new URL('./proxyOptions.ts', import.meta.url));
const BACKEND_ROUTE_PATTERN = '^/(app|api|assets|files|private)';
const OVERRIDE_ENV_VAR = 'VITE_PROXY_PORT';

type ProxyModule = typeof import('./proxyOptions.ts');

/**
 * Copies the module into a throwaway bench-shaped tree so the real relative
 * path to `sites/common_site_config.json` is exercised, with the site config
 * present, absent or corrupt as the case requires.
 */
async function loadInBench(siteConfig?: string): Promise<ProxyModule> {
	const root = mkdtempSync(path.join(tmpdir(), 'banking-proxy-'));
	const appDir = path.join(root, 'apps', 'erpnext', 'banking');
	mkdirSync(appDir, { recursive: true });
	cpSync(MODULE_PATH, path.join(appDir, 'proxyOptions.ts'));
	if (siteConfig !== undefined) {
		mkdirSync(path.join(root, 'sites'), { recursive: true });
		writeFileSync(path.join(root, 'sites', 'common_site_config.json'), siteConfig);
	}
	return (await import(pathToFileURL(path.join(appDir, 'proxyOptions.ts')).href)) as ProxyModule;
}

/** Runs `fn` with `console.warn` captured and the override variable unset unless given. */
async function capture(
	fn: () => unknown,
	override?: string
): Promise<{ result: unknown; warnings: string[] }> {
	const originalWarn = console.warn;
	const originalOverride = process.env[OVERRIDE_ENV_VAR];
	const warnings: string[] = [];
	console.warn = (...args: unknown[]) => {
		warnings.push(args.map(String).join(' '));
	};
	if (override === undefined) {
		delete process.env[OVERRIDE_ENV_VAR];
	} else {
		process.env[OVERRIDE_ENV_VAR] = override;
	}
	try {
		return { result: await fn(), warnings };
	} finally {
		console.warn = originalWarn;
		if (originalOverride === undefined) {
			delete process.env[OVERRIDE_ENV_VAR];
		} else {
			process.env[OVERRIDE_ENV_VAR] = originalOverride;
		}
	}
}

test('module import does not read the site config', async () => {
	const { warnings } = await capture(() => loadInBench());
	assert.deepEqual(warnings, []);
});

test('valid site config keeps the existing proxy rule, target and host router', async () => {
	const proxyModule = await loadInBench(JSON.stringify({ webserver_port: 8000, db_host: 'localhost' }));
	const { result, warnings } = await capture(() => proxyModule.getProxyOptions());
	const options = result as Record<string, { target: string; ws: boolean; router: (req: unknown) => string }>;

	assert.deepEqual(Object.keys(options), [BACKEND_ROUTE_PATTERN]);
	const rule = options[BACKEND_ROUTE_PATTERN];
	assert.equal(rule.target, 'http://127.0.0.1:8000');
	assert.equal(rule.ws, true);
	assert.equal(rule.router({ headers: { host: 'mysite.localhost:8080' } }), 'http://mysite.localhost:8000');
	assert.equal(rule.router({ headers: { host: 'mysite.localhost' } }), 'http://mysite.localhost:8000');
	assert.equal(rule.router({ headers: {} }), 'http://localhost:8000');
	assert.equal(rule.router({}), 'http://localhost:8000');
	assert.deepEqual(warnings, []);
});

test('string webserver_port is used verbatim, as before', async () => {
	const proxyModule = await loadInBench(JSON.stringify({ webserver_port: '8001' }));
	const { result } = await capture(() => proxyModule.getProxyOptions());
	assert.equal((result as Record<string, { target: string }>)[BACKEND_ROUTE_PATTERN].target, 'http://127.0.0.1:8001');
});

test('missing site config disables the proxy with an ENOENT warning', async () => {
	const proxyModule = await loadInBench();
	const { result, warnings } = await capture(() => proxyModule.getProxyOptions());

	assert.equal(result, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /does not exist \(ENOENT\)/);
	assert.match(warnings[0], /common_site_config\.json/);
	assert.match(warnings[0], /proxy disabled/i);
	assert.doesNotMatch(warnings[0], /JSON,/);
});

test('corrupt site config disables the proxy with a parse-failure warning', async () => {
	const proxyModule = await loadInBench('{ "webserver_port": 8000,,, }');
	const { result, warnings } = await capture(() => proxyModule.getProxyOptions());

	assert.equal(result, undefined);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /not valid JSON/);
	assert.match(warnings[0], /common_site_config\.json/);
	assert.doesNotMatch(warnings[0], /ENOENT/);
});

test('site config without a usable webserver_port disables the proxy', async () => {
	const proxyModule = await loadInBench(JSON.stringify({ webserver_port: 'not-a-port' }));
	const { result, warnings } = await capture(() => proxyModule.getProxyOptions());

	assert.equal(result, undefined);
	assert.match(warnings[0], /webserver_port/);
});

test('port override is used without touching the site config', async () => {
	const proxyModule = await loadInBench();
	const { result, warnings } = await capture(() => proxyModule.getProxyOptions(), '9000');

	const options = result as Record<string, { target: string; router: (req: unknown) => string }>;
	assert.equal(options[BACKEND_ROUTE_PATTERN].target, 'http://127.0.0.1:9000');
	assert.equal(options[BACKEND_ROUTE_PATTERN].router({ headers: { host: 'site:8080' } }), 'http://site:9000');
	assert.deepEqual(warnings, []);
});

test('invalid port override warns and falls back to the site config', async () => {
	const proxyModule = await loadInBench(JSON.stringify({ webserver_port: 8000 }));
	const { result, warnings } = await capture(() => proxyModule.getProxyOptions(), 'eighty');

	assert.equal((result as Record<string, { target: string }>)[BACKEND_ROUTE_PATTERN].target, 'http://127.0.0.1:8000');
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], new RegExp(OVERRIDE_ENV_VAR));
});
