# pi-poteto-mode

Private, path-installed Pi skill package derived from Lauren Tan's
[pstack](https://github.com/cursor/plugins/tree/main/pstack). It keeps a pinned,
unmodified upstream snapshot in `vendor/pstack/` and exposes a filtered,
Pi-compatible tree from `skills/`.

Lifecycle and design: [`IV-0028`](../../docs/IV-DC/IV-0028-pi-poteto-mode.md).
Attribution and the upstream MIT license are in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

## Install

```bash
pi install ./packages/pi-poteto-mode
```

No package dependencies are needed at runtime. `npm ci` installs only the
development dependency used by the validation suite.

Start a new Pi session or run `/reload`, then verify the package with `pi list`.
Invoke the entry point explicitly:

```text
/skill:poteto-mode <task>
```

The entry skill is intentionally `disable-model-invocation: true`; it does not
become a sticky global mode merely because the package is installed.

Remove the package registration with:

```bash
pi remove ./packages/pi-poteto-mode
```

## Default profile

`sync-policy.json` owns the committed `pi-default` inventory. It currently
loads 27 skills:

- the 21 upstream principle skills;
- `bro`, `tdd`, `technical-writing`, `typescript-best-practices`, and `unslop`;
- a Pi-specific `poteto-mode` override.

The remaining upstream skills stay available for review in `vendor/pstack/`
but are not discoverable by Pi. They depend on combinations of Cursor model
rules, cloud agents, custom agents, MCP assumptions, companion plugins, or
workflows that have not yet been ported. Filtering them is fail-closed behavior,
not a claim that those upstream skills are defective.

## Per-installation filtering

Pi can disable this complete package without changing the checkout:

```json
{
  "packages": [
    {
      "source": "./packages/pi-poteto-mode",
      "skills": []
    }
  ]
}
```

Individual generated skills can be excluded through normal Pi package filters
or `pi config`. These settings affect one installation; they do not change the
committed distribution.

## Synchronizing upstream

Normal synchronization fetches the commit pinned in `UPSTREAM.lock.json`:

```bash
npm run sync:upstream
```

Adopt a reviewed upstream commit explicitly:

```bash
npm run sync:upstream -- --ref <commit>
```

The synchronizer sparse-fetches only `pstack/`, stages the complete snapshot,
generates the selected skill tree, applies `compat/overrides/`, validates it,
and replaces the committed trees only after every gate passes. The lock records
the upstream version, commit, selected inventory, exclusions, and SHA-256 tree
hashes.

Use a local clean checkout while developing or reviewing an update:

```bash
npm run sync:upstream -- --source /path/to/cursor-plugins --ref <commit>
```

Check committed output without network access:

```bash
npm run sync:check
```

### Previewing and saving filters

Preview a one-off skill exclusion without writing files:

```bash
REF=$(node -p "require('./UPSTREAM.lock.json').commit")
npm run sync:upstream -- \
  --source vendor/pstack \
  --ref "$REF" \
  --exclude-skill bro \
  --dry-run
```

Preview a capability filter:

```bash
REF=$(node -p "require('./UPSTREAM.lock.json').commit")
npm run sync:upstream -- \
  --source vendor/pstack \
  --ref "$REF" \
  --exclude-capability cursor-cloud-agent \
  --dry-run
```

Persist selection changes with `--save-policy`. The command updates
`sync-policy.json`, regenerates the tree, and records the effective selection in
the lock:

```bash
npm run sync:upstream -- \
  --source /path/to/cursor-plugins \
  --ref <commit> \
  --exclude-skill <name> \
  --save-policy
```

Selection flags without `--dry-run` or `--save-policy` fail. This prevents a
committed tree that cannot be reproduced from policy.

`compat/capabilities.json` classifies known harness dependencies.
`compat/dependencies.json` prevents an included skill from silently losing a
required selected skill. A semantic port should use a complete file override in
`compat/overrides/<skill>/`; broad textual rewrites are deliberately avoided.

## Updating safely

1. Read the upstream pstack changelog and diff from the locked commit.
2. Run a local `--dry-run` against the candidate commit.
3. Review new, removed, and renamed skills and capability assumptions.
4. Update explicit compatibility overrides when upstream semantics changed.
5. Update `THIRD_PARTY_NOTICES.md` to the reviewed commit and plugin version;
   non-preview synchronization fails while attribution is stale.
6. Run the real synchronization.
7. Inspect `vendor/pstack/`, `skills/`, and `UPSTREAM.lock.json`.
8. Run all gates below.

A patch or override that no longer applies cleanly is a review event. Do not
silently drop it or expose an incompatible upstream workflow.

## Validation

```bash
cd packages/pi-poteto-mode
npm ci
npm test
npm pack --dry-run
```

`npm test` verifies the generated inventory, frontmatter, relative links,
unsupported harness markers, declared dependencies, tree hashes, deterministic
offline regeneration, non-mutating dry-run filters, and discovery through Pi's
actual `loadSkillsFromDir` implementation.

This proves package mechanics. It does not prove that every model will discover
or apply each skill correctly. Changes to skill descriptions or guidance also
require the model-facing judgment methodology in
[`DC-0004`](../../docs/IV-DC/DC-0004-meta-prompt.md).
