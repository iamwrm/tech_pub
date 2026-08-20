```text
Design a general-purpose “fork-overlay” repository pattern: an operational fork that does not maintain a formal GitHub fork, submodule, or permanently diverging copy of the upstream source tree.

Use this definition:

A fork-overlay is an operational fork whose durable state consists of pinned upstream versions, ordered downstream patches, supporting assets, documentation, tests, and reconstruction automation—not a persistent copy of upstream source.

The repository should store only the durable downstream delta:

- Exact upstream repository URLs, release references, and immutable commit pins
- Ordered, reviewable patch series
- Documentation explaining why each downstream change exists
- Overlay-owned tests, packaging files, shims, and configuration
- Automation that reconstructs, validates, builds, and releases the customized software

Upstream source trees must remain disposable. They should be cloned into a gitignored `.work/` directory and must never be treated as the source of truth.

Use these design requirements:

1. Use “fork-overlay” as the name of the architectural pattern.

   Use:
   - `fork-overlay` for the overall pattern
   - `overlay.toml` for the manifest
   - `overlay` for the command-line entry point

   Make it clear that “fork” describes the operational behavior, not a GitHub-hosted fork.

2. Do not use YAML for the overlay manifest.

3. Use a single TOML manifest named `overlay.toml` as the authoritative source for:

   - Upstream repository URLs
   - Pinned tags, versions, or release references
   - Expected immutable commits
   - Patch files and their explicit application order
   - Patch ownership
   - Dependencies between patches
   - Relevant upstream issues or pull requests
   - Retirement conditions
   - Build and test commands where appropriate

   Do not duplicate authoritative upstream pins or patch ordering across scripts, documentation, and CI configuration.

4. Provide one command-line entry point named `overlay`.

   It should expose a stable interface such as:

   `./overlay checkout`
   `./overlay verify`
   `./overlay apply`
   `./overlay build`
   `./overlay test`
   `./overlay reconstruct`
   `./overlay refresh <upstream> <new-ref>`
   `./overlay clean`
   `./overlay release`

   Developers and CI must use the same entry point and underlying implementation.

   The top-level `overlay` file may be a small launcher, while the implementation lives under `tools/overlaylib/`.

5. Describe the result as reconstructible, not necessarily reproducible.

   The system must be able to reconstruct the same patched source from:

   - The fork-overlay repository commit
   - The pinned upstream commit
   - The ordered patch series
   - Supporting overlay files
   - Recorded toolchain and dependency information

   Do not claim bit-for-bit reproducibility unless the design explicitly controls timestamps, toolchains, dependencies, environment variables, archives, filesystem ordering, and other nondeterministic inputs.

6. Keep all generated and disposable state under `.work/`:

   `.work/`
   `├── checkouts/`
   `├── build/`
   `├── staging/`
   `└── logs/`

   The entire `.work/` directory must be gitignored and safe to delete at any time.

   No command may depend on undocumented state inside `.work/`.

7. Patch application order must be explicit in `overlay.toml`.

   Do not rely only on lexical filename sorting.

   Patch filenames may still contain numeric prefixes for readability, but the manifest must remain authoritative.

8. Each patch must have a documented lifecycle:

   - Purpose
   - Owner or owning initiative
   - Upstream issue or pull request, when one exists
   - Dependencies on other patches
   - Whether it is temporary or intentionally downstream-specific
   - Evidence or tests that justify it
   - A clear retirement condition

   Small patches should require only a concise change record. Do not require a large design document unless the change genuinely needs one.

9. Release and validation automation must perform a clean reconstruction:

   - Start without an existing upstream checkout
   - Read `overlay.toml`
   - Fetch each pinned upstream reference
   - Verify that the reference resolves to the expected immutable commit
   - Apply patches in the declared order
   - Fail on patch drift, rejected hunks, or ambiguous application
   - Build the resulting source
   - Run upstream tests
   - Run fork-overlay-owned tests
   - Record provenance and artifact hashes

   Official release builds must not depend on a developer’s existing `.work/` directory.

10. Strict patch application should be used for validation and releases.

    Three-way application or manual conflict resolution may be used during an intentional refresh, but official reconstruction must not silently infer or repair patch drift.

11. Record useful reconstruction metadata for releases:

    - Fork-overlay repository URL
    - Fork-overlay repository commit
    - Upstream repository URL
    - Upstream reference
    - Upstream commit
    - Patched Git tree hash
    - Applied patch filenames
    - Patch file hashes
    - Toolchain versions
    - Dependency lockfile hashes
    - Build target
    - Artifact SHA-256 hashes

    Record the patched Git tree hash in addition to any generated patched commit.

    Applying mailbox patches can produce different commit metadata while resulting in identical source trees, so the tree hash is the better identifier for the reconstructed source content.

12. Include a non-blocking upstream canary job.

    It should periodically test whether the patch series still applies to:

    - The newest upstream release
    - An upstream development branch
    - Or another explicitly configured candidate reference

    The canary should provide early warning only.

    It must not:
    - Change the pinned production base
    - Publish official artifacts
    - Automatically rewrite patches
    - Be treated as a release validation result

13. Treat licensing, attribution, and redistribution as first-class concerns:

    - Preserve upstream licenses and notices
    - Document patch authorship
    - Record licenses for added files
    - Explain binary redistribution obligations
    - Include `LICENSES/`, `NOTICE`, or equivalent files when required
    - Keep source-offer or corresponding-source requirements documented where applicable

14. Keep the pattern lightweight.

    Avoid adding process merely for appearance.

    A small patch should generally need:

    - One manifest entry
    - One patch file
    - One focused test or documented verification method
    - One concise change record
    - One retirement condition

    Add architecture decision records or larger design documents only when the change has significant architectural consequences.

15. Explain when a fork-overlay should no longer be used.

    Recommend moving to a conventional fork or long-lived downstream branch when:

    - The downstream project has become an independent product
    - Changes affect a large portion of the upstream source tree
    - Patches are highly interdependent
    - Contributors need normal source-level branch and pull-request workflows
    - Divergence is intended to be permanent
    - Bidirectional merging is frequent
    - Maintaining the patch series costs more than maintaining a downstream branch

Use a repository structure similar to:

project-fork-overlay/
├── README.md
├── overlay.toml
├── overlay
├── LICENSE
├── NOTICE
│
├── patches/
│   ├── upstream-a/
│   │   ├── 0001-feature-a.patch
│   │   └── 0002-feature-b.patch
│   └── upstream-b/
│       └── 0001-integration.patch
│
├── docs/
│   ├── architecture.md
│   ├── maintenance.md
│   ├── release.md
│   ├── redistribution.md
│   ├── decisions/
│   │   └── 0001-use-a-fork-overlay.md
│   └── changes/
│       ├── feature-a.md
│       ├── feature-b.md
│       └── integration.md
│
├── tools/
│   └── overlaylib/
│
├── extras/
│   ├── configuration/
│   ├── packaging/
│   └── runtime/
│
├── tests/
│   ├── smoke/
│   ├── integration/
│   └── overlay/
│
├── LICENSES/
│
├── .github/
│   └── workflows/
│       ├── validate.yml
│       ├── upstream-canary.yml
│       └── release.yml
│
├── .gitignore
└── .work/
    ├── checkouts/
    ├── build/
    ├── staging/
    └── logs/

Produce:

1. A concise, one-paragraph explanation of the fork-overlay pattern
2. A refined repository tree
3. A complete example `overlay.toml`
4. The command contract for the `overlay` entry point
5. The clean reconstruction workflow
6. Validation and release invariants
7. Patch lifecycle conventions
8. Release provenance requirements
9. Licensing and redistribution considerations
10. A brief explanation of when this pattern should be replaced by a conventional fork or long-lived downstream branch

Keep the design generic and applicable to one or many upstream projects.

Do not reference any specific existing repository, organization, product, or programming language.

Do not use YAML.
```
