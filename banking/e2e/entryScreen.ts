/**
 * What "the Banking screen is open" means, expressed as values instead of prose.
 *
 * The scenario that verifies a preview needs two things this module owns: the
 * markers that identify the application entry screen, and the wording used when
 * they are absent. Both are kept pure so they can be tested without building,
 * serving or rendering anything, and so the one place that decides what counts
 * as "the app rendered" is a file rather than an assertion buried in a spec.
 */

import { FAILURE_MARKER, formatFailure, type ReportDetail } from './buildReport.ts';

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

/** Page errors worth quoting; beyond this the first ones already tell the story. */
const MAX_QUOTED_ERRORS = 3;

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

/** The report shown when the preview served a page but the application never appeared. */
export function formatEntryScreenFailure(observation: EntryObservation): string {
	const details: ReportDetail[] = [
		{ label: 'Missing', value: findMissingEntrySignals(observation).join(', ') || '(nothing)' },
		{
			label: 'Page errors',
			value:
				observation.pageErrors.length === 0
					? '(none)'
					: observation.pageErrors.slice(0, MAX_QUOTED_ERRORS).join('; ')
		},
		{ label: 'Rendered', value: excerpt(observation.mountText) }
	];
	return formatFailure({
		stage: 'render',
		reason: `the preview served a page but the Banking entry screen was not on it after ${String(observation.waitedMs)} ms`,
		fix: 'read the page errors above, then open the reported preview address and check what the built bundle does on load',
		details,
		impact: 'the artefacts build and are served, but the preview still does not show the Banking application'
	});
}
