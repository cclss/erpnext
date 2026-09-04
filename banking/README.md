# Banking

The Banking frontend: React and TypeScript, built with Vite. A production build
writes to `../erpnext/public/banking` and copies its HTML entry to
`../erpnext/www/banking.html`; bench serves that page at `/banking` and the
build output under `/assets/erpnext/banking/`.

## Routes

`.env.production` sets `VITE_BASE_NAME=banking`, so the built router is mounted
at `/banking` and every screen the app has lives under it.

| Path | What is there |
|---|---|
| `/banking` | the app page, from `../erpnext/www/banking.html`; the router renders bank reconciliation here |
| `/banking/statement-importer` | the statement importer |
| `/banking/statement-importer/<id>` | one import log |
| `/assets/erpnext/banking/*` | this build's output, from `../erpnext/public/banking` (the `--base` the build script passes) |
| `/assets/erpnext/*` | the erpnext app's shared icons and logos the page loads, starting with its favicon |

The screens are client-side routes: the server sends the same page for all of
them and the router renders the screen from the address, so a reload or a shared
link has to arrive at that page rather than at a `404`. The preview server
mirrors these rules; `e2e/README.md` has the table it serves by.

## Requirements

- **Node 24** (Node 22.18 or newer also works). The tooling in this app —
  `vite.config.ts`, `proxyOptions.ts`, the tests, and everything under `e2e/` —
  is TypeScript that Node runs directly, which needs Node's built-in type
  stripping. Older Node cannot run `yarn test` or `yarn test:e2e`.
- **Yarn 1 (classic)**, matching the `yarn.lock` in this directory. Every yarn
  command prints one `DEP0169` deprecation warning before it runs anything.
  It comes from yarn's own bundled CLI, not from this app or its dependencies:
  `yarn node -e "0"` prints it, running `node --test` directly prints none.
  Nothing in this directory can silence it; a newer yarn would.
- Dependencies installed from this directory:

```sh
cd banking
yarn install --frozen-lockfile
```

Nothing else is required. In particular, no bench, no site and no
`sites/common_site_config.json`: that file is a development-only artefact of the
dev server's proxy, and neither the build nor the tests read it.

## Development

```sh
yarn dev     # dev server on :8080
yarn build   # production build, then the HTML entry copy
yarn lint    # ESLint
```

The dev server proxies the backend routes (`/app`, `/api`, `/assets`, `/files`,
`/private`) to the bench web server, using the `webserver_port` in
`sites/common_site_config.json`. That file is read only when serving. If it is
missing or unreadable, the dev server prints one warning naming the cause and
starts **without** a proxy rather than forwarding to a guessed port; set
`VITE_PROXY_PORT` to point it at a backend explicitly.

### Environment variables

The app reads four `VITE_` variables. Only the first is set in this repository —
no script, workflow or bench hook here injects the other three, so each one falls
back to a value the app or its backend already knows.

| Variable | Set by | Unset means |
|---|---|---|
| `VITE_BASE_NAME` | `.env.production` in this directory, so `yarn build` picks it up and `yarn dev` does not | the router mounts at the site root instead of under `/banking` |
| `VITE_SITE_NAME` | nobody; it is a fallback | the site name comes from the boot payload bench renders into the page |
| `VITE_SOCKET_PORT` | nobody; pass it yourself when the bench runs socketio off its default port | the Frappe SDK connects on its own default, port `9000` |
| `VITE_PROXY_PORT` | nobody; pass it yourself to the dev server | the proxy port comes from `webserver_port`, as described above |

The last one is read only when serving. The other three are compiled into the
bundle, so changing one requires a rebuild.

## Tests

Two commands, with different costs. Run the first constantly, the second before
you push.

```sh
yarn test       # unit tests, no build      (~6s)
yarn test:e2e   # SC-1, builds and serves   (~30s)
```

### Unit tests

`yarn test` runs `node --test`, which picks up every `*.test.ts` file: the proxy
configuration, the build configuration, and the report, server and screen
vocabulary under `e2e/`. They touch no network and produce no build output.

### End-to-end: opening the preview

`yarn test:e2e` runs the one scenario this app has, `e2e/previewEntry.scenario.ts`
(SC-1): a preview built **without** `sites/common_site_config.json` opens the
Banking screen instead of a `build_failed` deployment failure screen. It is a
`node:test` file like any other, and it is named `*.scenario.ts` rather than
`*.test.ts` so that `yarn test` stays fast enough to run on every edit.

In one run it:

1. copies this app into a throwaway bench-shaped tree that has no `sites/`
   directory, and runs the real `yarn build` there;
2. serves what that build produced the way bench serves it, filling the HTML
   entry's template placeholders with a signed-in stub and answering every API
   call empty;
3. checks the addresses in the route table above: `/` moves to `/banking`, each
   screen answers a reload with the app page, and every same-origin file the
   page references — the bundles and the shared favicon alike — is served;
4. opens each of those addresses in a process of its own — the served page in an
   in-process DOM, with the built entry module imported into it — and waits for
   each screen to settle;
5. asserts that the application mounted on every one of them, that the
   breadcrumb landmark it rendered carries `Banking`, and that every same-origin
   request each page made was answered rather than refused.

No browser and no browser automation tool is involved. `e2e/README.md` describes
each of the three parts, and how to run the build harness and the preview server
on their own — useful when you want to look at the preview yourself rather than
assert on it.

The run cleans up after itself: the temporary bench tree is removed when the
scenario ends, and this checkout's `../erpnext/public` is never written to. One
exception — if the isolated build fails, the tree is kept so the build log the
report names can be read, and the reported bench root is yours to delete.

### Reading a failure

Every failure is reported as one block, not a stack trace. It carries the
`build_failed` marker — the same word the preview environment shows for a broken
deployment — and names the stage it stopped at:

```
[banking] Isolated preview build failed (build_failed) — <what went wrong>.
[banking]   Stage: build
[banking]   Build log: /tmp/banking-isolated-bench-XXXX/build.log
[banking]   Fix: <what to do about it>
[banking]   Impact: <what is missing while this stands>
```

The stage tells you where to look:

| Stage | It means | Look at |
|---|---|---|
| `prepare` | the throwaway tree could not be built, or the app's build script no longer matches what the harness verifies | the reported build script, and `e2e/isolatedBuild.ts` |
| `install` | dependencies could not be provided to that tree | `yarn install --frozen-lockfile` in this directory |
| `build` | `yarn build` failed there but works here — almost always a new dependency on a bench-only file | the reported build log; grep it for `ENOENT` |
| `verify` | the build succeeded but produced no usable artefacts, or referenced assets it did not emit | the reported output directory |
| `serve` | the artefacts exist but the page could not be served — typically a template placeholder the preview stub does not model | the reported cause, and `e2e/previewBoot.ts` |
| `render` | the page was served but the application did not stay on screen | the report's `Page errors` and `Rendered` items |

A failed assertion instead of a report means the chain got as far as the screen:
the page was served and the assertion says what was missing from it.

## Continuous integration

`.github/workflows/banking-tests.yml` runs exactly the two commands above, in
that order, on every pull request that touches `banking/`, and on pushes to
`develop` and `version-*`. It installs with the committed lockfile and uses the
Node version this README requires, so a green run there means the same two
commands are green on a clean checkout.

## React Compiler

The React Compiler is not enabled in this app because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
