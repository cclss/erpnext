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
