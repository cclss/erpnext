import assert from 'node:assert/strict';
import test from 'node:test';
import {
	CAUSE_SEPARATOR,
	DETAIL_INDENT,
	FAILURE_MARKER,
	LOG_PREFIX,
	collectAssetReferences,
	formatFailure,
	formatSuccess,
	summarizeBuildFailure,
	toArtifactPath
} from './buildReport.ts';

const BASE = '/assets/erpnext/banking/';

test('every reported line is attributable and details are indented', () => {
	const report = formatSuccess({
		isolation: 'the bench tree had no sites/common_site_config.json',
		details: [{ label: 'HTML entry', value: '/tmp/bench/index.html' }]
	});
	const lines = report.split('\n');
	assert.ok(
		lines.every((line) => line.startsWith(`${LOG_PREFIX} `)),
		`every line needs the source prefix, got: ${JSON.stringify(lines)}`
	);
	assert.equal(
		lines[0],
		`${LOG_PREFIX} Isolated preview build succeeded${CAUSE_SEPARATOR}the bench tree had no sites/common_site_config.json.`
	);
	assert.equal(lines[1], `${LOG_PREFIX} ${DETAIL_INDENT}HTML entry: /tmp/bench/index.html`);
});

test('a failure names build_failed, the stage, the cause and the way out', () => {
	const report = formatFailure({
		stage: 'build',
		reason: 'the production build exited with code 1 in a tree without sites/common_site_config.json',
		fix: 'read the build log',
		details: [{ label: 'Build log', value: '/tmp/bench/build.log' }]
	});
	assert.ok(report.includes(FAILURE_MARKER), 'a failing run must be greppable as build_failed');
	assert.ok(report.includes(`${DETAIL_INDENT}Stage: build`));
	assert.ok(report.includes(`${DETAIL_INDENT}Build log: /tmp/bench/build.log`));
	assert.ok(report.includes(`${DETAIL_INDENT}Fix: read the build log`));
	assert.ok(report.includes(`${DETAIL_INDENT}Impact: `), 'a failure states what is now unavailable');
	assert.ok(report.includes(CAUSE_SEPARATOR), 'the outcome and its cause stay separated');
});

test('reports stay in the plain declarative tone used across the app', () => {
	const reports = [
		formatSuccess({ isolation: 'the bench tree had no site config', details: [] }),
		formatFailure({ stage: 'verify', reason: 'the build emitted no HTML entry', fix: 'inspect the build log', details: [] })
	];
	for (const report of reports) {
		assert.ok(!report.includes('!'), `no exclamation marks: ${report}`);
		assert.ok(!/\p{Extended_Pictographic}/u.test(report), `no emoji: ${report}`);
	}
});

test('only built assets under the base count as build output', () => {
	const html = [
		'<link rel="icon" href="/assets/erpnext/images/favicon.svg">',
		'<script type="module" src="/assets/erpnext/banking/assets/index-a1b2.js"></script>',
		'<link rel="stylesheet" href="/assets/erpnext/banking/assets/index-c3d4.css">',
		'<script src="https://cdn.example.com/analytics.js"></script>',
		'<link rel="canonical" href="/assets/erpnext/banking/">'
	].join('\n');

	assert.deepEqual(collectAssetReferences(html, BASE), [
		'/assets/erpnext/banking/assets/index-a1b2.js',
		'/assets/erpnext/banking/assets/index-c3d4.css'
	]);
});

test('an entry without built assets yields nothing to verify', () => {
	assert.deepEqual(collectAssetReferences('<div id="root"></div>', BASE), []);
});

test('an asset reference maps onto its path inside the output directory', () => {
	assert.equal(toArtifactPath('/assets/erpnext/banking/assets/index-a1b2.js', BASE), 'assets/index-a1b2.js');
});

test('a build log is reduced to the line that names the cause', () => {
	const log = [
		'$ yarn build',
		'yarn run v1.22.22',
		'vite v8.2.1 building client environment for production...',
		'failed to load config from /tmp/bench/apps/erpnext/banking/vite.config.ts',
		'error during build:',
		"Error: ENOENT: no such file or directory, open '/tmp/bench/sites/common_site_config.json'",
		'    at readFileSync (node:fs:1234:5)',
		'error Command failed with exit code 1.',
		'info Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.'
	].join('\n');

	assert.equal(summarizeBuildFailure(log), 'failed to load config from /tmp/bench/apps/erpnext/banking/vite.config.ts');
});

test('bundler colouring never reaches the report', () => {
	const log = ['error during build:', "\u001B[31m[UNRESOLVED_IMPORT] \u001B[0mCould not resolve './missing.ts' in src/main.tsx"].join('\n');

	assert.equal(summarizeBuildFailure(log), "[UNRESOLVED_IMPORT] Could not resolve './missing.ts' in src/main.tsx");
});

test('a log with no recognisable cause still yields its last informative line', () => {
	const log = ['$ yarn build', 'something went sideways', 'error Command failed with exit code 1.'].join('\n');

	assert.equal(summarizeBuildFailure(log), 'something went sideways');
});

test('a quoted line stays short enough to read', () => {
	const log = `Error: ${'x'.repeat(5000)}`;

	const summary = summarizeBuildFailure(log);
	assert.ok(summary.length <= 203, `expected a truncated line, got ${summary.length} characters`);
	assert.ok(summary.endsWith('...'), 'truncation is visible');
});
