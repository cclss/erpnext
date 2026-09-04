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
 * Run with `yarn test:e2e`. It is deliberately not named `*.test.ts`: it costs a
 * production build, and `yarn test` must stay fast enough to run on every edit.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { after, before, describe, it } from 'node:test';
import { HarnessFailure, collectAssetReferences, formatFailure, toArtifactPath } from './buildReport.ts';
import { renderEntry, type RenderedEntry } from './domRuntime.ts';
import {
	excerpt,
	findMissingEntrySignals,
	findModuleEntry,
	formatEntryScreenFailure,
	isFailureScreen
} from './entryScreen.ts';
import { findUnresolvedPlaceholders } from './previewBoot.ts';
import { ASSET_BASE, startPreviewServer, type RunningPreviewServer } from './previewServer.ts';

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

	it('serves every asset the page loads', async () => {
		const references = collectAssetReferences(page.html, ASSET_BASE);
		assert.ok(references.length > 0, `the served page references no asset under ${ASSET_BASE}`);

		for (const reference of references) {
			const response = await fetch(new URL(reference, server.url));
			assert.equal(response.status, 200, `${reference} answered ${String(response.status)}`);
			assert.ok((await response.text()).length > 0, `${reference} was served empty`);
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

		// One assertion, because one list already says everything that can be
		// wrong: nothing mounted, no breadcrumb, the wrong route, or the
		// deployment failure screen.
		assert.deepEqual(findMissingEntrySignals(entry), [], formatEntryScreenFailure(entry));
	});
});
