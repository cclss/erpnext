import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FAILURE_MARKER, LOG_PREFIX } from './buildReport.ts';
import { type EntryObservation } from './entryScreen.ts';
import { PAGE_STATUS, findUnopenableAnswer, formatObservation } from './renderPage.ts';

const APP_PAGE = '<html><body><div id="root"></div><script type="module" src="/assets/erpnext/banking/assets/index.js"></script></body></html>';

/** An observation of a healthy page; each test spoils one part of it. */
function observation(overrides: Partial<EntryObservation> = {}): EntryObservation {
	return {
		address: 'http://127.0.0.1:41234/banking/statement-importer/BSI.2026.1',
		mountHtml: '<div><nav aria-label="breadcrumb">Banking</nav></div>',
		mountText: 'Banking',
		breadcrumbText: 'Banking',
		pageErrors: [],
		requests: [{ url: '/api/method/frappe.client.get_list', status: 200 }],
		waitedMs: 120,
		...overrides
	};
}

describe('findUnopenableAnswer', () => {
	it('opens the answer a served screen gets', () => {
		assert.equal(findUnopenableAnswer(PAGE_STATUS, APP_PAGE), undefined);
	});

	it('names the refusal rather than letting the bundle be blamed for it', () => {
		// This is the preview's own Not Found page. Nothing ran, so "the
		// application did not mount" would point at the wrong thing entirely.
		const reason = findUnopenableAnswer(404, 'the preview serves /banking, not /banking/statement-importer/BSI.2026.1');
		assert.ok(reason?.includes('404'));
	});

	it('names the deployment failure screen, which arrives with a healthy status', () => {
		const reason = findUnopenableAnswer(PAGE_STATUS, `${LOG_PREFIX} build failed (${FAILURE_MARKER})`);
		assert.ok(reason?.includes(FAILURE_MARKER));
	});
});

describe('formatObservation', () => {
	it('says the page opened, at which address, and what it rendered', () => {
		const report = formatObservation(observation());
		assert.ok(report.includes('Page opened'));
		assert.ok(report.includes('/banking/statement-importer/BSI.2026.1'));
		assert.ok(report.includes('Rendered: Banking'));
		assert.ok(report.includes('Failures: (none)'));
	});

	it('quotes what the preview refused, which the rendered screen does not show', () => {
		const report = formatObservation(
			observation({ requests: [{ url: '/assets/erpnext/banking/assets/chunk.js', status: 404 }] })
		);
		assert.ok(report.includes('/assets/erpnext/banking/assets/chunk.js'));
		assert.ok(report.includes('404'));
	});

	it('still declares only that the page opened, because this command exits 0 either way', () => {
		// The result declaration and the exit code have to say the same thing.
		// Whether the observation passes is the scenario's judgement, not this
		// command's, and it reports that failure itself.
		const report = formatObservation(observation({ mountHtml: '', mountText: '', breadcrumbText: undefined }));
		assert.ok(report.includes('Page opened'));
		assert.ok(!report.includes('failed'));
	});

	it('keeps the harness report shape on every line', () => {
		for (const line of formatObservation(observation()).split('\n')) {
			assert.ok(line.startsWith(LOG_PREFIX), `line without the source prefix: ${line}`);
		}
	});
});
