/**
 * SC-1 — opening the Banking preview from an isolated environment.
 *
 * Given a preview environment with no `sites/common_site_config.json`, when the
 * Banking preview is opened, then the Banking application entry screen is shown
 * rather than the `build_failed` deployment failure screen.
 *
 * The scenario runs the whole chain rather than asserting on any one link: it
 * builds in a bench-shaped tree that has no site config, serves what that build
 * produced, opens the served page, and looks at what the application rendered.
 * Every step is the one a preview deployment performs, so a pass here means the
 * preview opens — not that three units agree with each other.
 *
 * "Opens" is taken at the addresses a person actually uses: the site root they
 * type, the `/banking` the build mounts its router at, and the deep screens they
 * reload or share a link to — together with every same-origin file the page
 * pulls in on the way. A preview that only answers one of those is a preview
 * that breaks on the second click.
 *
 * Run with `yarn test:e2e`. It is deliberately not named `*.test.ts`: it costs a
 * production build, and `yarn test` must stay fast enough to run on every edit.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, it } from 'node:test';
import { HarnessFailure, formatFailure, toArtifactPath } from './buildReport.ts';
import { renderEntry, type RenderedEntry } from './domRuntime.ts';
import {
	excerpt,
	findFailureSignals,
	findModuleEntry,
	formatEntryScreenFailure,
	isFailureScreen
} from './entryScreen.ts';
import { findUnresolvedPlaceholders } from './previewBoot.ts';
import {
	APP_ROUTE,
	ASSET_BASE,
	SHARED_ASSET_BASE,
	startPreviewServer,
	type RunningPreviewServer
} from './previewServer.ts';

/** A build plus a served page; the scenario's setup is the slow part, not the assertions. */
const SETUP_TIMEOUT_MS = 900_000;

/** Let the operating system pick the port, so a busy 4173 cannot fail the scenario. */
const EPHEMERAL_PORT = 0;

/**
 * Time the preview stays up after the page is stopped.
 *
 * A page that is closed can still have requests in flight; tearing the server
 * down underneath them turns the application's own error handling into noise
 * that has nothing to do with the scenario.
 */
const DRAIN_MS = 500;

/**
 * The addresses the built application answers to.
 *
 * `.env.production` sets `VITE_BASE_NAME=banking`, so the router is mounted at
 * `/banking` and its screens are the paths below. Each one is a place a person
 * can arrive at directly — a bookmark, a shared link, a reload after a form was
 * filled — and a preview that only serves the first of them loses the screen on
 * the next refresh.
 */
const APP_ROUTES = [
	APP_ROUTE,
	`${APP_ROUTE}/statement-importer`,
	`${APP_ROUTE}/statement-importer/BSI-2026-00001`
];

const HARNESS_DIR = import.meta.dirname;
const APP_DIR = path.resolve(HARNESS_DIR, '..');

interface Artifacts {
	benchRoot: string;
	outDir: string;
	webEntry: string;
	sharedAssets: string;
}

/**
 * Builds in an isolated tree by running the harness as its own process.
 *
 * The harness is a command, and running it as one is what proves the command
 * works; importing its internals would verify a different thing than the one
 * a preview deployment does.
 */
function buildInIsolation(): Artifacts {
	const result = spawnSync(process.execPath, [path.join(HARNESS_DIR, 'isolatedBuild.ts'), '--json'], {
		cwd: APP_DIR,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	if (result.status !== 0) {
		// The harness already reported the failure in the shape this project
		// reads; repeating it in an assertion message would only reword it.
		throw new Error(result.stderr.trim() || `the isolated build exited with code ${String(result.status)}`);
	}
	return JSON.parse(result.stdout) as Artifacts;
}

interface ServedPage {
	status: number;
	html: string;
	cookies: string[];
}

/**
 * Surfaces a harness failure as the report it already is.
 *
 * A `HarnessFailure` carries the stage, the cause, the fix and the impact; left
 * to the runner it would print as a one-line message and lose all four.
 */
async function reported<T>(step: () => Promise<T>): Promise<T> {
	try {
		return await step();
	} catch (error) {
		if (error instanceof HarnessFailure) {
			throw new Error(formatFailure(error.report), { cause: error });
		}
		throw error;
	}
}

/**
 * Every same-origin file the served page asks for.
 *
 * Not only this build's own output: the page's icon comes from the erpnext
 * app's shared tree, and the entry template writes that default with a leading
 * space inside the quotes (`{{ favicon or ' /assets/erpnext/images/...' }}`).
 * A browser trims that before requesting, so this trims it too — untrimmed, the
 * one reference most likely to be missing would be the one never checked.
 *
 * Absolute and protocol-relative URLs are somebody else's server, and anchors
 * and data URIs are not requests at all; none of them say anything about this
 * preview.
 */
function collectSameOriginReferences(html: string): string[] {
	const references = new Set<string>();
	for (const match of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
		const reference = match[1].trim();
		if (reference.startsWith('/') && !reference.startsWith('//')) {
			references.add(reference);
		}
	}
	return [...references];
}

async function openPreview(url: string): Promise<ServedPage> {
	const response = await fetch(url);
	return { status: response.status, html: await response.text(), cookies: response.headers.getSetCookie() };
}

describe('SC-1 the Banking preview opens without a site config', { timeout: SETUP_TIMEOUT_MS }, () => {
	let artifacts: Artifacts;
	let server: RunningPreviewServer;
	let page: ServedPage;
	let entry: RenderedEntry | undefined;

	before(
		() =>
			reported(async () => {
				artifacts = buildInIsolation();
				server = await startPreviewServer({
					outDir: artifacts.outDir,
					webEntry: artifacts.webEntry,
					sharedAssets: artifacts.sharedAssets,
					port: EPHEMERAL_PORT
				});
				page = await openPreview(server.url);
			}),
		{ timeout: SETUP_TIMEOUT_MS }
	);

	after(async () => {
		entry?.close();
		await new Promise((resolve) => setTimeout(resolve, DRAIN_MS));
		await server?.close();
		if (artifacts?.benchRoot) {
			rmSync(artifacts.benchRoot, { recursive: true, force: true });
		}
	});

	it('serves the application page rather than the deployment failure screen', () => {
		assert.equal(page.status, 200, `the preview answered ${String(page.status)} at ${server.url}`);
		assert.ok(!isFailureScreen(page.html), `the preview served a deployment failure screen: ${excerpt(page.html)}`);
		assert.deepEqual(
			findUnresolvedPlaceholders(page.html),
			[],
			'the served page still carries template placeholders, so it was never rendered for a browser'
		);
	});

	it('sends someone who typed the bare address on to the app', async () => {
		const origin = new URL(server.url).origin;

		const moved = await fetch(origin, { redirect: 'manual' });
		await moved.text();

		assert.equal(moved.status, 302, `the site root answered ${String(moved.status)} instead of moving`);
		assert.equal(moved.headers.get('location'), APP_ROUTE);

		// And what a browser does with that answer is the point: the app page,
		// not a second redirect and not a copy of the page at the wrong address.
		const arrived = await openPreview(origin);
		assert.equal(arrived.status, 200, `following the redirect answered ${String(arrived.status)}`);
		assert.equal(arrived.html, page.html, 'the site root led somewhere other than the application page');
	});

	it('answers a reload of every screen the app navigates to', async () => {
		const origin = new URL(server.url).origin;

		for (const route of APP_ROUTES) {
			const reloaded = await openPreview(`${origin}${route}`);

			assert.equal(reloaded.status, 200, `${route} answered ${String(reloaded.status)}`);
			assert.ok(!isFailureScreen(reloaded.html), `${route} served a deployment failure screen`);
			// The router renders the screen from the address once the page runs,
			// so every one of these has to arrive as the same application page.
			assert.equal(reloaded.html, page.html, `${route} served something other than the application page`);
		}
	});

	it('serves every same-origin file the page references', async () => {
		const references = collectSameOriginReferences(page.html);
		const built = references.filter((reference) => reference.startsWith(ASSET_BASE));
		const shared = references.filter(
			(reference) => reference.startsWith(SHARED_ASSET_BASE) && !reference.startsWith(ASSET_BASE)
		);

		assert.ok(built.length > 0, `the served page references no asset under ${ASSET_BASE}`);
		// The icon is the reference this preview is least likely to hold, because
		// it belongs to the erpnext app rather than to this build.
		assert.ok(shared.length > 0, `the served page references nothing under ${SHARED_ASSET_BASE}, not even its icon`);

		for (const reference of references) {
			const response = await fetch(new URL(reference, server.url));
			const body = await response.arrayBuffer();
			assert.equal(response.status, 200, `${reference} answered ${String(response.status)}`);
			assert.ok(body.byteLength > 0, `${reference} was served empty`);
		}
	});

	it('renders the Banking application entry screen', async () => {
		const reference = findModuleEntry(page.html);
		assert.ok(reference, 'the served page loads no entry module, so nothing would ever mount');

		const moduleFile = path.join(artifacts.outDir, toArtifactPath(reference, ASSET_BASE));
		const served = await fetch(new URL(reference, server.url));
		assert.equal(
			await served.text(),
			readFileSync(moduleFile, 'utf8'),
			'the preview serves a different entry module than the build produced'
		);

		entry = await reported(() =>
			renderEntry({
				html: page.html,
				url: server.url,
				cookies: page.cookies,
				moduleFile
			})
		);

		// The observation is already a snapshot, so the page can stop here — the
		// assertions below read values, not a live DOM.
		entry.close();

		// A page that asked for nothing proves nothing about what the preview
		// answers, so the observation has to have seen traffic before its
		// silence about failures means anything.
		assert.ok(
			entry.requests.length > 0,
			'the page made no same-origin request, so nothing was observed about what the preview answers'
		);

		// One assertion, because one list already says everything that can be
		// wrong: nothing mounted, no breadcrumb, the wrong route, the deployment
		// failure screen, a request the preview refused, or an error the page
		// logged. The last two matter as much as the first four — an application
		// renders its empty state around a `404` exactly as it renders it around
		// real emptiness, so a screen that looks right is not yet a screen that
		// got what it asked for.
		assert.deepEqual(findFailureSignals(entry), [], formatEntryScreenFailure(entry));
	});
});
