/**
 * Static preview server for the isolated build.
 *
 * `yarn e2e:isolated-build` proves the app *builds* without bench's site
 * config. This serves what that build produced, the way bench serves it — the
 * page at `/banking`, its bundles under `/assets/erpnext/banking/` — so the
 * preview can be opened and the Banking screen looked at, instead of a
 * deployment failure screen.
 *
 * It is not a Frappe backend and does not pretend to be one. The page's
 * server-rendered placeholders are filled with a signed-in boot stub
 * (`./previewBoot.ts`) and every API call is answered empty
 * (`./previewApi.ts`), which is the least that lets the production entry path
 * run in a browser with no backend at all.
 *
 * Usage:
 *   node e2e/previewServer.ts --artifacts <build-report.json>
 *   node e2e/previewServer.ts --out-dir <dir> --web-entry <file> [--port n] [--host h]
 *
 * The artefacts file is what `yarn e2e:isolated-build --json` prints, so the
 * two halves of the harness compose without repeating any path.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { HarnessFailure, formatFailure, formatReport, type ReportDetail } from './buildReport.ts';
import { isApiPath, stubApiResponse } from './previewApi.ts';
import {
	PREVIEW_USER,
	UnknownPlaceholderError,
	createPlaceholderValues,
	createPreviewBoot,
	findUnresolvedPlaceholders,
	renderPreviewHtml
} from './previewBoot.ts';

/** Where bench serves this app's page. */
export const APP_ROUTE = '/banking';

/** Public base of the built assets, matching the build script's `--base`. */
export const ASSET_BASE = '/assets/erpnext/banking/';

/** Default port, following Vite's preview convention. */
export const DEFAULT_PORT = 4173;

/** Loopback by default: a preview build with a stubbed session is not for a network. */
export const DEFAULT_HOST = '127.0.0.1';

/** The cookie the app reads to decide it is not talking to a guest. */
const SESSION_COOKIE = `user_id=${PREVIEW_USER}; Path=/; SameSite=Lax`;

/** Content types for what a Vite build emits. Anything else is served as bytes. */
const CONTENT_TYPES: Record<string, string> = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.ico': 'image/x-icon',
	'.jpg': 'image/jpeg',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.ttf': 'font/ttf',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2'
};

const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

export interface PreviewServerOptions {
	/** Build output directory, served under {@link ASSET_BASE}. */
	outDir: string;
	/** The HTML entry bench would render, i.e. the copied `banking.html`. */
	webEntry: string;
	port?: number;
	host?: string;
}

export interface RunningPreviewServer {
	server: Server;
	port: number;
	host: string;
	/** Address of the app entry, ready to open. */
	url: string;
	close: () => Promise<void>;
}

function fail(
	stage: 'prepare' | 'verify' | 'serve',
	reason: string,
	fix: string,
	details: ReportDetail[],
	impact: string
): never {
	throw new HarnessFailure({ stage, reason, fix, details, impact });
}

/** The page is rendered once at startup: a preview serves one fixed session. */
function renderEntry(webEntry: string): string {
	let template: string;
	try {
		template = readFileSync(webEntry, 'utf8');
	} catch (error) {
		fail(
			'verify',
			`the built HTML entry could not be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message})`,
			'run `yarn e2e:isolated-build --json` first and pass its report with --artifacts',
			[{ label: 'Expected file', value: webEntry }],
			'the preview has no page to serve; opening it would show the deployment failure screen'
		);
	}

	let html: string;
	try {
		html = renderPreviewHtml(template, createPlaceholderValues(createPreviewBoot()));
	} catch (error) {
		if (error instanceof UnknownPlaceholderError) {
			fail(
				'verify',
				'the built HTML entry expects server-rendered values this preview does not provide',
				'add the missing values to the placeholder table in e2e/previewBoot.ts',
				[
					{ label: 'HTML entry', value: webEntry },
					{ label: 'Unknown placeholders', value: error.expressions.join(', ') }
				],
				'the page would reach the browser with unfilled placeholders and fail before rendering'
			);
		}
		throw error;
	}

	const leftovers = findUnresolvedPlaceholders(html);
	if (leftovers.length > 0) {
		fail(
			'verify',
			'the rendered page still contains server-side placeholders',
			'extend the placeholder pattern in e2e/previewBoot.ts to cover them',
			[
				{ label: 'HTML entry', value: webEntry },
				{ label: 'Unrendered', value: leftovers.join(', ') }
			],
			'the page would reach the browser with unfilled placeholders and fail before rendering'
		);
	}
	return html;
}

function assertOutDir(outDir: string): void {
	try {
		if (!statSync(outDir).isDirectory()) {
			throw new Error('not a directory');
		}
	} catch (error) {
		fail(
			'verify',
			`the build output directory is unusable (${(error as Error).message})`,
			'run `yarn e2e:isolated-build --json` first and pass its report with --artifacts',
			[{ label: 'Expected directory', value: outDir }],
			'the page would load without its bundles and render nothing'
		);
	}
}

function contentTypeFor(file: string): string {
	return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? FALLBACK_CONTENT_TYPE;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(payload)
	});
	response.end(payload);
}

function sendText(response: ServerResponse, status: number, body: string): void {
	response.writeHead(status, {
		'Content-Type': 'text/plain; charset=utf-8',
		'Content-Length': Buffer.byteLength(body)
	});
	response.end(body);
}

function sendPage(response: ServerResponse, html: string): void {
	response.writeHead(200, {
		'Content-Type': 'text/html; charset=utf-8',
		'Content-Length': Buffer.byteLength(html),
		// Bench marks this page `no_cache`; a stale preview page pointing at
		// bundles from an earlier build is the worst kind of confusing.
		'Cache-Control': 'no-store',
		'Set-Cookie': SESSION_COOKIE
	});
	response.end(html);
}

/**
 * Resolves an asset request to a file inside the build output.
 *
 * Returns `undefined` for anything that escapes the output directory: the
 * request path is attacker-controlled input, and `..` in it must never be able
 * to read the rest of the filesystem.
 */
function resolveAsset(outDir: string, pathname: string): string | undefined {
	let relative: string;
	try {
		relative = decodeURIComponent(pathname.slice(ASSET_BASE.length));
	} catch {
		return undefined;
	}
	if (relative === '' || relative.includes('\0')) {
		return undefined;
	}
	const resolved = path.resolve(outDir, relative);
	const root = path.resolve(outDir);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		return undefined;
	}
	return resolved;
}

function serveAsset(outDir: string, pathname: string, response: ServerResponse): void {
	const file = resolveAsset(outDir, pathname);
	if (!file) {
		sendText(response, 403, 'asset path escapes the build output directory');
		return;
	}
	let contents: Buffer;
	try {
		contents = readFileSync(file);
	} catch {
		sendText(response, 404, `no built asset at ${pathname}`);
		return;
	}
	response.writeHead(200, {
		'Content-Type': contentTypeFor(file),
		'Content-Length': contents.byteLength
	});
	response.end(contents);
}

/**
 * True when the path should get the app page.
 *
 * The built app runs its router at the site root (no `VITE_BASE_NAME` is set
 * during this build), so it navigates to paths like `/` and
 * `/statement-importer` as well as the `/banking` entry. Reloading any of them
 * must return the page, while a request that names a file gets an honest 404
 * rather than HTML pretending to be a bundle.
 */
function isPageRequest(pathname: string): boolean {
	if (pathname === '/' || pathname === APP_ROUTE || pathname.startsWith(`${APP_ROUTE}/`)) {
		return true;
	}
	return !path.extname(pathname);
}

function handle(options: { outDir: string; html: string }, request: IncomingMessage, response: ServerResponse): void {
	const { pathname } = new URL(request.url ?? '/', 'http://preview.invalid');
	const method = request.method ?? 'GET';

	if (isApiPath(pathname)) {
		const stub = stubApiResponse(pathname);
		sendJson(response, stub.status, stub.body);
		return;
	}

	if (method !== 'GET' && method !== 'HEAD') {
		sendText(response, 405, `${method} is not served by the preview`);
		return;
	}

	if (pathname.startsWith(ASSET_BASE)) {
		serveAsset(options.outDir, pathname, response);
		return;
	}

	if (isPageRequest(pathname)) {
		sendPage(response, options.html);
		return;
	}

	sendText(response, 404, `the preview serves ${APP_ROUTE} and ${ASSET_BASE}, not ${pathname}`);
}

/**
 * Starts the preview server.
 *
 * The page is rendered and the output directory checked *before* the socket
 * opens, so a preview that cannot work never reports itself as ready.
 */
export async function startPreviewServer(options: PreviewServerOptions): Promise<RunningPreviewServer> {
	const outDir = path.resolve(options.outDir);
	const html = renderEntry(path.resolve(options.webEntry));
	assertOutDir(outDir);

	const host = options.host ?? DEFAULT_HOST;
	const requestedPort = options.port ?? DEFAULT_PORT;
	const server = createServer((request, response) => {
		handle({ outDir, html }, request, response);
	});

	const port = await new Promise<number>((resolve, reject) => {
		const onListenError = (error: Error) => reject(error);
		server.once('error', onListenError);
		server.listen(requestedPort, host, () => {
			// Only startup failures belong to this promise; later socket errors
			// must not be swallowed by an already-settled one.
			server.off('error', onListenError);
			const address = server.address();
			resolve(typeof address === 'object' && address !== null ? address.port : requestedPort);
		});
	}).catch((error: NodeJS.ErrnoException) => {
		fail(
			'serve',
			`the preview server could not listen on ${host}:${String(requestedPort)} (${error.code ?? error.message})`,
			'stop whatever holds the address, or pass a free one with --port',
			[{ label: 'Address', value: `${host}:${String(requestedPort)}` }],
			'the built artefacts exist but the preview is not reachable at that address'
		);
	});

	return {
		server,
		port,
		host,
		url: `http://${host}:${String(port)}${APP_ROUTE}`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			})
	};
}

interface CliOptions extends PreviewServerOptions {
	artifacts?: string;
}

function readFlag(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	if (index === -1) {
		return undefined;
	}
	const value = argv[index + 1];
	if (value === undefined || value.startsWith('--')) {
		fail(
			'prepare',
			`${flag} was given without a value`,
			`pass a value after ${flag}`,
			[{ label: 'Arguments', value: argv.join(' ') }],
			'the preview server did not start'
		);
	}
	return value;
}

function readPort(argv: string[]): number | undefined {
	const raw = readFlag(argv, '--port');
	if (raw === undefined) {
		return undefined;
	}
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		fail(
			'prepare',
			`--port="${raw}" is not a port number`,
			'pass an integer between 0 and 65535, or omit --port',
			[],
			'the preview server did not start'
		);
	}
	return port;
}

/**
 * Extracts the report object from a captured stdout.
 *
 * `yarn` prints its own banner around the script's output, so a redirected
 * `yarn e2e:isolated-build --json` file is JSON with prose either side of it.
 * Reading from the first brace to the last keeps the two commands composable
 * without asking the caller to strip anything.
 */
function extractJson(contents: string): string {
	const start = contents.indexOf('{');
	const end = contents.lastIndexOf('}');
	return start === -1 || end < start ? contents : contents.slice(start, end + 1);
}

/** Reads the paths from the build harness report, so neither half repeats the other's layout. */
function readArtifacts(file: string): { outDir: string; webEntry: string } {
	let parsed: { outDir?: unknown; webEntry?: unknown };
	try {
		parsed = JSON.parse(extractJson(readFileSync(file, 'utf8')));
	} catch (error) {
		fail(
			'prepare',
			`the artefacts report could not be read (${(error as Error).message})`,
			'pass the JSON printed by `yarn e2e:isolated-build --json`',
			[{ label: 'Report', value: file }],
			'the preview server did not start'
		);
	}
	if (typeof parsed.outDir !== 'string' || typeof parsed.webEntry !== 'string') {
		fail(
			'prepare',
			'the artefacts report has no outDir/webEntry paths',
			'pass the JSON printed by `yarn e2e:isolated-build --json`',
			[{ label: 'Report', value: file }],
			'the preview server did not start'
		);
	}
	return { outDir: parsed.outDir, webEntry: parsed.webEntry };
}

function parseArgs(argv: string[]): CliOptions {
	const artifacts = readFlag(argv, '--artifacts');
	const port = readPort(argv);
	const host = readFlag(argv, '--host');
	const outDir = readFlag(argv, '--out-dir');
	const webEntry = readFlag(argv, '--web-entry');

	if (artifacts) {
		const paths = readArtifacts(artifacts);
		return { ...paths, outDir: outDir ?? paths.outDir, webEntry: webEntry ?? paths.webEntry, port, host, artifacts };
	}
	if (!outDir || !webEntry) {
		fail(
			'prepare',
			'no build artefacts were named',
			'pass --artifacts <report.json> from `yarn e2e:isolated-build --json`, or both --out-dir and --web-entry',
			[{ label: 'Arguments', value: argv.join(' ') || '(none)' }],
			'the preview server did not start'
		);
	}
	return { outDir, webEntry, port, host };
}

/** The one block this process prints while it runs: what is up, where, and on what terms. */
export function formatReadyNotice(running: RunningPreviewServer, options: PreviewServerOptions): string {
	return formatReport('Preview server ready', 'the isolated build is being served with a signed-in boot stub', [
		{ label: 'App', value: running.url },
		{ label: 'Assets', value: `http://${running.host}:${String(running.port)}${ASSET_BASE}` },
		{ label: 'Serving', value: path.resolve(options.outDir) },
		{ label: 'Page', value: path.resolve(options.webEntry) },
		{
			label: 'Stubbed',
			value: `boot payload for ${PREVIEW_USER}; every /api/ call answers with an empty payload`
		},
		{ label: 'Stop', value: 'press Ctrl-C' }
	]);
}

async function main(argv: string[]): Promise<number> {
	try {
		const options = parseArgs(argv);
		const running = await startPreviewServer(options);
		console.log(formatReadyNotice(running, options));
		for (const signal of ['SIGINT', 'SIGTERM'] as const) {
			process.once(signal, () => {
				void running.close().then(() => {
					process.exit(0);
				});
			});
		}
		return 0;
	} catch (error) {
		if (error instanceof HarnessFailure) {
			console.error(formatFailure(error.report));
			return 1;
		}
		throw error;
	}
}

// Only the CLI invocation starts a server; importing this module for tests must not.
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
	process.exitCode = await main(process.argv.slice(2));
}
