# Isolated preview build harness

Verifies that this app builds the way a preview deployment builds it: from a
bench-shaped tree that has **no** `sites/common_site_config.json`. That file is
a bench development artefact; a production build that reaches for it fails, and
the preview then shows a deployment failure screen (`build_failed`) instead of
the Banking app.

```sh
yarn e2e:isolated-build            # reuse this checkout's node_modules (fast)
yarn e2e:isolated-build --install  # install dependencies inside the tree
yarn e2e:isolated-build --json     # artefact paths on stdout, report on stderr
```

## What it does

1. Copies the app into `{tmp}/apps/erpnext/banking`, the depth a bench checkout
   has, copies the erpnext app's `public/` tree beside it — the shared icons and
   logos the page and the app load by absolute path — and creates the
   `erpnext/www` directory the HTML entry is copied into. The build's own output
   directory is excluded from that copy, so a previous build's files can never
   stand in for this one's. `sites/` is never created, and its absence is
   asserted before and after the build.
2. Provides dependencies — by symlinking this checkout's `node_modules`, or by
   installing a fresh set with `--install`.
3. Runs the app's own `yarn build` (`vite build --base=/assets/erpnext/banking/`
   followed by the HTML entry copy) in that tree.
4. Checks the deployable artefacts: a non-empty `index.html`, the copied
   `banking.html`, and every asset the HTML references under the public base.

Exit code `0` prints the artefact paths. Any failure prints one `build_failed`
report naming the stage, the cause, the build log, and what to do, then exits
non-zero.

The temporary tree is kept on purpose — the reported paths point into it, so the
artefacts can be served or inspected. Remove the reported bench root when done.

---

# Preview server

Serves what that build produced, the way bench serves it, so the Banking screen
can actually be opened without a Frappe backend.

```sh
node e2e/isolatedBuild.ts --json > report.json
yarn e2e:preview-server --artifacts report.json          # or: --out-dir <dir> --web-entry <file> [--shared-assets <dir>]
yarn e2e:preview-server --artifacts report.json --port 5173 --host 0.0.0.0
```

`--artifacts` takes the report `yarn e2e:isolated-build --json` prints, so
neither half repeats the other's paths (yarn's own banner around the JSON is
ignored).

## What it serves

| Route | Response |
|---|---|
| `/` | `302` to `/banking`, the address the built router is mounted at |
| `/banking`, `/banking/statement-importer`, `/banking/statement-importer/<id>` | the HTML entry, rendered; the router renders the screen from the address |
| `/banking/<name>.<ext>` | `404` — a path that names a file is never answered with the page |
| `/banking/statement-importer/BSI.2026.1` | the page — dots in a document name are not a file extension |
| `/assets/erpnext/banking/*` | the built bundles, from the output directory |
| `/assets/erpnext/*` | the shared icons and logos, from the copied `erpnext/public` |
| `/api/*` | an empty payload in the envelope the API client expects |
| `/socket.io` | `501` in plain text — there is no realtime backend to reach |
| anything else | `404` |

Everything under `/banking` that is not a file name is served the same page: the
router is a client-side one, so a reload or a shared link has to arrive at the
page rather than at a `404`. What counts as a file name is the *shape* of the
extension — a short alphanumeric word starting with a letter, like `.js` or
`.woff2` — because Frappe's naming series put dots inside document names, and
reading the `.1` of `BSI.2026.1` as a file type loses the screen behind a shared
link. The addresses in the table are the built app's own —
`.env.production` sets `VITE_BASE_NAME=banking` — which is why the site root
moves instead of serving a second copy of the page.

Each rule has its own directory and its own refusal, so a wrong path stays a
question about the thing that was asked for: a missing bundle is a `404` about a
bundle, a missing icon a `404` about an icon, and neither is ever answered with
the page. Paths that try to leave their directory get a `403`. Pages and assets
answer `GET` and `HEAD` only, and anything else is a `405`; the API stub answers
`POST` too, because the app's report and search calls are POSTs.

In a bench, `erpnext/www/banking.html` is a Jinja template — the web server
fills `boot`, `csrf_token`, `lang`, `layout_direction`, `app_name` and `favicon`
before the browser sees it. The preview has no such server, so it fills those
placeholders itself with a signed-in boot stub (`previewBoot.ts`) and answers
every API call empty (`previewApi.ts`). That is the least that lets the
production entry path run: the page renders the app rather than
`JSON.parse({{ boot }})` throwing, and the app's login gate sees a session
cookie instead of redirecting to `/login`.

It is not a backend. No screen shows real data, and nothing here is fabricated
into looking like data — every list is empty, every count is zero.

A page that cannot be rendered — a missing entry, a placeholder the stub does
not model — is reported as one `build_failed` block and exits non-zero, the same
way the build harness reports.

---

# SC-1 — opening the preview

The two halves above are means, not the end. What the story claims is that a
preview built without `sites/common_site_config.json` **opens the Banking
screen** — so the scenario builds, serves, opens the served page, and looks at
what the application rendered.

```sh
yarn test:e2e
```

There is no separate runner configuration: the scenario is a `node:test` file,
and the flags it needs live in the `test:e2e` script. It is named
`previewEntry.scenario.ts` rather than `*.test.ts` on purpose — it costs a
production build, and `yarn test` has to stay fast enough to run on every edit.

## What it asserts

| Step | Assertion |
|---|---|
| Build in a tree with no site config | the harness exits `0`; a failure is reported as `build_failed` and ends the run |
| `GET /banking` | `200`, no leftover template placeholders, and not the `build_failed` screen |
| `GET /` | `302` to `/banking`, and following it lands on that same page |
| `GET /banking/statement-importer` and `/banking/statement-importer/BSI.2026.1` | `200` and byte-identical to the page above — reloading a deep screen is not a `404` |
| Every same-origin file the page references | `200` and non-empty, the built bundles and the shared icon alike; the served entry module is byte-identical to the built one |
| Open each of the three addresses | the address answers with the page rather than a Not Found or a `build_failed` screen, the application mounts on it, and its breadcrumb landmark reads `Banking` |
| What each page then asks for | it asks for something, and every same-origin request it makes is answered — a `404`, a refusal or an error the page logs fails the run |

The icon is checked because the entry template writes its default with a leading
space inside the quotes (`{{ favicon or ' /assets/... ' }}`). A browser trims
that before it requests the file, so the scenario trims it too — untrimmed, the
one reference most likely to be missing would be the one never checked.

## Opening the page without a browser

A page is opened by `renderPage.ts`: it fetches one address, turns the served
HTML into a DOM, imports the built entry module into it, and reports what the
application rendered. No browser is launched and no browser automation tool is
installed — the production bundle is an ES module, so Node can execute it once
it has a DOM to render into. What that buys is a check that fails for the same
reasons a browser would: a bundle that throws on load, a page that mounts
nothing, a screen that renders and then disappears.

```sh
node e2e/renderPage.ts --url http://127.0.0.1:4173/banking/statement-importer/BSI.2026.1 \
  --module <outDir>/assets/index-<hash>.js        # add --json for the observation itself
```

**One process opens one page.** Node keeps a single instance of a module per
URL, so importing the bundle a second time hands back the page that already ran
and mounts nothing; importing it under a distinct URL is worse, because the
entry chunk's modules then exist twice while the lazily loaded chunks still
import the first copy and react-router's context stops matching across the two.
So the scenario opens each of its three addresses in a process of its own, and
the observation comes back as JSON — plain data, judged by the same functions on
both sides.

Two consequences worth knowing:

- **The screen has to survive, not just appear.** The application renders before
  its data arrives, so the scenario waits after the first render and reports the
  settled screen. A page that flashes and blanks fails, and the report quotes
  the error that took it down.
- **Layout is not evaluated.** Nothing here checks pixels, sizes or what a
  viewport would hide; the assertion is that the application is on the page, in
  the DOM the accessibility tree reads.
- **What the page asks for is watched, not only what it draws.** The page's
  `fetch` is the shim this harness installs, so every same-origin request and the
  status it came back with is recorded on the way through — the lazily loaded
  chunks the router pulls in, and the backend calls the app makes on mount. The
  bundle is imported from disk, so the addresses it derives from
  `import.meta.url` are `file:` ones; the shim puts the preview's origin back on
  every chunk address, which is both what a browser would have asked for and the
  only way the preview is ever asked for those chunks at all. A
  request the preview refuses leaves no mark in the DOM: the application renders
  its empty state around a `404` exactly as it renders it around real emptiness,
  and a check that only reads the DOM passes on a preview serving half of what
  the page needs.

A failure is reported in the same shape as the rest of the harness — stage,
cause, page errors, what was rendered instead, the fix, and the impact.
