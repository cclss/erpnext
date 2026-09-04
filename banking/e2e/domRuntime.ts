/**
 * Runs the built Banking bundle the way a browser tab would, in this process.
 *
 * Verifying that a preview shows the application — not the deployment failure
 * screen — means the production bundle has to actually execute: the HTML entry
 * alone proves nothing, because a page that mounts nothing is still a valid
 * page. This module gives that bundle a DOM, the browser APIs jsdom leaves out,
 * and the session cookie the preview server hands a browser, then reports what
 * the application rendered.
 *
 * It drives no browser and starts no external process. The bundle is imported
 * as the ES module it is, with a DOM installed as the module's global scope,
 * which is what lets a check this close to a real page load stay a test.
 */

import { pathToFileURL } from 'node:url';
import type { DOMWindow, JSDOM } from 'jsdom';
import { HarnessFailure } from './buildReport.ts';
import { APP_MOUNT_SELECTOR, BREADCRUMB_SELECTOR, type EntryObservation } from './entryScreen.ts';

/** How long the application gets to mount before the observation is taken as final. */
export const DEFAULT_RENDER_TIMEOUT_MS = 30_000;

/**
 * How long the entry screen must survive before the observation is taken.
 *
 * A screen that appears and then disappears is not a screen that opened. The
 * application's first render happens before its data arrives, so the answer to
 * "did the preview open" is only trustworthy once that data has landed.
 */
export const DEFAULT_SETTLE_MS = 3_000;

/** How often the DOM is checked while waiting. */
const POLL_INTERVAL_MS = 50;

/**
 * Globals that must come from the DOM even though Node defines its own.
 *
 * Everything else the window owns is installed only where Node has no binding,
 * so Node's own globals keep working for the surrounding test process.
 */
const SHADOWED_GLOBALS = [
	'window',
	'self',
	'document',
	'navigator',
	'location',
	'history',
	'fetch',
	'localStorage',
	'sessionStorage',
	'getComputedStyle',
	'requestAnimationFrame',
	'cancelAnimationFrame',
	'matchMedia',
	'ResizeObserver',
	'IntersectionObserver',
	'MutationObserver',
	'HTMLElement',
	'Element',
	'Node',
	'Event',
	'CustomEvent',
	'DOMParser',
	'CSS'
];

export interface EntryRunOptions {
	/** The page exactly as the preview server returned it. */
	html: string;
	/** The address it was served from; the DOM keeps it as its location. */
	url: string;
	/** `Set-Cookie` headers from that response, seeded into the DOM's cookie jar. */
	cookies?: string[];
	/** Absolute path of the entry module the page loads. */
	moduleFile: string;
	/** How long to wait for the entry screen. */
	timeoutMs?: number;
	/** How long the entry screen must stay on before it counts as open. */
	settleMs?: number;
}

export interface RenderedEntry extends EntryObservation {
	/** Releases the DOM's timers and restores the globals this run replaced. */
	close: () => void;
}

/** jsdom is a devDependency, so its absence is a setup problem worth naming rather than a stack. */
async function loadDomRuntime(): Promise<typeof import('jsdom')> {
	try {
		return await import('jsdom');
	} catch (error) {
		throw new HarnessFailure({
			stage: 'render',
			reason: `the in-process DOM runtime could not be loaded (${(error as Error).message})`,
			fix: 'run `yarn install` in the app directory; opening the built page needs the jsdom devDependency',
			details: [{ label: 'Missing package', value: 'jsdom' }],
			impact: 'the artefacts may build and be served, but nothing executed them, so the entry screen was never checked'
		});
	}
}

/**
 * Adds the browser APIs jsdom does not implement.
 *
 * Each one is a no-op rather than a simulation: they exist so the bundle's
 * dependencies can call them, not to make the page behave as if it were laid
 * out. `fetch` is the exception — it is real, pointed at the preview server, so
 * the page's own requests go where a browser would send them.
 */
function installMissingBrowserApis(window: DOMWindow, fetchThroughPreview: typeof fetch): void {
	window.fetch ??= fetchThroughPreview;
	window.ResizeObserver ??= class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	};
	window.IntersectionObserver ??= class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
		takeRecords(): [] {
			return [];
		}
	};
	window.matchMedia ??= (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false
	});
	window.scrollTo ??= () => {};
}

/** Installs the DOM as this process's global scope and returns the undo. */
function installGlobals(window: DOMWindow): () => void {
	const scope = globalThis as unknown as Record<string, unknown>;
	const undo: (() => void)[] = [];

	const define = (key: string): void => {
		const previous = Object.getOwnPropertyDescriptor(globalThis, key);
		try {
			Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
		} catch {
			// A binding the runtime refuses to redefine. The bundle can still
			// reach it through `window`, so this is not worth failing over.
			return;
		}
		undo.push(() => {
			if (previous) {
				Object.defineProperty(globalThis, key, previous);
			} else {
				delete scope[key];
			}
		});
	};

	for (const key of Object.getOwnPropertyNames(window)) {
		if (!(key in globalThis)) {
			define(key);
		}
	}
	for (const key of SHADOWED_GLOBALS) {
		define(key);
	}

	return () => {
		for (const restore of undo.reverse()) {
			restore();
		}
	};
}

function seedCookies(dom: JSDOM, url: string, cookies: string[]): void {
	for (const cookie of cookies) {
		try {
			dom.cookieJar.setCookieSync(cookie, url);
		} catch (error) {
			throw new HarnessFailure({
				stage: 'render',
				reason: `the preview's session cookie could not be seeded (${(error as Error).message})`,
				fix: 'check the Set-Cookie header the preview server sends for the app route',
				details: [{ label: 'Cookie', value: cookie }],
				impact: 'the page would load as a guest and redirect to the login page instead of showing the application'
			});
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function observe(window: DOMWindow, waitedMs: number, pageErrors: string[]): EntryObservation {
	const mount = window.document.querySelector(APP_MOUNT_SELECTOR);
	const breadcrumb = window.document.querySelector(BREADCRUMB_SELECTOR);
	return {
		mountHtml: mount?.innerHTML ?? '',
		mountText: mount?.textContent ?? '',
		breadcrumbText: breadcrumb?.textContent ?? undefined,
		pageErrors,
		waitedMs
	};
}

/**
 * Opens the served page and reports what the application rendered.
 *
 * The page is polled rather than awaited on a single signal: the entry screen
 * appears after the bundle's own async work, and there is no event a page is
 * obliged to fire when it is done. Waiting resolves as soon as the breadcrumb
 * is there, so a healthy preview costs one poll interval, not the timeout.
 */
export async function renderEntry(options: EntryRunOptions): Promise<RenderedEntry> {
	const { JSDOM: Dom, VirtualConsole } = await loadDomRuntime();
	const timeoutMs = options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
	const pageErrors: string[] = [];

	// Three channels, because a page reports its failures on all three: jsdom
	// raises what it refuses to do, React reports a crashed render through
	// `console.error`, and everything else arrives as an uncaught error.
	const virtualConsole = new VirtualConsole();
	virtualConsole.on('jsdomError', (error: Error) => {
		pageErrors.push(error.message);
	});
	virtualConsole.on('error', (...parts: unknown[]) => {
		pageErrors.push(parts.map((part) => (part instanceof Error ? part.message : String(part))).join(' '));
	});

	// Captured before the DOM shadows the global, so the shim cannot recurse.
	const nodeFetch = globalThis.fetch;
	const origin = new URL(options.url).origin;
	// A page asks for `/api/...`; jsdom has no fetch, and Node's rejects a
	// relative URL, so the origin the page was served from is put back on.
	const fetchThroughPreview: typeof fetch = (input, init) =>
		nodeFetch(typeof input === 'string' ? new URL(input, origin) : input, init);

	const dom = new Dom(options.html, {
		url: options.url,
		runScripts: 'dangerously',
		pretendToBeVisual: true,
		virtualConsole,
		beforeParse: (window) => {
			installMissingBrowserApis(window, fetchThroughPreview);
			window.addEventListener('error', (event: { message?: string }) => {
				pageErrors.push(event.message ?? 'uncaught error');
			});
		}
	});
	seedCookies(dom, options.url, options.cookies ?? []);

	const restoreGlobals = installGlobals(dom.window);
	let closed = false;
	const close = (): void => {
		if (closed) {
			return;
		}
		closed = true;
		restoreGlobals();
		// Stops the page: its timers are cleared, so no further request is
		// started against a preview server that is about to go away.
		dom.window.close();
	};

	try {
		await import(pathToFileURL(options.moduleFile).href);
	} catch (error) {
		close();
		throw new HarnessFailure({
			stage: 'render',
			reason: `the built entry module could not be executed (${(error as Error).message})`,
			fix: 'run the entry module against the served page by hand; a module that throws on load never mounts the application',
			details: [{ label: 'Entry module', value: options.moduleFile }],
			impact: 'the artefacts are served but nothing mounts, so the preview shows an empty page'
		});
	}

	const startedAt = Date.now();
	let waited = 0;
	while (observe(dom.window, waited, pageErrors).breadcrumbText === undefined && waited < timeoutMs) {
		await delay(POLL_INTERVAL_MS);
		waited = Date.now() - startedAt;
	}

	// The screen appeared; now let it prove it stays. Reporting the settled
	// state is what keeps a render that crashes on its first data from passing.
	await delay(options.settleMs ?? DEFAULT_SETTLE_MS);
	return { ...observe(dom.window, Date.now() - startedAt, pageErrors), close };
}
