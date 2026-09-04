/**
 * Minimal Frappe API responses for the preview.
 *
 * The preview has no backend, but the app starts calling the API as soon as it
 * renders. Left unanswered, those calls surface as error banners and retries
 * that make a working entry screen look broken. So every API route answers with
 * the *empty* shape its client expects: an empty collection, a zero count, an
 * empty report. Nothing here invents data — a preview that showed fabricated
 * bank transactions would be lying about the backend.
 *
 * Pure by design: the shapes are decided here and tested without a server.
 */

/** Everything the app's API client addresses. */
export const API_PREFIX = '/api/';

/** Whitelisted-method calls: `frappe-js-sdk` reads `data.message`. */
const METHOD_PREFIX = '/api/method/';

/** Document routes: `frappe-js-sdk` reads `data.data`. */
const RESOURCE_PREFIX = '/api/resource/';

/** An empty query-report payload, matching the app's `QueryReportReturnType`. */
const EMPTY_REPORT = {
	prepared_report: false,
	report_summary: [],
	result: [],
	columns: [],
	add_total_row: false
};

/**
 * Methods whose empty answer is not `null`.
 *
 * A count must be a number, a report must have `result`/`columns` arrays to map
 * over, and the translation dictionary must be an object the page can spread.
 * Everything else is a method the entry screen does not depend on, so `null`
 * is both minimal and honest.
 */
const METHOD_RESPONSES: Record<string, unknown> = {
	'frappe.client.get_count': 0,
	'frappe.client.get_list': [],
	'frappe.client.get_value': {},
	'frappe.client.get_single_value': null,
	'frappe.desk.query_report.run': EMPTY_REPORT,
	'frappe.desk.search.search_link': [],
	'frappe.translate.get_boot_translations': {}
};

export interface StubResponse {
	status: number;
	body: unknown;
}

/** True for paths this module answers. */
export function isApiPath(pathname: string): boolean {
	return pathname.startsWith(API_PREFIX);
}

/**
 * Builds the response for an API path.
 *
 * Unknown routes under `/api/` still get a well-formed empty envelope rather
 * than a 404: the client turns a 404 into an error toast, which would be a
 * preview artefact rather than an app state.
 */
export function stubApiResponse(pathname: string): StubResponse {
	if (pathname.startsWith(METHOD_PREFIX)) {
		const method = pathname.slice(METHOD_PREFIX.length);
		const message = method in METHOD_RESPONSES ? METHOD_RESPONSES[method] : null;
		return { status: 200, body: { message } };
	}

	if (pathname.startsWith(RESOURCE_PREFIX)) {
		const segments = pathname
			.slice(RESOURCE_PREFIX.length)
			.split('/')
			.filter((segment) => segment !== '');
		// `/api/resource/{doctype}` lists documents, `/api/resource/{doctype}/{name}`
		// fetches one; the client reads `data.data` in both cases.
		return { status: 200, body: { data: segments.length > 1 ? {} : [] } };
	}

	return { status: 200, body: { message: null } };
}
