import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile, type UserConfig } from 'vite';

const CONFIG_PATH = fileURLToPath(new URL('./vite.config.ts', import.meta.url));
const BACKEND_ROUTE_PATTERN = '^/(app|api|assets|files|private)';
const OVERRIDE_ENV_VAR = 'VITE_PROXY_PORT';

/**
 * Loads the config the same way Vite itself does, so the assertions cover the
 * real evaluation path (function form, command, lazy proxy import) rather than
 * a hand-rolled approximation. `console.warn` is captured because the absence
 * of proxy warnings is how we observe that `proxyOptions` stayed untouched.
 */
async function loadConfig(
	command: 'build' | 'serve',
	override?: string
): Promise<{ config: UserConfig; warnings: string[] }> {
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
		const loaded = await loadConfigFromFile({ command, mode: 'production' }, CONFIG_PATH);
		assert.ok(loaded, 'vite could not load the config file');
		return { config: loaded.config, warnings };
	} finally {
		console.warn = originalWarn;
		if (originalOverride === undefined) {
			delete process.env[OVERRIDE_ENV_VAR];
		} else {
			process.env[OVERRIDE_ENV_VAR] = originalOverride;
		}
	}
}

/**
 * The build options as they stood before the config became command-aware.
 * Any drift here is a production-output regression, not a refactor.
 */
test('build options are unchanged by the command-aware config', async () => {
	for (const command of ['build', 'serve'] as const) {
		const { config } = await loadConfig(command);
		assert.equal(config.build?.outDir, '../erpnext/public/banking', command);
		assert.equal(config.build?.emptyOutDir, true, command);
		assert.equal(config.build?.target, 'es2015', command);
		assert.equal(config.base, undefined, command);

		const output = config.build?.rollupOptions?.output;
		assert.ok(output && !Array.isArray(output), `${command}: rollup output object expected`);
		const manualChunks = output.manualChunks;
		assert.equal(typeof manualChunks, 'function', command);
		const chunkOf = (id: string) => (manualChunks as (id: string) => string | undefined)(id);
		assert.equal(chunkOf('/src/App.tsx'), undefined, command);
		assert.equal(chunkOf('/node_modules/react-dom/index.js'), 'vendor-react', command);
		assert.equal(chunkOf('/node_modules/react/index.js'), 'vendor-react', command);
		assert.equal(chunkOf('/node_modules/frappe-react-sdk/dist/index.js'), 'vendor-frappe', command);
		assert.equal(chunkOf('/node_modules/@tanstack/react-table/index.js'), 'vendor-tanstack', command);
		assert.equal(chunkOf('/node_modules/fuse.js/dist/fuse.js'), 'vendor-fuse', command);
		assert.equal(chunkOf('/node_modules/@radix-ui/react-dialog/index.js'), 'vendor-radix', command);
		assert.equal(chunkOf('/node_modules/jotai/index.js'), 'vendor-jotai', command);
		assert.equal(chunkOf('/node_modules/lucide-react/dist/index.js'), 'vendor-lucide', command);
		assert.equal(chunkOf('/node_modules/dayjs/dayjs.min.js'), undefined, command);
	}
});

test('shared options survive the switch to a function config', async () => {
	for (const command of ['build', 'serve'] as const) {
		const { config } = await loadConfig(command);
		assert.equal(config.server?.port, 8080, command);
		assert.equal(config.server?.host, '0.0.0.0', command);
		assert.equal(config.plugins?.length, 2, command);
		const alias = config.resolve?.alias as Record<string, string>;
		assert.ok(alias['@'].endsWith('/src'), `${command}: '@' alias should resolve to src`);
	}
});

test('build never evaluates the dev-only proxy configuration', async () => {
	// No site config exists in this checkout, so evaluating `proxyOptions`
	// would necessarily warn. Silence proves it was never reached.
	const { config, warnings } = await loadConfig('build');
	assert.equal(config.server?.proxy, undefined);
	assert.deepEqual(warnings, []);
});

test('serve without a resolvable port warns and starts without a proxy', async () => {
	const { config, warnings } = await loadConfig('serve');
	assert.equal(config.server?.proxy, undefined);
	assert.ok(
		warnings.some((warning) => warning.includes('Dev server proxy disabled')),
		`expected a proxy-disabled warning, got: ${JSON.stringify(warnings)}`
	);
});

test('serve applies the proxy when a backend port is available', async () => {
	const { config } = await loadConfig('serve', '8001');
	const proxy = config.server?.proxy as
		| Record<string, { target: string; ws: boolean; router: (req: unknown) => string }>
		| undefined;
	assert.ok(proxy, 'expected the backend proxy rule to be configured');
	const rule = proxy[BACKEND_ROUTE_PATTERN];
	assert.equal(rule.target, 'http://127.0.0.1:8001');
	assert.equal(rule.ws, true);
	assert.equal(rule.router({ headers: { host: 'banking.localhost:8080' } }), 'http://banking.localhost:8001');
});
