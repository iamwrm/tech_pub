

[prompts.md](prompts.md)

## Pi extensions and scripts

- [pi-clm](packages/pi-clm/README.md), vendored upstream 1.0.0 with stable
  continuity-note placement and hash-only cache diagnostics. Local version
  `1.0.0-ren.3`, requires Pi >=1.0.4. Install with
  `pi install ./packages/pi-clm`. Replace any upstream CLM registration rather
  than loading both copies. `private: true` prevents npm publication; this is
  a path-installed source mirror.
- [USD per MTok report](scripts/README.md), ccusage report formatting with
  prompt-cache hit rates and installed Pi catalog pricing.

The CLM source README retains references to the originating private repository's
lifecycle records. Its full SDK test suite also requires a sibling
`pi-openai-server-compaction` checkout at version >=0.3.7. The older mirror here
is not sufficient for those integration tests. The CLM extension itself does
not require that sibling package.
