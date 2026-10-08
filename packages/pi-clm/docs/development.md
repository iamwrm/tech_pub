# Development

Node 22+ and pnpm through corepack. The Pi packages are peer dependencies, provided by
the Pi installation that loads the extension; the dev dependencies pin one version for
typechecking and tests.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check      # strict typecheck + tests
```

## Running a checkout in Pi

For one session:

```sh
pi -e /path/to/pi-clm/index.ts
```

Or install the checkout in place, so edits apply on the next `/reload`:

```sh
pi install /path/to/pi-clm
```

Do not load pi-clm together with the original live-context extension; they share
session entry types.

## Releasing

1. Set `version` in `package.json` and merge to `main`.
2. Tag and push the tag:

   ```sh
   git tag v1.0.0 && git push origin v1.0.0
   ```

3. The `release` workflow runs the typecheck and tests, refuses a tag that does not match
   `package.json`, and publishes to npm. It needs the repository secret `NPM_TOKEN`, an
   npm token allowed to publish `@lolipopshock/pi-clm`.

Users then install with `pi install npm:@lolipopshock/pi-clm`; the tarball is the TypeScript sources
(Pi loads them directly), the bundled steering brief and the docs.
