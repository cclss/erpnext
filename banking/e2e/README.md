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
