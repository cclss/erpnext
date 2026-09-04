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
   has, and creates the `erpnext/public` and `erpnext/www` directories the build
   writes into. `sites/` is never created, and its absence is asserted before
   and after the build.
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
yarn e2e:preview-server --artifacts report.json          # or: --out-dir <dir> --web-entry <file>
yarn e2e:preview-server --artifacts report.json --port 5173 --host 0.0.0.0
```

`--artifacts` takes the report `yarn e2e:isolated-build --json` prints, so
neither half repeats the other's paths (yarn's own banner around the JSON is
ignored).

## What it serves

| Route | Response |
|---|---|
| `/banking`, `/`, other extensionless paths | the HTML entry, rendered |
| `/assets/erpnext/banking/*` | the built bundles, from the output directory |
| `/api/*` | an empty payload in the envelope the API client expects |
| anything else | `404` |

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
| Every asset the page loads | `200` and non-empty, and the served entry module is byte-identical to the built one |
| Open the page | the application mounts, and its breadcrumb landmark reads `Banking` |

## Opening the page without a browser

The page is opened in this process: the served HTML becomes a DOM, the built
entry module is imported into it, and the application runs. No browser is
launched and no browser automation tool is installed — the production bundle is
an ES module, so Node can execute it once it has a DOM to render into. What that
buys is a check that fails for the same reasons a browser would: a bundle that
throws on load, a page that mounts nothing, a screen that renders and then
disappears.

Two consequences worth knowing:

- **The screen has to survive, not just appear.** The application renders before
  its data arrives, so the scenario waits after the first render and reports the
  settled screen. A page that flashes and blanks fails, and the report quotes
  the error that took it down.
- **Layout is not evaluated.** Nothing here checks pixels, sizes or what a
  viewport would hide; the assertion is that the application is on the page, in
  the DOM the accessibility tree reads.

A failure is reported in the same shape as the rest of the harness — stage,
cause, page errors, what was rendered instead, the fix, and the impact.
