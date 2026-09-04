import assert from 'node:assert/strict';
import test from 'node:test';
import { isApiPath, stubApiResponse } from './previewApi.ts';

test('only backend routes are claimed by the stub', () => {
	assert.equal(isApiPath('/api/method/frappe.client.get_count'), true);
	assert.equal(isApiPath('/api/resource/Company'), true);
	assert.equal(isApiPath('/banking'), false);
	assert.equal(isApiPath('/assets/erpnext/banking/assets/index.js'), false);
});

test('a whitelisted method answers in the envelope its client reads', () => {
	const response = stubApiResponse('/api/method/frappe.translate.get_boot_translations');

	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { message: {} });
});

test('empty answers keep the shape each caller iterates over', () => {
	assert.deepEqual(stubApiResponse('/api/method/frappe.client.get_count').body, { message: 0 });
	assert.deepEqual(stubApiResponse('/api/method/frappe.client.get_list').body, { message: [] });
	assert.deepEqual(stubApiResponse('/api/method/frappe.desk.query_report.run').body, {
		message: { prepared_report: false, report_summary: [], result: [], columns: [], add_total_row: false }
	});
});

test('an unmodelled method still answers, so no call turns into an error banner', () => {
	const response = stubApiResponse(
		'/api/method/erpnext.accounts.doctype.bank_reconciliation_tool.bank_reconciliation_tool.get_linked_payments'
	);

	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { message: null });
});

test('document routes distinguish a list from a single document', () => {
	assert.deepEqual(stubApiResponse('/api/resource/Company').body, { data: [] });
	assert.deepEqual(stubApiResponse('/api/resource/Company/Preview%20Company').body, { data: {} });
});

test('a trailing slash on a list route is not read as a document name', () => {
	assert.deepEqual(stubApiResponse('/api/resource/Bank Account/').body, { data: [] });
});
