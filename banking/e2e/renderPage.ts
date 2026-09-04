/**
 * Opens one served address in a process of its own and reports what it rendered.
 *
 * The scenario checks three addresses, and each has to be opened the way a
 * browser opens one: a page that runs the bundle from the top. One process
 * cannot do that twice. Node keeps a single instance of a module per URL, so a
 * second import of the built entry hands back the first page's already-executed
 * module and mounts nothing — and forcing it to run again under a distinct URL
 * is worse: the entry chunk's modules then exist twice while the lazily loaded
 * chunks still import the first copy, react-router's context stops matching
 * across the two (`useNavigate() may be used only in the context of a
 * <Router>`), and the harness fails for a reason the preview does not have.
 *
 * So each address gets its own process, and this is that process. What it
 * prints is the observation itself — plain data, so both sides judge it with
 * the same functions in `./entryScreen.ts` instead of sharing a live DOM.
 *
 * Usage: node e2e/renderPage.ts --url <address> --module <built entry module> [--json]
 *   --json  print the observation as JSON on stdout (report goes to stderr)
 */

import path from 'node:path';
import process from 'node:process';
import { FAILURE_MARKER, HarnessFailure, formatFailure, formatReport } from './buildReport.ts';
import { renderEntry } from './domRuntime.ts';
import {
	excerpt,
	findFailureSignals,
	findModuleEntry,
	isFailureScreen,
	type EntryObservation
} from './entryScreen.ts';

/** The only answer a person can open a screen from. */
export const PAGE_STATUS = 200;

/**
 * Why this answer cannot be opened, or `undefined` when it is the app page.
 *
 * Checked before anything runs, because the two failures read alike and are
 * not: an address the preview refuses is its Not Found page, and reporting that
 * as "the application did not mount" sends the reader looking for a bug in a
 * bundle that was never given the chance to run.
 */
export function findUnopenableAnswer(status: number, html: string): string | undefined {
	if (status !== PAGE_STATUS) {
		return `the address answered ${String(status)} instead of the application page`;
	}
	if (isFailureScreen(html)) {
		return `the address answered the ${FAILURE_MARKER} screen instead of the application page`;
	}
	return undefined;
}

export interface OpenPageOptions {
	/** The address to open, exactly as a person would arrive at it. */
	url: string;
	/** Absolute path of the entry module the built page loads. */
	moduleFile: string;
}

/**
 * Fetches an address and runs the built bundle on what came back.
 *
 * The page is taken from the address rather than handed in, so what is rendered
 * is what that address actually serves — a reload, not a replay of a page
 * fetched somewhere else.
 */
export async function openPage(options: OpenPageOptions): Promise<EntryObservation> {
	let response: Response;
	try {
		response = await fetch(options.url);
	} catch (error) {
		throw new HarnessFailure({
			stage: 'render',
			reason: `the address could not be reached (${(error as Error).message})`,
			fix: 'start the preview server first: `yarn e2e:preview-server --artifacts <report.json>`',
			details: [{ label: 'Address', value: options.url }],
			impact: 'no page was opened, so nothing is known about what the preview shows'
		});
	}
	const html = await response.text();

	const unopenable = findUnopenableAnswer(response.status, html);
	if (unopenable !== undefined) {
		throw new HarnessFailure({
			stage: 'render',
			reason: unopenable,
			fix: 'request that address from the preview by hand; it is either a path the preview does not serve or a build that failed',
			details: [
				{ label: 'Address', value: options.url },
				{ label: 'Answer', value: excerpt(html) }
			],
			impact: 'nothing ran at this address, so the application was never given the chance to open'
		});
	}

	const moduleAddress = findModuleEntry(html);
	if (moduleAddress === undefined) {
		throw new HarnessFailure({
			stage: 'render',
			reason: 'the served page loads no entry module',
			fix: 'check the built HTML entry: a page without a module script has nothing to run',
			details: [
				{ label: 'Address', value: options.url },
				{ label: 'Answer', value: excerpt(html) }
			],
			impact: 'the page is served but nothing would ever mount on it'
		});
	}

	const entry = await renderEntry({
		html,
		url: options.url,
		cookies: response.headers.getSetCookie(),
		moduleFile: options.moduleFile,
		moduleAddress
	});
	// The observation is a snapshot; the page has nothing left to do once it is
	// taken, and a page left running would keep asking a server that is closing.
	const { close, ...observation } = entry;
	close();
	return observation;
}

/**
 * The one block this process prints, reporting what it observed.
 *
 * It declares what this command did — it opened the page — and never whether
 * the screen is healthy: this process reports facts and exits `0` whenever it
 * managed to open the address, and the judgement of whether that observation
 * passes belongs to the scenario that asked for it. Saying "failed" here while
 * exiting `0` would put the result declaration and the exit code at odds.
 */
export function formatObservation(observation: EntryObservation): string {
	const signals = findFailureSignals(observation);
	return formatReport(
		'Page opened',
		`the built bundle ran on what ${observation.address} served, for ${String(observation.waitedMs)} ms`,
		[
			{ label: 'Rendered', value: excerpt(observation.mountText) },
			{ label: 'Breadcrumb', value: observation.breadcrumbText?.trim() ?? '(none)' },
			{ label: 'Requests', value: String(observation.requests.length) },
			{
				label: 'Failures',
				// The refused requests are in here too: a screen that rendered
				// around a `404` looks exactly like one that got its answers.
				value: signals.length === 0 ? '(none)' : signals.join('; ')
			}
		]
	);
}

function readFlag(argv: string[], flag: string): string {
	const index = argv.indexOf(flag);
	const value = index === -1 ? undefined : argv[index + 1];
	if (value === undefined || value.startsWith('--')) {
		throw new HarnessFailure({
			stage: 'prepare',
			reason: `${flag} was given without a value`,
			fix: 'run `node e2e/renderPage.ts --url <address> --module <built entry module>`',
			details: [{ label: 'Arguments', value: argv.join(' ') || '(none)' }],
			impact: 'no page was opened'
		});
	}
	return value;
}

async function main(argv: string[]): Promise<number> {
	try {
		const observation = await openPage({
			url: readFlag(argv, '--url'),
			moduleFile: path.resolve(readFlag(argv, '--module'))
		});
		const report = formatObservation(observation);
		if (argv.includes('--json')) {
			console.error(report);
			console.log(JSON.stringify(observation, null, 2));
		} else {
			console.log(report);
		}
		return 0;
	} catch (error) {
		if (error instanceof HarnessFailure) {
			console.error(formatFailure(error.report));
			return 1;
		}
		throw error;
	}
}

// Only the CLI invocation opens a page; importing this module for tests must not.
if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
	process.exitCode = await main(process.argv.slice(2));
}
