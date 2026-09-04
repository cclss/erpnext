import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
	PREVIEW_USER,
	UnknownPlaceholderError,
	createPlaceholderValues,
	createPreviewBoot,
	findUnresolvedPlaceholders,
	renderPreviewHtml,
	serializeBoot
} from './previewBoot.ts';

/** The app's HTML entry, the same template the build copies to `erpnext/www/banking.html`. */
const ENTRY_TEMPLATE = new URL('../index.html', import.meta.url);

function render(template: string): string {
	return renderPreviewHtml(template, createPlaceholderValues(createPreviewBoot()));
}

test('the real HTML entry renders with nothing left for a server to fill', () => {
	const html = render(readFileSync(ENTRY_TEMPLATE, 'utf8'));

	// Not a raw `}}` search: the inlined boot JSON legitimately ends nested
	// objects that way. What must not survive is a `{{ ... }}` expression.
	assert.deepEqual(findUnresolvedPlaceholders(html), []);
});

test('the boot placeholder becomes a string literal the page can JSON.parse', () => {
	const html = render(readFileSync(ENTRY_TEMPLATE, 'utf8'));

	// The page runs `frappe.boot = JSON.parse(<here>)`, so the substituted text
	// must itself be a JavaScript expression evaluating to JSON text.
	const match = /frappe\.boot = JSON\.parse\((.+?)\);/.exec(html);
	assert.ok(match, 'the boot assignment survived rendering');

	const literal: unknown = JSON.parse(match[1]);
	assert.equal(typeof literal, 'string');
	const boot = JSON.parse(literal as string) as ReturnType<typeof createPreviewBoot>;
	assert.equal(boot.user.name, PREVIEW_USER);
});

test('the boot payload carries what the app reads on its way to the first screen', () => {
	const boot = createPreviewBoot();

	assert.notEqual(boot.user.name, 'Guest', 'a guest boot keeps the app behind its login gate');
	assert.ok(boot.sitename);
	assert.ok(boot.desk_theme);
	assert.equal(boot.layout_direction, 'ltr');
	assert.deepEqual(boot.docs, [], 'frappe.model.sync is handed this at startup');
	assert.ok(boot.user.defaults.company, 'the reconciliation screens read a default company');
	assert.ok(boot.user.defaults.date_format, 'date formatting reads this without a fallback');
	assert.ok(boot.sysdefaults.date_format);
	assert.ok(boot.sysdefaults.currency);
	assert.ok(boot.time_zone.system && boot.time_zone.user);
	assert.ok(boot.user.can_read.includes('Bank Transaction'));
});

test('a serialised boot cannot close the script element that holds it', () => {
	const boot = createPreviewBoot();
	boot.sitename = '</script><script>alert(1)</script>';

	const serialized = serializeBoot(boot);

	assert.ok(!serialized.includes('</script>'), 'the closing tag must not appear verbatim');
	assert.equal(
		(JSON.parse(JSON.parse(serialized) as string) as typeof boot).sitename,
		'</script><script>alert(1)</script>',
		'escaping must not change the value the app reads'
	);
});

test("Jinja's or-default is honoured for values the preview leaves empty", () => {
	const html = render('<link href="{{ favicon or \' /assets/erpnext/images/erpnext-favicon.svg\' }}">');

	assert.equal(html, '<link href=" /assets/erpnext/images/erpnext-favicon.svg">');
});

test('a provided value wins over the default operand', () => {
	const html = renderPreviewHtml('{{ app_name or "Fallback" }}', { app_name: 'ERPNext' });

	assert.equal(html, 'ERPNext');
});

test('whitespace around a placeholder expression is irrelevant', () => {
	const values = { lang: 'en' };

	assert.equal(renderPreviewHtml('{{lang}}', values), 'en');
	assert.equal(renderPreviewHtml('{{   lang   }}', values), 'en');
});

test('an unfillable placeholder is reported instead of silently emptied', () => {
	assert.throws(
		() => render('<body>{{ frappe.session.user }}{{ csrf_token }}{{ build_number }}</body>'),
		(error: unknown) => {
			assert.ok(error instanceof UnknownPlaceholderError);
			assert.deepEqual(error.expressions, ['frappe.session.user', 'build_number']);
			return true;
		}
	);
});

test('unresolved placeholders are detectable in rendered output', () => {
	assert.deepEqual(findUnresolvedPlaceholders('<p>{{ boot }}</p><p>{{lang}}</p>'), ['{{ boot }}', '{{lang}}']);
});
