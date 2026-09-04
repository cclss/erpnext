import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FAILURE_MARKER, LOG_PREFIX } from './buildReport.ts';
import {
	APP_MOUNT_SELECTOR,
	BREADCRUMB_SELECTOR,
	ENTRY_BREADCRUMB_LABEL,
	excerpt,
	findMissingEntrySignals,
	findModuleEntry,
	formatEntryScreenFailure,
	isFailureScreen,
	type EntryObservation
} from './entryScreen.ts';

/** An observation of a healthy entry screen; each test spoils one part of it. */
function observation(overrides: Partial<EntryObservation> = {}): EntryObservation {
	return {
		mountHtml: '<div><nav aria-label="breadcrumb">Banking Beta</nav></div>',
		mountText: 'Banking Beta',
		breadcrumbText: 'Banking Beta',
		pageErrors: [],
		waitedMs: 50,
		...overrides
	};
}

describe('findModuleEntry', () => {
	it('finds the hashed entry module the built page loads', () => {
		const html = '<script type="module" crossorigin src="/assets/erpnext/banking/assets/index-ClYqa0fl.js"></script>';
		assert.equal(findModuleEntry(html), '/assets/erpnext/banking/assets/index-ClYqa0fl.js');
	});

	it('finds it regardless of attribute order', () => {
		const html = '<script crossorigin type="module" src="/assets/erpnext/banking/assets/index.js"></script>';
		assert.equal(findModuleEntry(html), '/assets/erpnext/banking/assets/index.js');
	});

	it('ignores classic scripts, which a browser would not treat as the module entry', () => {
		const html = '<script src="/legacy.js"></script><script>window.frappe = {};</script>';
		assert.equal(findModuleEntry(html), undefined);
	});

	it('reports nothing for a page that loads no script at all', () => {
		assert.equal(findModuleEntry('<html><body><div id="root"></div></body></html>'), undefined);
	});
});

describe('isFailureScreen', () => {
	it('recognises the marker the preview environment uses for a broken deployment', () => {
		assert.equal(isFailureScreen(`${LOG_PREFIX} something failed (${FAILURE_MARKER})`), true);
	});

	it('does not mistake the application page for one', () => {
		assert.equal(isFailureScreen('<div id="root"><nav aria-label="breadcrumb">Banking</nav></div>'), false);
	});
});

describe('excerpt', () => {
	it('collapses rendered whitespace into one quotable line', () => {
		assert.equal(excerpt('  Banking \n\t Beta  '), 'Banking Beta');
	});

	it('names an empty render rather than quoting nothing', () => {
		assert.equal(excerpt('   \n  '), '(empty)');
	});

	it('truncates a long render so one report line stays readable', () => {
		const result = excerpt('x'.repeat(500));
		assert.ok(result.length < 500);
		assert.ok(result.endsWith('...'));
	});
});

describe('findMissingEntrySignals', () => {
	it('finds nothing missing when the application rendered its breadcrumb', () => {
		assert.deepEqual(findMissingEntrySignals(observation()), []);
	});

	it('reports an empty mount point, which is what an unmounted application looks like', () => {
		const missing = findMissingEntrySignals(observation({ mountHtml: '', mountText: '', breadcrumbText: undefined }));
		assert.ok(missing.some((signal) => signal.includes(APP_MOUNT_SELECTOR)));
		assert.ok(missing.some((signal) => signal.includes(BREADCRUMB_SELECTOR)));
	});

	it('reports a page that mounted something other than the entry route', () => {
		const missing = findMissingEntrySignals(
			observation({ breadcrumbText: 'Statement Importer', mountText: 'Statement Importer' })
		);
		assert.deepEqual(missing, [`breadcrumb label "${ENTRY_BREADCRUMB_LABEL}"`]);
	});

	it('reports a deployment failure screen even when it renders a breadcrumb', () => {
		const missing = findMissingEntrySignals(observation({ mountText: `Banking ${FAILURE_MARKER}` }));
		assert.ok(missing.some((signal) => signal.includes(FAILURE_MARKER)));
	});
});

describe('formatEntryScreenFailure', () => {
	const report = formatEntryScreenFailure(
		observation({
			mountHtml: '',
			mountText: '',
			breadcrumbText: undefined,
			pageErrors: ['Uncaught TypeError: e is not a function'],
			waitedMs: 30_000
		})
	);

	it('reports the failure as the same event the preview environment names', () => {
		assert.ok(report.includes(FAILURE_MARKER));
	});

	it('places the failure at the rendering stage, after building and serving succeeded', () => {
		assert.ok(report.includes('Stage: render'));
	});

	it('states how long the entry screen was waited for', () => {
		assert.ok(report.includes('30000 ms'));
	});

	it('quotes what the page reported, so the cause is in the report itself', () => {
		assert.ok(report.includes('Uncaught TypeError: e is not a function'));
	});

	it('says what is still missing while the failure stands', () => {
		assert.ok(report.includes('Impact: '));
		assert.ok(report.includes('does not show the Banking application'));
	});

	it('keeps the harness report shape on every line', () => {
		for (const line of report.split('\n')) {
			assert.ok(line.startsWith(LOG_PREFIX), `line without the source prefix: ${line}`);
		}
	});
});
