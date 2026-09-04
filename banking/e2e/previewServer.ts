/**
 * Static preview server for the isolated build.
 *
 * `yarn e2e:isolated-build` proves the app *builds* without bench's site
 * config. This serves what that build produced, the way bench serves it — the
 * page at `/banking`, its bundles under `/assets/erpnext/banking/`, and the
 * erpnext app's shared icons and logos under `/assets/erpnext/` — so the
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
 *   node e2e/previewServer.ts --out-dir <dir> --web-entry <file> [--shared-assets <dir>] [--port n] [--host h]
 *
 * The artefacts file is what `yarn e2e:isolated-build --json` prints, so the
 * two halves of the harness compose without repeating any path.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { HarnessFailure, formatFailure, formatReport, type ReportDetail } from './buildReport.ts';
import { stubApiResponse } from './previewApi.ts';
import { APP_ROUTE, ASSET_BASE, SHARED_ASSET_BASE, classifyRequest } from './previewRoutes.ts';
import {
	PREVIEW_USER,
	UnknownPlaceholderError,
	createPlaceholderValues,
	createPreviewBoot,
	findUnresolvedPlaceholders,
	renderPreviewHtml
} from './previewBoot.ts';

// Re-exported so callers of this server get its addresses from the server
// itself, while the routing rules stay in one testable place.
export { APP_ROUTE, ASSET_BASE, SHARED_ASSET_BASE } from './previewRoutes.ts';

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
	/**
	 * The erpnext app's `public/` directory, served under
	 * {@link SHARED_ASSET_BASE}. This is where the favicon the page links to and
	 * the bank logos the app loads actually live — they are bench's assets, not
	 * this build's output. Omitting it leaves those requests answered as
	 * unserved rather than guessed at.
	 */
	sharedAssets?: string;
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

function assertDirectory(directory: string, what: string, impact: string): void {
	try {
		if (!statSync(directory).isDirectory()) {
			throw new Error('not a directory');
		}
	} catch (error) {
		fail(
			'verify',
			`the ${what} directory is unusable (${(error as Error).message})`,
			'run `yarn e2e:isolated-build --json` first and pass its report with --artifacts',
			[{ label: 'Expected directory', value: directory }],
			impact
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

function sendRedirect(response: ServerResponse, location: string): void {
	// 302, not 301: a permanent redirect is cached by the browser for the whole
	// origin, and the next preview on this port would inherit it.
	response.writeHead(302, { Location: location, 'Content-Length': 0 });
	response.end();
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

/** A directory of files and the public base it answers to. */
interface AssetRoot {
	/** Directory on disk. `undefined` when this preview was started without one. */
	directory: string | undefined;
	/** Public base the request paths carry. */
	base: string;
	/** What these files are, used in the one-line refusals. */
	what: string;
}

/**
 * Resolves an asset request to a file inside its own root.
 *
 * Returns `undefined` for anything that escapes that root: the request path is
 * attacker-controlled input, and `..` in it must never be able to read the rest
 * of the filesystem — including the sibling directories of a root that happens
 * to sit inside another one.
 */
function resolveAsset(directory: string, base: string, pathname: string): string | undefined {
	let relative: string;
	try {
		relative = decodeURIComponent(pathname.slice(base.length));
	} catch {
		return undefined;
	}
	if (relative === '' || relative.includes('\0')) {
		return undefined;
	}
	const resolved = path.resolve(directory, relative);
	const root = path.resolve(directory);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		return undefined;
	}
	return resolved;
}

function serveAsset(root: AssetRoot, pathname: string, response: ServerResponse): void {
	if (root.directory === undefined) {
		// Better a stated absence than a silent one: the caller learns the file
		// is missing from this preview's configuration, not from the app.
		sendText(response, 404, `the preview was started without a ${root.what} directory, so ${pathname} is not served`);
		return;
	}
	const file = resolveAsset(root.directory, root.base, pathname);
	if (!file) {
		sendText(response, 403, `asset path escapes the ${root.what} directory`);
		return;
	}
	let contents: Buffer;
	try {
		contents = readFileSync(file);
	} catch {
		sendText(response, 404, `no ${root.what} at ${pathname}`);
		return;
	}
	response.writeHead(200, {
		'Content-Type': contentTypeFor(file),
		'Content-Length': contents.byteLength
	});
	response.end(contents);
}

/**
 * Answers one request according to what {@link classifyRequest} says it is.
 *
 * Every branch ends the response. Which branch a path takes is decided in
 * `./previewRoutes.ts` and tested there without a socket; this function only
 * turns that decision into bytes.
 */
function handle(
	options: { outDir: string; sharedAssets: string | undefined; html: string },
	request: IncomingMessage,
	response: ServerResponse
): void {
	const { pathname, search } = new URL(request.url ?? '/', 'http://preview.invalid');
	const method = request.method ?? 'GET';
	const route = classifyRequest(pathname);

	// The stub answers POSTs too: the app's report and search calls are POSTs,
	// so the method check below belongs to the routes a browser *navigates* to.
	if (route.kind === 'api') {
		const stub = stubApiResponse(pathname);
		sendJson(response, stub.status, stub.body);
		return;
	}

	if (method !== 'GET' && method !== 'HEAD') {
		sendText(response, 405, `${method} is not served by the preview`);
		return;
	}

	switch (route.kind) {
		case 'socket':
			// There is no realtime backend to reach. Saying so in plain text lets
			// the client fail its handshake and fall silent; HTML here would be
			// answered as if the transport had worked.
			sendText(response, 501, `the preview has no realtime backend behind ${pathname}`);
			return;
		case 'asset':
			serveAsset({ directory: options.outDir, base: ASSET_BASE, what: 'built asset' }, pathname, response);
			return;
		case 'shared-asset':
			// Bench serves these from the erpnext app itself; the page links to
			// its favicon and the app loads bank logos from here, so a preview
			// that only serves its own output shows a broken icon it did not break.
			serveAsset(
				{ directory: options.sharedAssets, base: SHARED_ASSET_BASE, what: 'shared asset' },
				pathname,
				response
			);
			return;
		case 'redirect':
			sendRedirect(response, `${route.location}${search}`);
			return;
		case 'page':
			sendPage(response, options.html);
			return;
		case 'unserved':
			sendText(response, 404, `the preview serves ${APP_ROUTE} and ${SHARED_ASSET_BASE}, not ${pathname}`);
			return;
	}
}

/**
 * Starts the preview server.
 *
 * The page is rendered and the output directory checked *before* the socket
 * opens, so a preview that cannot work never reports itself as ready.
 */
export async function startPreviewServer(options: PreviewServerOptions): Promise<RunningPreviewServer> {
	const outDir = path.resolve(options.outDir);
	const sharedAssets = options.sharedAssets === undefined ? undefined : path.resolve(options.sharedAssets);
	const html = renderEntry(path.resolve(options.webEntry));
	assertDirectory(outDir, 'build output', 'the page would load without its bundles and render nothing');
	if (sharedAssets !== undefined) {
		assertDirectory(
			sharedAssets,
			'shared asset',
			'the page would load without the icons and logos it references'
		);
	}

	const host = options.host ?? DEFAULT_HOST;
	const requestedPort = options.port ?? DEFAULT_PORT;
	const server = createServer((request, response) => {
		handle({ outDir, sharedAssets, html }, request, response);
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
function readArtifacts(file: string): { outDir: string; webEntry: string; sharedAssets: string } {
	let parsed: { outDir?: unknown; webEntry?: unknown; sharedAssets?: unknown };
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
	if (typeof parsed.outDir !== 'string' || typeof parsed.webEntry !== 'string' || typeof parsed.sharedAssets !== 'string') {
		fail(
			'prepare',
			'the artefacts report has no outDir/webEntry/sharedAssets paths',
			'pass the JSON printed by a current `yarn e2e:isolated-build --json`; a report from an older harness is missing paths this server serves',
			[{ label: 'Report', value: file }],
			'the preview server did not start'
		);
	}
	return { outDir: parsed.outDir, webEntry: parsed.webEntry, sharedAssets: parsed.sharedAssets };
}

function parseArgs(argv: string[]): CliOptions {
	const artifacts = readFlag(argv, '--artifacts');
	const port = readPort(argv);
	const host = readFlag(argv, '--host');
	const outDir = readFlag(argv, '--out-dir');
	const webEntry = readFlag(argv, '--web-entry');
	const sharedAssets = readFlag(argv, '--shared-assets');

	if (artifacts) {
		const paths = readArtifacts(artifacts);
		return {
			outDir: outDir ?? paths.outDir,
			webEntry: webEntry ?? paths.webEntry,
			sharedAssets: sharedAssets ?? paths.sharedAssets,
			port,
			host,
			artifacts
		};
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
	return { outDir, webEntry, sharedAssets, port, host };
}

/** The one block this process prints while it runs: what is up, where, and on what terms. */
export function formatReadyNotice(running: RunningPreviewServer, options: PreviewServerOptions): string {
	const origin = `http://${running.host}:${String(running.port)}`;
	return formatReport('Preview server ready', 'the isolated build is being served with a signed-in boot stub', [
		{ label: 'App', value: running.url },
		{ label: 'Assets', value: `${origin}${ASSET_BASE}` },
		...(options.sharedAssets === undefined
			? []
			: [{ label: 'Shared assets', value: `${origin}${SHARED_ASSET_BASE}` }]),
		{ label: 'Serving', value: path.resolve(options.outDir) },
		...(options.sharedAssets === undefined
			? []
			: [{ label: 'Shared from', value: path.resolve(options.sharedAssets) }]),
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
