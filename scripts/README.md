# Usage reports

`show_usd_per_mtok.sh` reads a ccusage report and prints per-period, per-model
tokens, USD, cache hit rate, blended $/MTok, catalog input price and their ratio.
It accepts JSON or rendered tables. JSON preserves exact values and model names.

Keep `pi_input_prices.mjs` and `usd_per_mtok_render.mjs` beside the shell script.
Requires Bash, Node.js and an installed Pi CLI. JSON input also requires `jq`.

From this repository's root:

```sh
npx ccusage@latest --last 2 -b -j | scripts/show_usd_per_mtok.sh
scripts/show_usd_per_mtok.sh --help
```

With terminal stdin, running the script without a pipe invokes ccusage itself.
Terminal output uses colored zebra rows; piped output is plain text.
`USD_MTOK_THEME=light|dark` selects a theme. `NO_COLOR=1` or
`USD_MTOK_STYLE=plain` disables styling. `MIN_USD=1` collapses each period's
rows costing under $1 into one `+N Models` row (totals unchanged).

Run the offline tests:

```sh
node --test scripts/tests/show-usd-per-mtok.test.mjs
```

The scripts and tests are copied from `iamwrm/piagent-config/scripts`.

`update-last-sync.mjs --check` validates package mirror stamps. Without
`--check`, it rewrites every package's stamp.
