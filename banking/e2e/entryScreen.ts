/**
 * What "the Banking screen is open" means, expressed as values instead of prose.
 *
 * The scenario that verifies a preview needs three things this module owns: the
 * markers that identify the application entry screen, the judgement of what the
 * page asked for and did not get, and the wording used when either is absent. Both are kept pure so they can be tested without building,
 * serving or rendering anything, and so the one place that decides what counts
 * as "the app rendered" is a file rather than an assertion buried in a spec.
 */

import { CAUSE_SEPARATOR, FAILURE_MARKER, formatFailure, type ReportDetail } from './buildReport.ts';

/** Where the application mounts, as the HTML entry declares it. */
export const APP_MOUNT_SELECTOR = '#root';

/**
 * The landmark the entry route renders around its breadcrumb.
 *
 * Chosen over a class or a DOM shape because it is the same thing a screen
 * reader uses to find the trail: styling and layout can change underneath it
 * without invalidating the check.
 */
export const BREADCRUMB_SELECTOR = 'nav[aria-label="breadcrumb"]';

/** The label the breadcrumb's current page carries on the entry route. */
export const ENTRY_BREADCRUMB_LABEL = 'Banking';

/**
 * The module the built page loads. Matched on the `type="module"` script tag
 * rather than on a file name, because the bundler hashes the file name.
 */
const MODULE_ENTRY_PATTERN = /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*>/i;

/** Longest excerpt of rendered content a report quotes. */
const MAX_EXCERPT_LENGTH = 200;

/** Signals worth quoting per report line; beyond this the first ones already tell the story. */
const MAX_QUOTED_SIGNALS = 3;

/** The first status a server uses to refuse rather than to answer. */
const FIRST_REFUSING_STATUS = 400;

/** Returns the entry module's URL as the page references it, or `undefined` when the page loads none. */
export function findModuleEntry(html: string): string | undefined {
	return MODULE_ENTRY_PATTERN.exec(html)?.[1];
}

/**
 * Whether a served page is the preview's deployment failure screen.
 *
 * The harness prints the same marker the preview environment uses, so a page
 * that carries it is a failure report no matter which side produced it.
 */
export function isFailureScreen(content: string): boolean {
	return content.includes(FAILURE_MARKER);
}

/** Collapses rendered content into one quotable line. */
export function excerpt(content: string): string {
	const collapsed = content.replace(/\s+/g, ' ').trim();
	if (collapsed === '') {
		return '(empty)';
	}
	return collapsed.length > MAX_EXCERPT_LENGTH ? `${collapsed.slice(0, MAX_EXCERPT_LENGTH)}...` : collapsed;
}

/**
 * One request the page made while it ran, and what came back.
 *
 * The address is the path as the page asked for it, not the absolute URL: the
 * port a preview happens to get is not part of what was observed.
 */
export interface PageRequest {
	/** The address the page asked for. */
	url: string;
	/** The status it was answered with. Absent when no answer arrived at all. */
	status?: number;
	/** Why no answer arrived, on the request that got none. */
	error?: string;
}

/** What the scenario saw after giving the built bundle a chance to run. */
export interface EntryObservation {
	/** Markup the application rendered into its mount point. */
	mountHtml: string;
	/** Text the application rendered into its mount point. */
	mountText: string;
	/** Text of the breadcrumb landmark, absent when the application rendered none. */
	breadcrumbText?: string;
	/** Errors the page raised while it ran. */
	pageErrors: string[];
	/** Same-origin requests the page made, in the order it made them. */
	requests: PageRequest[];
	/** How long the scenario waited for the entry screen. */
	waitedMs: number;
}

/**
 * The entry-screen signals an observation is missing.
 *
 * An empty result is the pass condition, and the list itself is what the
 * failure report quotes — the reader learns how far the page got, not only
 * that it did not finish.
 */
export function findMissingEntrySignals(observation: EntryObservation): string[] {
	const missing: string[] = [];
	if (observation.mountHtml === '') {
		missing.push(`mounted application at ${APP_MOUNT_SELECTOR}`);
	}
	if (observation.breadcrumbText === undefined) {
		missing.push(`breadcrumb landmark ${BREADCRUMB_SELECTOR}`);
	} else if (!observation.breadcrumbText.includes(ENTRY_BREADCRUMB_LABEL)) {
		missing.push(`breadcrumb label "${ENTRY_BREADCRUMB_LABEL}"`);
	}
	if (isFailureScreen(observation.mountText)) {
		missing.push(`a page that is not the ${FAILURE_MARKER} screen`);
	}
	return missing;
}

/**
 * Whether the preview refused a request instead of answering it.
 *
 * A missing answer counts the same as a refused one: the page asked for
 * something it did not get either way.
 */
export function isFailedRequest(request: PageRequest): boolean {
	return request.status === undefined || request.status >= FIRST_REFUSING_STATUS;
}

/** The requests the page made that the preview did not answer with content. */
export function findFailedRequests(requests: PageRequest[]): PageRequest[] {
	return requests.filter(isFailedRequest);
}

/** One quotable line naming what was asked for and what came back. */
export function describeRequest(request: PageRequest): string {
	const answer =
		request.status === undefined
			? `no answer (${request.error ?? 'cause not reported'})`
			: `answered ${String(request.status)}`;
	return `${request.url}${CAUSE_SEPARATOR}${answer}`;
}

/**
 * Everything in an observation that says the preview did not open cleanly.
 *
 * Three kinds of evidence, one list, because a reader chasing a blank screen
 * needs them together: what the screen is missing, what the page asked for and
 * did not get, and what the page itself reported. The last two are the ones a
 * rendered screen hides — an application draws its empty state around a `404`
 * exactly as it draws it around real emptiness, so a check that only looks at
 * the DOM passes on a preview that is serving half of what it should.
 *
 * An empty result is the pass condition.
 */
export function findFailureSignals(observation: EntryObservation): string[] {
	return [
		...findMissingEntrySignals(observation).map((missing) => `missing ${missing}`),
		...findFailedRequests(observation.requests).map((request) => `request ${describeRequest(request)}`),
		...observation.pageErrors.map((error) => `page error${CAUSE_SEPARATOR}${error}`)
	];
}

/** The report shown when the preview served a page but the application did not open on it. */
export function formatEntryScreenFailure(observation: EntryObservation): string {
	const missing = findMissingEntrySignals(observation);
	const failed = findFailedRequests(observation.requests);
	const details: ReportDetail[] = [
		{ label: 'Missing', value: missing.join(', ') || '(nothing)' },
		{
			label: 'Failed requests',
			value:
				failed.length === 0
					? '(none)'
					: failed.slice(0, MAX_QUOTED_SIGNALS).map(describeRequest).join('; ')
		},
		{
			label: 'Page errors',
			value:
				observation.pageErrors.length === 0
					? '(none)'
					: observation.pageErrors.slice(0, MAX_QUOTED_SIGNALS).join('; ')
		},
		{ label: 'Rendered', value: excerpt(observation.mountText) }
	];
	// A screen that rendered and a screen that never came are different
	// failures, and the report says which one this is: naming the wrong one
	// sends the reader looking for a blank page that is not there.
	const screenRendered = missing.length === 0;
	return formatFailure({
		stage: 'render',
		reason: screenRendered
			? `the Banking entry screen rendered, but the page did not get everything it asked for in ${String(observation.waitedMs)} ms`
			: `the preview served a page but the Banking entry screen was not on it after ${String(observation.waitedMs)} ms`,
		fix: screenRendered
			? 'request the failed addresses above from the reported preview address; each one is either an artefact the build did not produce or a path the preview does not serve'
			: 'read the page errors above, then open the reported preview address and check what the built bundle does on load',
		details,
		impact: screenRendered
			? 'the preview shows the Banking application, but it is running on answers it never received'
			: 'the artefacts build and are served, but the preview still does not show the Banking application'
	});
}
