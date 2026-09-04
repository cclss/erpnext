/**
 * Console report vocabulary for the isolated preview build harness.
 *
 * Every line the harness prints is assembled here so the wording stays one
 * shape: a source prefix on each line, an indented `label: value` block for
 * details, and a single ` — ` separator between what happened and why. The
 * harness itself only decides *what* to report; how it reads is this module's
 * job. Keeping the assembly pure also makes it directly testable without
 * running a build.
 */

/** Prefix every line carries, so harness output stays attributable. */
export const LOG_PREFIX = '[banking]';

/** Indentation for detail lines, applied after the prefix. */
export const DETAIL_INDENT = '  ';

/** Separates the outcome statement from its cause. */
export const CAUSE_SEPARATOR = ' — ';

/** Terminates a detail label. */
export const LABEL_SUFFIX = ':';

/**
 * The marker a failing run must carry. The preview environment reports a
 * broken deployment as `build_failed`; naming it here means a harness failure
 * is greppable as the same event.
 */
export const FAILURE_MARKER = 'build_failed';

/** The stage a failure belongs to, from tree preparation to opening the served page. */
export type FailureStage = 'prepare' | 'install' | 'build' | 'verify' | 'serve' | 'render';

/** One `label: value` line of a report. */
export interface ReportDetail {
	label: string;
	value: string;
}

export interface SuccessReport {
	/** Why this run counts as isolated, stated as the cause of the success. */
	isolation: string;
	details: ReportDetail[];
}

export interface FailureReport {
	stage: FailureStage;
	/** Why the run failed, in one lower-case clause. */
	reason: string;
	/** How to get out of it. */
	fix: string;
	details: ReportDetail[];
	/**
	 * What is missing while this failure stands. Defaults to the build case —
	 * no artefacts at all — which is wrong for a stage that failed with the
	 * artefacts already on disk.
	 */
	impact?: string;
}

/** Assembles a prefixed, indented report block. Callers pass sentences without the final period. */
export function formatReport(headline: string, cause: string | undefined, details: ReportDetail[]): string {
	const statement = cause === undefined ? headline : `${headline}${CAUSE_SEPARATOR}${cause}`;
	const lines = [`${LOG_PREFIX} ${statement}.`];
	for (const { label, value } of details) {
		lines.push(`${LOG_PREFIX} ${DETAIL_INDENT}${label}${LABEL_SUFFIX} ${value}`);
	}
	return lines.join('\n');
}

export function formatSuccess(report: SuccessReport): string {
	return formatReport('Isolated preview build succeeded', report.isolation, report.details);
}

export function formatFailure(report: FailureReport): string {
	return formatReport(`Isolated preview build failed (${FAILURE_MARKER})`, report.reason, [
		{ label: 'Stage', value: report.stage },
		...report.details,
		{ label: 'Fix', value: report.fix },
		{
			label: 'Impact',
			value:
				report.impact ??
				'no preview artefacts were produced; the preview would still show the deployment failure screen'
		}
	]);
}

/** Raised for every expected harness failure, so the entry point can report instead of throwing a stack. */
export class HarnessFailure extends Error {
	readonly report: FailureReport;

	constructor(report: FailureReport) {
		super(`${FAILURE_MARKER}: ${report.reason}`);
		this.name = 'HarnessFailure';
		this.report = report;
	}
}

/**
 * Collects the built asset references from an HTML entry.
 *
 * Only references under `base` are returned: anything else is either an
 * absolute URL or a bench-served path that this harness does not produce, and
 * counting those as build output would let an empty build look successful.
 */
export function collectAssetReferences(html: string, base: string): string[] {
	const references = new Set<string>();
	for (const match of html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/g)) {
		const reference = match[1];
		if (reference.startsWith(base) && reference.length > base.length) {
			references.add(reference);
		}
	}
	return [...references];
}

/**
 * Escape sequences a terminal renders but a report line should not carry.
 * Built from the escape character's code point because a literal control
 * character in a pattern is itself a lint error.
 */
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Lines that describe the runner rather than the failure. */
const RUNNER_NOISE = /^(\$ |yarn run |info Visit|error Command failed|at )/;

/** Lines that name an actual cause, in the order a reader would want them. */
const SPECIFIC_CAUSE = /(ENOENT|Could not resolve|Cannot find|failed to load config|[A-Za-z]*Error:|error TS[0-9]+)/;

/** Longest quoted line; bundler output can contain a whole minified module on one line. */
const MAX_QUOTED_LENGTH = 200;

/**
 * Reduces a build log to the one line worth quoting in a report.
 *
 * Both the runner and the bundler frame their failures with generic banners
 * ("error during build:", "Command failed with exit code 1"), so the specific
 * cause is picked first and the last informative line is only a fallback.
 */
export function summarizeBuildFailure(log: string): string {
	const lines = log
		.split('\n')
		.map((line) => line.replace(ANSI_ESCAPE, '').trim())
		.filter((line) => line !== '' && !RUNNER_NOISE.test(line));
	const quoted = lines.find((line) => SPECIFIC_CAUSE.test(line)) ?? lines[lines.length - 1] ?? '';
	return quoted.length > MAX_QUOTED_LENGTH ? `${quoted.slice(0, MAX_QUOTED_LENGTH)}...` : quoted;
}

/** Turns an asset reference into the path relative to the build output directory. */
export function toArtifactPath(reference: string, base: string): string {
	return reference.slice(base.length);
}
