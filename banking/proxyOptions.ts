import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';

/**
 * Dev-server-only proxy configuration.
 *
 * The Vite dev server forwards backend routes to the bench web server. The port
 * it forwards to lives in bench's `sites/common_site_config.json`, which only
 * exists inside a bench checkout — it is not available during a production
 * build and must therefore never be read at module load time.
 */

/** Bench's common site config, resolved from `apps/{app}/banking/`. */
const COMMON_SITE_CONFIG_URL = new URL('../../../sites/common_site_config.json', import.meta.url);

/** Routes that belong to the Frappe backend rather than to the dev server. */
const BACKEND_ROUTE_PATTERN = '^/(app|api|assets|files|private)';

/** Optional explicit override, named after the existing `VITE_*` variables used by the app. */
const PORT_OVERRIDE_ENV_VAR = 'VITE_PROXY_PORT';

/** Prefix for every message this module prints, so dev-server output stays attributable. */
const LOG_PREFIX = '[banking]';

export interface BackendProxyOptions {
	target: string;
	ws: boolean;
	router: (req: IncomingMessage) => string;
}

export type ProxyOptions = Record<string, BackendProxyOptions>;

type PortLookup = { ok: true; port: string } | { ok: false; cause: string };

/**
 * Accepts only what can safely become a proxy target. A malformed value is
 * rejected rather than interpolated into a URL that would silently fail.
 */
function normalizePort(value: unknown): string | undefined {
	const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
	if (!/^\d+$/.test(raw)) {
		return undefined;
	}
	const port = Number(raw);
	return port >= 1 && port <= 65535 ? raw : undefined;
}

/** Reads `webserver_port` from the site config, describing why it failed instead of throwing. */
function readPortFromSiteConfig(): PortLookup {
	let contents: string;
	try {
		contents = readFileSync(COMMON_SITE_CONFIG_URL, 'utf8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === 'ENOENT'
			? { ok: false, cause: 'the site config file does not exist (ENOENT)' }
			: { ok: false, cause: `the site config file could not be read (${code ?? (error as Error).message})` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch (error) {
		return { ok: false, cause: `the site config file is not valid JSON (${(error as Error).message})` };
	}

	const port = normalizePort((parsed as { webserver_port?: unknown } | null)?.webserver_port);
	return port
		? { ok: true, port }
		: { ok: false, cause: 'the site config file has no usable `webserver_port` value' };
}

function warnProxyDisabled(cause: string): void {
	console.warn(
		[
			`${LOG_PREFIX} Dev server proxy disabled — ${cause}.`,
			`${LOG_PREFIX}   Config file: ${fileURLToPath(COMMON_SITE_CONFIG_URL)}`,
			`${LOG_PREFIX}   Fix: start the dev server from a bench checkout so that file resolves, or set ${PORT_OVERRIDE_ENV_VAR}=<webserver_port>.`,
			`${LOG_PREFIX}   Until then requests matching ${BACKEND_ROUTE_PATTERN} are not proxied; the dev server keeps running.`
		].join('\n')
	);
}

function buildProxyOptions(port: string): ProxyOptions {
	return {
		[BACKEND_ROUTE_PATTERN]: {
			target: `http://127.0.0.1:${port}`,
			ws: true,
			router: function (req: IncomingMessage) {
				const site_name = req.headers?.host?.split(':')[0];
				return `http://${site_name ?? 'localhost'}:${port}`;
			}
		}
	};
}

/**
 * Builds the dev-server proxy configuration.
 *
 * Returns `undefined` when no trustworthy backend port can be determined — the
 * caller then starts the dev server without a proxy instead of forwarding
 * requests to a guessed port.
 */
export function getProxyOptions(): ProxyOptions | undefined {
	const override = process.env[PORT_OVERRIDE_ENV_VAR];
	if (override !== undefined && override.trim() !== '') {
		const overridePort = normalizePort(override);
		if (overridePort) {
			return buildProxyOptions(overridePort);
		}
		console.warn(
			`${LOG_PREFIX} Ignoring ${PORT_OVERRIDE_ENV_VAR}="${override}" — not a valid port number; falling back to the site config file.`
		);
	}

	const lookup = readPortFromSiteConfig();
	if (!lookup.ok) {
		warnProxyDisabled(lookup.cause);
		return undefined;
	}
	return buildProxyOptions(lookup.port);
}
