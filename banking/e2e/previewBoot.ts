/**
 * The boot payload a preview needs, and the substitution of the HTML entry's
 * server-side placeholders.
 *
 * In a bench, `erpnext/www/banking.html` is a Jinja template: the web server
 * fills `{{ boot }}`, `{{ frappe.session.csrf_token }}` and friends before the
 * browser ever sees it. A preview that only has the build output has no such
 * server, so the page would arrive with the placeholders intact and the app
 * would fail on `JSON.parse({{ boot }})`.
 *
 * This module fills exactly those placeholders with a signed-in stub, so the
 * preview exercises the production entry path (`import.meta.env.DEV === false`)
 * without a Frappe backend. It is pure — no filesystem, no network — so the
 * substitution rules are testable on their own.
 */

/** The signed-in user the preview boots as. Anything but `Guest` clears the app's login gate. */
export const PREVIEW_USER = 'Administrator';

/** Site the preview claims to be, mirroring bench's `.localhost` development hosts. */
export const PREVIEW_SITENAME = 'banking-preview.localhost';

/** Company preselected for the reconciliation screens, via the user's defaults. */
export const PREVIEW_COMPANY = 'Preview Company';

/**
 * Stand-in for the token bench mints per session. Nothing verifies it in a
 * preview; it exists because the page assigns `window.csrf_token` and the API
 * client sends it back on every write.
 */
export const PREVIEW_CSRF_TOKEN = 'preview-csrf-token';

/** Doctypes the Banking screens read; permission helpers answer from these lists. */
const PREVIEW_DOCTYPES = [
	'Account',
	'Bank',
	'Bank Account',
	'Bank Clearance',
	'Bank Statement Import',
	'Bank Transaction',
	'Company',
	'Journal Entry',
	'Party Type',
	'Payment Entry'
];

/** Placeholder expressions this module knows how to fill, by the name the template uses. */
export type PlaceholderName =
	| 'boot'
	| 'csrf_token'
	| 'frappe.session.csrf_token'
	| 'lang'
	| 'layout_direction'
	| 'app_name'
	| 'favicon'
	| 'build_version';

/** Raised when the HTML entry asks for something this module cannot fill. */
export class UnknownPlaceholderError extends Error {
	readonly expressions: string[];

	constructor(expressions: string[]) {
		super(
			`the HTML entry contains placeholders this preview cannot fill: ${expressions.join(', ')}`
		);
		this.name = 'UnknownPlaceholderError';
		this.expressions = expressions;
	}
}

/** The boot payload shape the app reads. Only the fields it actually touches are modelled. */
export interface PreviewBoot {
	sitename: string;
	lang: string;
	desk_theme: string;
	layout_direction: string;
	translations_version: string;
	docs: unknown[];
	time_zone: { system: string; user: string };
	sysdefaults: Record<string, string>;
	user: {
		name: string;
		full_name: string;
		defaults: Record<string, string>;
		roles: string[];
		can_read: string[];
		can_write: string[];
		can_create: string[];
		can_delete: string[];
		can_cancel: string[];
		can_search: string[];
		can_import: string[];
		can_export: string[];
	};
	__messages: Record<string, string>;
}

/**
 * Builds the boot payload.
 *
 * Every field here is read by the app on the way to its first screen: the login
 * gate reads `user.name`, the theme and direction providers read `desk_theme`
 * and `layout_direction`, the date and currency helpers read `sysdefaults` and
 * `user.defaults`, and `frappe.model.sync` is handed `docs`. A missing field is
 * not a cosmetic gap — it is a blank screen.
 */
export function createPreviewBoot(): PreviewBoot {
	return {
		sitename: PREVIEW_SITENAME,
		lang: 'en',
		desk_theme: 'Light',
		layout_direction: 'ltr',
		translations_version: 'preview',
		docs: [],
		time_zone: { system: 'UTC', user: 'UTC' },
		sysdefaults: {
			country: 'United States',
			currency: 'USD',
			currency_precision: '2',
			date_format: 'yyyy-mm-dd',
			float_precision: '3',
			hide_currency_symbol: 'No',
			number_format: '#,###.##',
			time_format: 'HH:mm:ss'
		},
		user: {
			name: PREVIEW_USER,
			full_name: 'Preview User',
			defaults: {
				company: PREVIEW_COMPANY,
				currency: 'USD',
				date_format: 'yyyy-mm-dd',
				time_zone: 'UTC'
			},
			roles: ['System Manager', 'Accounts Manager', 'Accounts User'],
			can_read: [...PREVIEW_DOCTYPES],
			can_write: [...PREVIEW_DOCTYPES],
			can_create: [...PREVIEW_DOCTYPES],
			can_delete: [...PREVIEW_DOCTYPES],
			can_cancel: [...PREVIEW_DOCTYPES],
			can_search: [...PREVIEW_DOCTYPES],
			can_import: [...PREVIEW_DOCTYPES],
			can_export: [...PREVIEW_DOCTYPES]
		},
		__messages: {}
	};
}

/**
 * Serialises the boot payload the way the template consumes it.
 *
 * The page runs `frappe.boot = JSON.parse({{ boot }})`, so the placeholder must
 * become a JavaScript *string literal* holding JSON — bench produces it by
 * JSON-encoding the JSON. `<` is escaped so no value can close the surrounding
 * `<script>` element.
 */
export function serializeBoot(boot: PreviewBoot): string {
	return JSON.stringify(JSON.stringify(boot)).replaceAll('<', '\\u003c');
}

/** The values every known placeholder resolves to. */
export function createPlaceholderValues(boot: PreviewBoot): Record<PlaceholderName, string> {
	const csrfToken = PREVIEW_CSRF_TOKEN;
	return {
		boot: serializeBoot(boot),
		csrf_token: csrfToken,
		'frappe.session.csrf_token': csrfToken,
		lang: boot.lang,
		layout_direction: boot.layout_direction,
		app_name: 'ERPNext',
		// Empty on purpose: the template falls back to the bundled ERPNext icon,
		// exactly as it does on a site that has not set a custom favicon.
		favicon: '',
		build_version: 'preview'
	};
}

/** Matches a Jinja output expression, including one spanning lines. */
const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;

/** Jinja's `or`, which the template uses to give `favicon` a default. */
const OR_SEPARATOR = /\s+or\s+/;

/** A quoted literal operand, e.g. `' /assets/erpnext/images/erpnext-favicon.svg'`. */
const QUOTED_LITERAL = /^(['"])([\s\S]*)\1$/;

/**
 * Resolves one placeholder expression.
 *
 * Only what the entry template actually uses is supported: a name, or a chain
 * of `or` operands ending in a quoted default. Anything else is reported rather
 * than guessed — a silently empty `boot` would produce a blank preview that
 * looks like an app bug.
 */
function resolveExpression(expression: string, values: Record<string, string>, unknown: string[]): string {
	const operands = expression.trim().split(OR_SEPARATOR);
	let last = '';
	for (const operand of operands) {
		const literal = QUOTED_LITERAL.exec(operand);
		last = literal ? literal[2] : (values[operand] ?? '');
		if (!literal && !(operand in values)) {
			unknown.push(operand);
			return '';
		}
		if (last !== '') {
			return last;
		}
	}
	return last;
}

/**
 * Fills the entry template's placeholders.
 *
 * @throws UnknownPlaceholderError when the template asks for a value this
 * preview does not model — filling the page with a hole is worse than refusing
 * to serve it, because the failure would surface as an unexplained blank screen.
 */
export function renderPreviewHtml(template: string, values: Record<string, string>): string {
	const unknown: string[] = [];
	const html = template.replace(PLACEHOLDER_PATTERN, (_match, expression: string) =>
		resolveExpression(expression, values, unknown)
	);
	if (unknown.length > 0) {
		throw new UnknownPlaceholderError([...new Set(unknown)]);
	}
	return html;
}

/** Reports any `{{ ... }}` left in rendered output, so a hole can never reach the browser. */
export function findUnresolvedPlaceholders(html: string): string[] {
	return [...html.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[0]);
}
