/**
 * What kind of request is this, and what does the preview owe it?
 *
 * The preview server answers four different kinds of request over one socket:
 * the app page, the built bundles, the stubbed backend, and everything it does
 * not serve at all. Deciding between them by hand at the call site is how a
 * bundle request ends up receiving HTML — a 200 that looks fine in the network
 * tab and fails deep inside the browser instead. So the decision is made here,
 * as a pure function of the path, and tested without a socket.
 *
 * The routes are the *production* build's routes. `.env.production` sets
 * `VITE_BASE_NAME=banking`, so the built bundle mounts its router at
 * `/banking` and navigates to `/banking/statement-importer` and
 * `/banking/statement-importer/<id>`. Bench serves the page at that same path,
 * which is why the site root is a redirect here rather than a second copy of
 * the page: two working addresses for one screen is how a preview drifts away
 * from what it is previewing.
 */

import path from 'node:path';
import { isApiPath } from './previewApi.ts';

/** Where bench serves this app's page, and the router's basename in the built bundle. */
export const APP_ROUTE = '/banking';

/** Public base of the built assets, matching the build script's `--base`. */
export const ASSET_BASE = '/assets/erpnext/banking/';

/** Frappe's realtime endpoint. The preview has no realtime backend behind it. */
export const SOCKET_ROUTE = '/socket.io';

/** What the preview owes a request, decided from its path alone. */
export type PreviewRoute =
	/** Not the app's address: send the client to the one that is. */
	| { kind: 'redirect'; location: string }
	/** A backend call, answered by the stubs in `./previewApi.ts`. */
	| { kind: 'api' }
	/** A realtime connection attempt. There is nothing to connect to. */
	| { kind: 'socket' }
	/** A file inside the build output. */
	| { kind: 'asset' }
	/** A client-side route of the app: serve the page and let the router take over. */
	| { kind: 'page' }
	/** Nothing here. */
	| { kind: 'unserved' };

/**
 * True when the last path segment names a file rather than a route.
 *
 * `/banking/statement-importer` is a screen; `/banking/vite.svg` is a file that
 * this server does not have. Both live under the app route, and only the second
 * one must not be answered with the page.
 */
function namesFile(pathname: string): boolean {
	return path.extname(pathname.slice(pathname.lastIndexOf('/') + 1)) !== '';
}

/** True for the app's own client-side routes, i.e. what the page's router can render. */
function isAppRoute(pathname: string): boolean {
	if (pathname !== APP_ROUTE && !pathname.startsWith(`${APP_ROUTE}/`)) {
		return false;
	}
	return !namesFile(pathname);
}

/**
 * Classifies a request path.
 *
 * Order is the contract: the stubbed backend and the realtime endpoint are
 * claimed before anything else, because both live outside the app route and
 * neither may ever be answered with HTML. Assets are matched by their public
 * base rather than by looking at the filesystem, so a missing bundle stays a
 * 404 about a bundle instead of turning into a page.
 */
export function classifyRequest(pathname: string): PreviewRoute {
	if (isApiPath(pathname)) {
		return { kind: 'api' };
	}
	if (pathname === SOCKET_ROUTE || pathname.startsWith(`${SOCKET_ROUTE}/`)) {
		return { kind: 'socket' };
	}
	if (pathname.startsWith(ASSET_BASE)) {
		return { kind: 'asset' };
	}
	if (pathname === '/') {
		return { kind: 'redirect', location: APP_ROUTE };
	}
	if (isAppRoute(pathname)) {
		return { kind: 'page' };
	}
	return { kind: 'unserved' };
}
