import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FAILURE_MARKER, LOG_PREFIX } from './buildReport.ts';
import {
	APP_MOUNT_SELECTOR,
	BREADCRUMB_SELECTOR,
	ENTRY_BREADCRUMB_LABEL,
	describeRequest,
	excerpt,
	findFailedRequests,
	findFailureSignals,
	findMissingEntrySignals,
	findModuleEntry,
	formatEntryScreenFailure,
	isFailedRequest,
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
		requests: [{ url: '/api/method/frappe.client.get_list', status: 200 }],
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

describe('isFailedRequest', () => {
	it('accepts the answer a served file gets', () => {
		assert.equal(isFailedRequest({ url: '/assets/erpnext/banking/assets/index.js', status: 200 }), false);
	});

	it('accepts a redirect, which is an answer that tells the page where to go instead', () => {
		assert.equal(isFailedRequest({ url: '/', status: 302 }), false);
	});

	it('rejects the answer a path the preview does not serve gets', () => {
		assert.equal(isFailedRequest({ url: '/api/method/banking.missing', status: 404 }), true);
	});

	it('rejects a request that never got an answer at all', () => {
		assert.equal(isFailedRequest({ url: '/api/method/x', error: 'fetch failed' }), true);
	});
});

describe('findFailedRequests', () => {
	it('keeps only what the preview refused, in the order the page asked', () => {
		const failed = findFailedRequests([
			{ url: '/api/method/ok', status: 200 },
			{ url: '/api/method/gone', status: 404 },
			{ url: '/assets/erpnext/banking/assets/late.js', status: 500 }
		]);
		assert.deepEqual(
			failed.map((request) => request.url),
			['/api/method/gone', '/assets/erpnext/banking/assets/late.js']
		);
	});

	it('finds nothing to report on a preview that answered everything', () => {
		assert.deepEqual(findFailedRequests([{ url: '/api/method/ok', status: 200 }]), []);
	});
});

describe('describeRequest', () => {
	it('names the address and the status it came back with', () => {
		assert.equal(describeRequest({ url: '/api/method/gone', status: 404 }), '/api/method/gone — answered 404');
	});

	it('says why a request got no answer instead of quoting a status it never had', () => {
		const line = describeRequest({ url: '/api/method/x', error: 'fetch failed' });
		assert.ok(line.includes('/api/method/x'));
		assert.ok(line.includes('fetch failed'));
		assert.ok(!line.includes('undefined'));
	});
});

describe('findFailureSignals', () => {
	it('finds nothing wrong with a screen that rendered and got every answer', () => {
		assert.deepEqual(findFailureSignals(observation()), []);
	});

	it('reports a 404 the page received, with the address and the status', () => {
		const signals = findFailureSignals(
			observation({
				requests: [
					{ url: '/api/method/frappe.client.get_list', status: 200 },
					{ url: '/assets/erpnext/banking/assets/chunk.js', status: 404 }
				]
			})
		);

		assert.equal(signals.length, 1);
		assert.ok(signals[0].includes('/assets/erpnext/banking/assets/chunk.js'));
		assert.ok(signals[0].includes('404'));
	});

	it('reports a request the preview never answered', () => {
		const signals = findFailureSignals(
			observation({ requests: [{ url: '/api/method/x', error: 'connect ECONNREFUSED' }] })
		);
		assert.equal(signals.length, 1);
		assert.ok(signals[0].includes('connect ECONNREFUSED'));
	});

	it('reports what the page logged, which a rendered screen would otherwise hide', () => {
		const signals = findFailureSignals(observation({ pageErrors: ['Warning: failed to load statements'] }));
		assert.deepEqual(signals, ['page error — Warning: failed to load statements']);
	});

	it('carries the entry-screen signals too, so one list answers whether the preview opened', () => {
		const signals = findFailureSignals(
			observation({
				mountHtml: '',
				mountText: '',
				breadcrumbText: undefined,
				pageErrors: ['Uncaught TypeError: e is not a function'],
				requests: [{ url: '/api/method/gone', status: 404 }]
			})
		);

		assert.equal(signals.length, 4);
		assert.ok(signals.some((signal) => signal.includes(APP_MOUNT_SELECTOR)));
		assert.ok(signals.some((signal) => signal.includes(BREADCRUMB_SELECTOR)));
		assert.ok(signals.some((signal) => signal.includes('/api/method/gone')));
		assert.ok(signals.some((signal) => signal.includes('Uncaught TypeError')));
	});
});

describe('formatEntryScreenFailure on a screen that rendered without its answers', () => {
	const report = formatEntryScreenFailure(
		observation({ requests: [{ url: '/api/method/banking.get_bank_transactions', status: 404 }], waitedMs: 3_000 })
	);

	it('quotes the refused address and its status, so the report names the request itself', () => {
		assert.ok(report.includes('/api/method/banking.get_bank_transactions'));
		assert.ok(report.includes('404'));
	});

	it('does not claim the entry screen was missing when it was on the page', () => {
		assert.ok(!report.includes('was not on it'));
		assert.ok(report.includes('Missing: (nothing)'));
	});

	it('states an impact that matches what actually happened', () => {
		assert.ok(report.includes('the preview shows the Banking application'));
	});

	it('keeps the harness report shape on every line', () => {
		for (const line of report.split('\n')) {
			assert.ok(line.startsWith(LOG_PREFIX), `line without the source prefix: ${line}`);
		}
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

	it('states that nothing was refused rather than leaving the request line out', () => {
		assert.ok(report.includes('Failed requests: (none)'));
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
