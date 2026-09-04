/**
 * Isolated preview build harness.
 *
 * Reproduces what a preview deployment does to this app: copy the checkout
 * into a bench-shaped tree (`apps/erpnext/banking`) that has **no**
 * `sites/common_site_config.json`, run the production build there, and check
 * that the deployable artefacts actually exist. A preview that cannot build
 * shows a `build_failed` screen instead of the app, so this harness fails the
 * same way — loudly, with the cause named and the tree left on disk for
 * inspection — and exits non-zero.
 *
 * The temporary tree is left on disk on purpose: the reported paths point into
 * it, so a caller can serve or inspect the artefacts, and remove the reported
 * bench root when done.
 *
 * Usage: `yarn e2e:isolated-build [--install] [--json]`
 *   --install  install dependencies inside the temporary tree instead of
 *              reusing this checkout's `node_modules`
 *   --json     print the artefact paths as JSON on stdout (report goes to stderr)
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
	HarnessFailure,
	collectAssetReferences,
	formatFailure,
	formatSuccess,
	summarizeBuildFailure,
	toArtifactPath,
	type ReportDetail
} from './buildReport.ts';

/** Public base path of the built assets, as bench serves them. */
const BASE = '/assets/erpnext/banking/';

/** Where this app sits inside a bench: `{bench}/apps/{app}/banking`. */
const APP_PATH_IN_BENCH = path.join('apps', 'erpnext', 'banking');

/** The dev-only file whose absence this harness exists to prove is survivable. */
const SITE_CONFIG_PATH_IN_BENCH = path.join('sites', 'common_site_config.json');

/** Copied into the throwaway tree; anything else is generated or irrelevant to a build. */
const EXCLUDED_FROM_COPY = new Set(['node_modules', 'dist']);

const APP_DIR = path.resolve(import.meta.dirname, '..');

interface Artifacts {
	benchRoot: string;
	appDir: string;
	outDir: string;
	htmlEntry: string;
	webEntry: string;
	assets: string[];
	buildLog: string;
}

function fail(
	stage: 'prepare' | 'install' | 'build' | 'verify',
	reason: string,
	fix: string,
	details: ReportDetail[] = []
): never {
	throw new HarnessFailure({ stage, reason, fix, details });
}

/** Builds the bench-shaped tree. `sites/` is deliberately never created. */
function prepareBenchTree(): { benchRoot: string; appDir: string; erpnextDir: string } {
	const buildScript = readPackageBuildScript();
	if (!buildScript.includes(`--base=${BASE}`)) {
		fail(
			'prepare',
			`the app's build script no longer builds with --base=${BASE}`,
			`align the base in ${path.join('banking', 'e2e', 'isolatedBuild.ts')} with the build script, so the harness verifies the paths the preview actually serves`,
			[{ label: 'Build script', value: buildScript }]
		);
	}

	const benchRoot = mkdtempSync(path.join(tmpdir(), 'banking-isolated-bench-'));
	const appDir = path.join(benchRoot, APP_PATH_IN_BENCH);
	const erpnextDir = path.join(benchRoot, 'apps', 'erpnext', 'erpnext');

	mkdirSync(appDir, { recursive: true });
	cpSync(APP_DIR, appDir, {
		recursive: true,
		filter: (source) => !EXCLUDED_FROM_COPY.has(path.basename(source))
	});
	// The build writes to `../erpnext/public/banking` and the HTML entry is
	// copied into `../erpnext/www`; both live outside the app directory.
	mkdirSync(path.join(erpnextDir, 'public'), { recursive: true });
	mkdirSync(path.join(erpnextDir, 'www'), { recursive: true });

	assertNoSiteConfig(benchRoot, 'prepare');
	return { benchRoot, appDir, erpnextDir };
}

function readPackageBuildScript(): string {
	const manifestPath = path.join(APP_DIR, 'package.json');
	try {
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { scripts?: Record<string, string> };
		const build = manifest.scripts?.build;
		if (typeof build === 'string') {
			return build;
		}
	} catch (error) {
		fail('prepare', `${manifestPath} could not be read (${(error as Error).message})`, 'run the harness from a complete checkout of the app');
	}
	fail('prepare', `${manifestPath} has no "build" script`, 'restore the build script the preview deployment runs');
}

/** The whole point of the harness: this file must not be reachable at any stage. */
function assertNoSiteConfig(benchRoot: string, stage: 'prepare' | 'verify'): void {
	const siteConfig = path.join(benchRoot, SITE_CONFIG_PATH_IN_BENCH);
	if (existsSync(siteConfig)) {
		fail(
			stage,
			'the temporary tree contains a site config, so the run would not prove anything about an isolated preview',
			'remove whatever creates the site config inside the harness tree',
			[{ label: 'Unexpected file', value: siteConfig }]
		);
	}
}

/** Reuses this checkout's dependencies by default; `--install` installs a fresh set in the tree. */
function provideDependencies(appDir: string, benchRoot: string, install: boolean): void {
	if (install) {
		const result = runInTree('yarn', ['install', '--frozen-lockfile'], appDir, benchRoot, 'install.log');
		if (result.status !== 0) {
			fail('install', `dependency installation exited with code ${String(result.status ?? 'null')}`, 'fix the install failure reported in the install log, then rerun the harness', [
				{ label: 'Install log', value: result.logPath }
			]);
		}
		return;
	}

	const source = path.join(APP_DIR, 'node_modules');
	if (!existsSync(source)) {
		fail('install', 'this checkout has no installed dependencies to reuse', 'run `yarn install` in the app directory, or rerun the harness with --install');
	}
	symlinkSync(source, path.join(appDir, 'node_modules'), 'dir');
}

function runInTree(
	command: string,
	args: string[],
	cwd: string,
	benchRoot: string,
	logName: string
): { status: number | null; logPath: string; tail: string } {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	const output = `$ ${command} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}${
		result.error ? `\n${result.error.message}\n` : ''
	}`;
	const logPath = path.join(benchRoot, logName);
	writeFileSync(logPath, output, 'utf8');
	return { status: result.error ? null : result.status, logPath, tail: summarizeBuildFailure(output) };
}

function runBuild(appDir: string, benchRoot: string): string {
	const result = runInTree('yarn', ['build'], appDir, benchRoot, 'build.log');
	if (result.status !== 0) {
		fail(
			'build',
			`the production build exited with code ${String(result.status ?? 'null')} in a tree without ${SITE_CONFIG_PATH_IN_BENCH}`,
			'read the build log; a build that needs the site config is exactly the defect this harness guards against',
			[
				{ label: 'Build error', value: result.tail },
				{ label: 'Build log', value: result.logPath }
			]
		);
	}
	return result.logPath;
}

/** Checks that the build produced what a preview deployment would serve. */
function verifyArtifacts(benchRoot: string, appDir: string, erpnextDir: string, buildLog: string): Artifacts {
	assertNoSiteConfig(benchRoot, 'verify');

	const outDir = path.join(erpnextDir, 'public', 'banking');
	const htmlEntry = path.join(outDir, 'index.html');
	const webEntry = path.join(erpnextDir, 'www', 'banking.html');

	for (const [label, file] of [
		['HTML entry', htmlEntry],
		['Web entry', webEntry]
	] as const) {
		if (!existsSync(file) || statSync(file).size === 0) {
			fail('verify', `the build produced no usable ${label.toLowerCase()}`, 'inspect the build log and the output directory in the harness tree', [
				{ label: 'Expected file', value: file },
				{ label: 'Build log', value: buildLog }
			]);
		}
	}

	const html = readFileSync(htmlEntry, 'utf8');
	const references = collectAssetReferences(html, BASE);
	if (references.length === 0) {
		fail('verify', `the HTML entry references no asset under ${BASE}`, 'check the build base and the rollup output configuration', [
			{ label: 'HTML entry', value: htmlEntry },
			{ label: 'Build log', value: buildLog }
		]);
	}

	const assets = references.map((reference) => path.join(outDir, toArtifactPath(reference, BASE)));
	const missing = assets.filter((asset) => !existsSync(asset));
	if (missing.length > 0) {
		fail('verify', 'the HTML entry references assets the build did not emit', 'inspect the build log; the output directory is incomplete', [
			{ label: 'Missing assets', value: missing.join(', ') },
			{ label: 'Build log', value: buildLog }
		]);
	}

	return { benchRoot, appDir, outDir, htmlEntry, webEntry, assets, buildLog };
}

function successDetails(artifacts: Artifacts): ReportDetail[] {
	const details: ReportDetail[] = [
		{ label: 'Bench root', value: artifacts.benchRoot },
		{ label: 'HTML entry', value: artifacts.htmlEntry },
		{ label: 'Web entry', value: artifacts.webEntry }
	];
	const script = artifacts.assets.find((asset) => asset.endsWith('.js'));
	const style = artifacts.assets.find((asset) => asset.endsWith('.css'));
	if (script) {
		details.push({ label: 'Script asset', value: script });
	}
	if (style) {
		details.push({ label: 'Style asset', value: style });
	}
	details.push({ label: 'Referenced assets', value: String(artifacts.assets.length) });
	return details;
}

function main(argv: string[]): number {
	const install = argv.includes('--install');
	const json = argv.includes('--json');
	let benchRoot: string | undefined;

	try {
		const tree = prepareBenchTree();
		benchRoot = tree.benchRoot;
		provideDependencies(tree.appDir, tree.benchRoot, install);
		const buildLog = runBuild(tree.appDir, tree.benchRoot);
		const artifacts = verifyArtifacts(tree.benchRoot, tree.appDir, tree.erpnextDir, buildLog);

		const report = formatSuccess({
			isolation: `the bench tree had no ${SITE_CONFIG_PATH_IN_BENCH}`,
			details: successDetails(artifacts)
		});
		if (json) {
			console.error(report);
			console.log(JSON.stringify(artifacts, null, 2));
		} else {
			console.log(report);
		}
		return 0;
	} catch (error) {
		if (error instanceof HarnessFailure) {
			const details = benchRoot ? [{ label: 'Bench root', value: benchRoot }, ...error.report.details] : error.report.details;
			console.error(formatFailure({ ...error.report, details }));
			return 1;
		}
		throw error;
	}
}

process.exitCode = main(process.argv.slice(2));
