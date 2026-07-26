<!-- Suggested filename: DC-agent-discoverable-performance-safe-hft-cpp.md -->

---
kind: DC
id: dc-agent-discoverable-performance-safe-hft-cpp
title: Agent-Discoverable and Performance-Safe HFT C++
status: active
revision: 1
---

# DC: Agent-Discoverable and Performance-Safe HFT C++

## Purpose

This doctrine guides the organization, naming, documentation, implementation,
and verification of latency-sensitive C++ so that humans and coding agents can
locate the correct behavior, understand its constraints, change it safely, and
produce reproducible evidence.

The repository should be readable through ordinary text and filename search,
constrained by the C++ type system and compiler, and protected by correctness
and performance verification loops.

Discoverability must not compromise latency, throughput, determinism, binary
layout, protocol compatibility, or operational safety.

This is engineering doctrine, not a deterministic policy engine. Apply it with
knowledge of the relevant initiative, runtime architecture, and measured
trade-offs.

## Doctrine statement

Make every important concept:

1. easy to locate by text search;
2. understandable at its canonical definition;
3. difficult to misuse through types and interfaces;
4. connected to its intent, consumers, and evidence;
5. safe to change through reproducible correctness and performance checks.

Names are search addresses. Types are executable documentation. Definitions
are attention landing points. IVs preserve lifecycle intent. Verification
determines whether a change is acceptable.

## Evidence basis and limits

This doctrine is informed by:

- [How coding agents read your code (and how to write for them)](https://modem.dev/blog/how-coding-agents-read-your-code),
  which describes how coding agents commonly navigate repositories through
  string search and filename search;
- the repository RFC `IV/DC Agentic Workspace`, which defines Markdown as the
  durable memory and attention map for humans and agents.

The external article reports that more discoverable names, types, filenames,
and module boundaries reduced retrieval effort and improved some review
outcomes in scoped TypeScript and Python experiments.

Those experiments are illustrative rather than definitive. They do not
establish C++ compilation, runtime, or HFT latency results. Treat their
conclusions as navigation and reasoning hypotheses that must be validated
against this repository.

Do not cite external token-reduction results as evidence that a local
refactoring is beneficial. Record repository-specific evidence.

## Applicability

This doctrine applies to:

- production C++ source and headers;
- public and cross-component interfaces;
- market-data, execution, risk, strategy, persistence, telemetry, and
  infrastructure components;
- tests, simulators, replay tools, benchmarks, and build targets;
- generated-code boundaries;
- IVs, child documents, DCs, and agent instructions;
- feature migration and retirement.

The strongest application is expected at semantic and lifecycle boundaries:

- protocol messages and decoders;
- order-book mutations;
- order-state transitions;
- pre-trade and post-trade risk decisions;
- sequence and recovery behavior;
- clock and timestamp conversions;
- queue ownership and concurrency boundaries;
- serialization and wire layouts;
- allocator and object-pool boundaries;
- cross-thread and cross-process communication.

This doctrine does not require:

- verbose names for every local variable;
- splitting files solely because they are long;
- introducing runtime indirection to improve documentation;
- replacing established low-level idioms without measured benefit;
- duplicating initiative-specific context across multiple documents;
- broad cosmetic rewrites unrelated to the active initiative.

## 1. Design names as search addresses

Coding agents frequently begin with `rg`, `grep`, or filename search. A
distinctive symbol or path can act as a portable reverse index even when no
language server or dependency graph is available.

Important names should identify both the action and the domain concept.

Prefer:

```cpp
applyNasdaqItchOrderBookDelta()
publishNormalizedTopOfBook()
evaluatePreTradeRiskLimit()
recoverMarketDataSequenceGap()
convertExchangeTimestampToTsc()
```

Avoid generic cross-component names such as:

```cpp
process()
update()
handle()
run()
init()
execute()
Manager
Context
Data
Result
Config
```

Generic words may remain appropriate when their scope supplies enough
unambiguous context, especially for local variables and private implementation
details. The goal is not maximum name length. The goal is a stable search term
that produces a small and relevant result set.

### Naming guidance

- Include a domain term in exported, public, virtual, callback, and
  cross-component symbols.
- Use one canonical spelling for each concept.
- Avoid unnecessary synonyms such as `instrumentId`, `securityId`, and
  `symbolId` for the same identifier.
- Search the repository before introducing a new exported name.
- Treat namespaces, class names, filenames, and directory names as part of the
  semantic address.
- Remember that method call sites may contain only the method name. A qualified
  definition does not make a generic method call uniquely searchable.
- Keep the same terminology across IVs, code, tests, metrics, logs, dashboards,
  and operational procedures.
- Name test and benchmark files after the source concept they cover.
- Preserve recognizable domain language used by exchanges, protocols, and
  operational teams unless the initiative intentionally changes that language.

Two or three meaningful semantic tokens often provide a useful address, but
repository-wide uniqueness and domain qualification matter more than word
count.

## 2. Use repository paths as an attention index

File and directory names are searchable before their contents are read. Paths
should expose the concepts that live beneath them.

Prefer concept-named paths:

```text
market_data/
  nasdaq_itch_decoder.hpp
  nasdaq_itch_sequence_tracker.hpp
  nasdaq_itch_gap_recovery.cpp
  order_book_delta_applier.hpp
  normalized_top_of_book_publisher.cpp

execution/
  ouch_order_entry_session.cpp
  order_ack_state_transition.hpp
  exchange_reject_mapper.cpp

time/
  tsc_clock_calibration.hpp
  exchange_timestamp_conversion.cpp
```

Avoid accumulating unrelated behavior in paths such as:

```text
common.hpp
utils.hpp
helpers.cpp
manager.cpp
engine.cpp
misc/
```

### Cognitive locality

Split a file or module when:

- it contains independently searchable concepts;
- tasks commonly require reading one concept without the others;
- different initiatives own or change different parts;
- a natural filename can describe the extracted behavior;
- the split reduces irrelevant context without obscuring runtime behavior.

Keep or merge code when:

- the pieces are almost always read, reviewed, tested, or changed together;
- separation would fragment one state transition or invariant;
- the split would impair inlining, compile-time reasoning, generated layout, or
  operational understanding;
- separate names would create false boundaries around one coherent mechanism.

Do not use line count as the primary splitting rule. Split by semantic and
domain locality.

Source-file organization is not permission to change runtime architecture.
Preserve the intended instruction path, data layout, cache behavior, and
link-time optimization strategy.

## 3. Make the type system explain and constrain the domain

A precise type signature can answer a reader's first questions without opening
the implementation. Compiler errors create a concrete correction loop and
provide additional names for repository search.

Avoid primitive soup where distinct concepts share the same representation.

Prefer lightweight domain types:

```cpp
struct FeedSequence {
    std::uint64_t value;
};

struct PriceTicks {
    std::int64_t value;
};

struct QuantityLots {
    std::uint32_t value;
};

struct TscCycles {
    std::uint64_t value;
};

struct ExchangeTimestampNs {
    std::uint64_t value;
};

enum class OrderSide : std::uint8_t {
    Buy,
    Sell,
};
```

These types can prevent accidental substitution between:

- order identifiers and feed sequences;
- prices and quantities;
- nanoseconds and TSC cycles;
- exchange time, monotonic time, and wall-clock time;
- instrument identifiers and venue-specific identifiers;
- protocol states and internal states.

### Type guidance

- Give identifiers, units, clock domains, sequence numbers, states, and handles
  distinct types when accidental substitution is a meaningful risk.
- Prefer `enum class` over unscoped integral state values.
- Avoid multiple unexplained `bool` parameters.
- Use return types that expose meaningful outcomes rather than encoding several
  states in magic integers.
- Use `[[nodiscard]]`, `noexcept`, `const`, ownership types, spans, and other
  language mechanisms when they truthfully express the contract.
- Give domain types distinctive names. `OrderSubmissionResult` is a better
  search address than `Result`.
- Do not add type wrappers solely for appearance. They should improve
  correctness, discoverability, or both.

For latency-sensitive and wire-visible types, verify the zero-cost assumption:

```cpp
static_assert(std::is_trivially_copyable_v<PriceTicks>);
static_assert(sizeof(PriceTicks) == sizeof(std::int64_t));
static_assert(alignof(PriceTicks) == alignof(std::int64_t));
```

Also verify, where applicable:

- ABI compatibility;
- wire representation;
- aggregate initialization behavior;
- generated assembly;
- vectorization and inlining;
- serialization cost;
- object layout and padding;
- benchmark results.

A strong type is not automatically free merely because it is intended to be a
zero-cost abstraction.

## 4. Put non-obvious truth at the canonical definition

Search usually lands on a definition. Put the most important local explanation
where the search lands.

A definition-local comment should explain what the code cannot safely express
by itself:

```cpp
/// Hot path: performs no allocation, locking, syscall, logging, or exception
/// propagation. The caller must provide a contiguous ITCH sequence. Sequence
/// gaps are handled by NasdaqItchGapRecovery before this function is called.
[[nodiscard]] BookUpdateResult applyNasdaqItchOrderBookDelta(
    FeedSequence sequence,
    PriceTicks price,
    QuantityLots quantity) noexcept;
```

Document relevant constraints such as:

- hot-path or cold-path classification;
- thread ownership;
- SPSC, MPSC, or other concurrency assumptions;
- memory-ordering rationale;
- cache-line ownership and false-sharing constraints;
- object and buffer lifetime;
- allocation and lock restrictions;
- syscall, logging, and telemetry restrictions;
- clock domain and time unit;
- sequence continuity and recovery preconditions;
- protocol-version assumptions;
- wire-layout or alignment requirements;
- error-handling and failure-mode expectations;
- behavior owned by another component;
- behavior intentionally not implemented.

Comments should explain invariants, rationale, ownership, and negative
capabilities. Do not restate the implementation line by line.

When the explanation exceeds a cognitively local comment, add an annotated link
to the relevant IV child document or evidence record. Keep the shortest useful
truth at the definition and the detailed reasoning in Markdown.

A stale comment is worse than an absent comment. Update or remove comments when
the contract changes.

## 5. Record intentional absence

Text search can locate behavior that exists. It cannot reliably prove that
behavior is absent.

When the system deliberately does not perform an action that a reader might
reasonably expect, record the absence at the location where that reader will
search.

Examples include:

- a feed handler intentionally does not recover gaps locally;
- a decoder intentionally does not validate a checksum guaranteed by a prior
  layer;
- a hot path intentionally does not log rejects;
- a timestamp conversion intentionally does not consult wall-clock time;
- a risk component intentionally does not persist its transient counters;
- a strategy intentionally ignores a protocol field.

State:

1. that the behavior is absent;
2. why it is absent;
3. which component owns the behavior, if any;
4. what evidence verifies the intended system-level result.

Do not force agents to infer intentional absence from a failed repository
search.

## 6. Preserve semantic handles through C++ indirection

Templates, macros, overloaded operators, ADL, type aliases, CRTP, generated
code, and generic callbacks can hide domain behavior from text search.

Do not ban these mechanisms. Preserve a stable semantic entry point around
important behavior.

Prefer:

```cpp
book.applyNasdaqItchOrderBookDelta(message);
```

over an important state transition exposed only as:

```cpp
book(message);
```

When critical behavior uses generic machinery:

- provide a domain-named façade or wrapper;
- ensure the semantic name appears in the definition, call sites, tests, and
  relevant documents;
- document the source of generated behavior;
- identify the generator rather than asking agents to edit generated output;
- avoid long alias chains that erase domain meaning;
- keep compile commands and semantic tooling configuration available, but do
  not assume every agent will use an LSP.

Do not introduce virtual dispatch, heap allocation, additional branches,
runtime registries, or indirect ownership merely to create more visible
software architecture. Improve searchability through names, paths, types,
compile-time structure, and documentation before changing the runtime model.

## 7. Integrate code with the IV/DC workspace

Markdown is the durable memory and attention map. Code is the executable
system. They must remain mutually consistent.

### Initiative responsibility

The root IV owns:

- the user or business need;
- requirements and non-goals;
- relevant external knowledge;
- important assumptions and decisions;
- implementation locations;
- known consumers;
- correctness and performance evidence;
- reproduction methods;
- lifecycle and retirement justification.

Split child documents by cognitive locality when one IV becomes too large for a
coherent working context. Every child links back to the root IV.

### Doctrine responsibility

This DC owns horizontal guidance for agent-discoverable and performance-safe
C++. It must not absorb initiative-specific requirements.

Initiatives consuming this doctrine should link to it rather than copy it.

### Agent entry point

The repository agent instructions should direct agents to:

1. find the relevant root IV;
2. follow only task-relevant child links;
3. read applicable DCs;
4. inspect linked implementation and evidence;
5. search for additional consumers and dynamic dependencies;
6. run the documented verification loops.

Use annotated links that explain when and why the target should be read.

## 8. Agent change workflow

### Before changing the repository

1. Locate and read the relevant root IV.
2. Follow only child links relevant to the requested behavior.
3. Read this DC and any additional applicable doctrines.
4. Extract the initiative's intended outcome, non-goals, invariants, and
   acceptance evidence.
5. Derive likely search terms from the task language and canonical repository
   terminology.
6. Search filenames, definitions, call sites, tests, benchmarks, build targets,
   configuration, and documents.
7. Search for aliases, legacy names, generated forms, and dynamic consumers.
8. Identify hot-path boundaries, thread ownership, data-layout constraints, and
   protocol compatibility requirements.
9. Locate the strongest existing reproduction procedures.
10. Establish a baseline before changing behavior or performance-sensitive
    structure.

Do not assume that links enumerate every consumer. Use links as attention routes
and repository search as a second discovery mechanism.

### While changing the repository

1. Preserve the terminology established by the root IV.
2. Give new cross-component concepts distinctive names.
3. Keep code, IVs, child documents, tests, benchmarks, and evidence consistent.
4. Put non-obvious constraints at canonical definitions.
5. Add or refine types when they create enforceable domain boundaries.
6. Preserve hot-path runtime properties unless the IV explicitly changes them.
7. Avoid unrelated renames or broad cleanup that expands review scope.
8. Return to the root IV after significant discoveries to prevent
   interpretation drift.
9. Update reproduction procedures when commands, fixtures, tools, or
   environments change.
10. Record newly discovered consumers, assumptions, and negative capabilities.

### After changing the repository

1. Search for the old symbol, old path, deprecated alias, and obsolete
   terminology.
2. Confirm that definitions, call sites, tests, benchmarks, and documents use
   the intended canonical concept.
3. Run the strongest practical correctness verification.
4. Run performance verification appropriate to the affected execution path.
5. Inspect assembly, object layout, or performance counters when the change can
   affect generated code or memory behavior.
6. Update evidence with the observed result, reproduction method, and
   environment assumptions.
7. Re-read the root IV and confirm that the final change still satisfies the
   intended outcome and non-goals.
8. Remove stale links, comments, and evidence claims.
9. Record a logical revision only when the doctrine or initiative changed
   semantically.

## 9. Verification loops

A successful compilation is necessary but not sufficient for latency-sensitive
C++.

Choose verification strength based on the risk and reach of the change.

### Discoverability verification

Use repository search to confirm that an important concept has a usable textual
address:

```sh
rg -n -w '<canonical-symbol>' .
rg --files | rg -i '<domain-term>|<concept-term>'
rg -n '<old-symbol>|<old-path>|<deprecated-alias>' .
```

A healthy search route should lead to:

- the canonical definition;
- meaningful call sites;
- corresponding tests;
- relevant IV or DC context;
- applicable benchmark or reproduction evidence.

Investigate when a search produces:

- many unrelated matches;
- multiple conflicting definitions;
- unexplained synonyms;
- legacy code without a replacement marker;
- only generated output and no source-of-truth location;
- no result for an expected responsibility.

Do not optimize for an arbitrary match-count threshold. Optimize for a small,
relevant, and interpretable result set.

### Correctness verification

Depending on the affected component, use:

- compiler and warning checks;
- unit tests;
- protocol golden vectors;
- state-machine tests;
- deterministic market-data replay;
- deterministic exchange or strategy simulation;
- integration tests;
- property-based tests;
- fuzzing;
- sanitizer builds;
- static analysis;
- failover and recovery procedures;
- risk-invariant checks.

Record the canonical commands in the relevant IV or repository agent
instructions rather than inventing commands during each change.

### Performance verification

For changes that can affect latency, throughput, jitter, cache behavior,
allocation, synchronization, or generated code, consider:

- representative microbenchmarks;
- end-to-end replay benchmarks;
- p50, p99, and relevant extreme-tail latency;
- throughput and queue depth;
- allocation counts;
- lock and syscall counts;
- branch, cache, and TLB counters;
- generated assembly;
- inlining and vectorization reports;
- object size, alignment, and padding;
- binary size and instruction-cache effects.

A performance comparison should record enough environment detail to reproduce
the result, including as applicable:

- CPU and hardware topology;
- CPU pinning and isolation;
- NUMA placement;
- SMT configuration;
- frequency and power-management assumptions;
- operating system and kernel;
- compiler and linker versions;
- build type and flags;
- LTO, PGO, and sanitizer state;
- input data and replay fixture;
- warm-up procedure;
- sample count and statistical summary.

Do not treat an uncontrolled workstation benchmark as authoritative evidence for
a production latency claim.

### Negative verification

When verifying that behavior does not occur:

1. search for direct implementations;
2. search for aliases, macros, generated code, callbacks, configuration, and
   dynamic registration;
3. inspect linked consumers;
4. run an observable system-level reproduction where practical;
5. record the intentional absence near the expected definition or ownership
   boundary.

Repository search alone is not proof of absence.

## 10. Evidence recording

Record important evidence near the claim it supports.

Use a structure similar to:

```markdown
### Evidence: <claim>

- Observed result:
- Reproduction command or procedure:
- Required environment:
- Input or fixture:
- Expected result:
- Actual result:
- Interpretation:
- Known limitations:
- Staleness trigger:
- Related implementation:
- Related initiative:
```

Preserve the reproduction path more carefully than the old result.

Results may become stale because of:

- compiler upgrades;
- hardware changes;
- kernel or firmware changes;
- altered build flags;
- protocol changes;
- different replay inputs;
- changes elsewhere in the execution path.

Rerun the reproduction method when current truth matters. Clearly mark stale or
superseded results.

Use logical revision labels rather than wall-clock chronology. Git retains
detailed historical time.

## 11. Decision heuristics

### Rename a symbol when

- it is important across files or components;
- natural task language does not lead to it;
- its search results are dominated by unrelated behavior;
- its current name misrepresents its responsibility;
- multiple concepts share the same textual handle.

Do not rename a clear, local symbol merely to increase word count.

### Split a file when

- it contains several independently searchable responsibilities;
- agents and humans repeatedly read irrelevant sections;
- a concept-named file would create a direct attention route;
- separate ownership or verification loops already exist.

Do not split a coherent mechanism only to satisfy a size preference.

### Introduce a domain type when

- two values share a representation but are not safely interchangeable;
- a compiler error could replace a runtime or review-time mistake;
- the type clarifies units, ownership, clock domain, state, or protocol meaning;
- zero-cost and layout expectations can be verified.

Do not wrap primitives without a semantic or safety benefit.

### Add a definition-local comment when

- the invariant cannot be inferred from the signature;
- the behavior has an important owner elsewhere;
- the code intentionally omits an expected action;
- concurrency, lifetime, timing, or performance assumptions are non-obvious.

Do not write comments that merely translate syntax into prose.

### Refactor for discoverability when

- retrieval failures are observed;
- incorrect near-matches are plausible;
- review effort is consumed locating behavior rather than reasoning about it;
- the change can preserve or improve runtime properties;
- the initiative provides a bounded scope and verification path.

Do not launch a repository-wide rewrite based only on external examples.

Prefer the smallest change that creates a durable semantic address, an
enforceable boundary, or a reproducible verification route.

## 12. Legacy paths and feature retirement

Unmarked legacy code is likely to be rediscovered and reused.

When retaining a temporary compatibility path:

```cpp
[[deprecated("Use applyNasdaqItchOrderBookDelta instead")]]
BookUpdateResult applyDelta(const Message& message);
```

Also:

- link or name the replacement;
- state the remaining consumer or lifecycle justification;
- avoid introducing new usage;
- define the verification required before removal;
- remove the alias when the final consumer migrates.

When retiring an initiative:

1. start from its root IV;
2. follow links through child documents, code, tests, benchmarks,
   configuration, infrastructure, data, APIs, jobs, dashboards, and
   operational procedures;
3. search for unlinked consumers, aliases, macros, generated references, and
   dynamic dependencies;
4. identify behavior still required by other initiatives;
5. separate shared behavior from initiative-specific behavior;
6. delete only artifacts without remaining lifecycle justification;
7. run the strongest practical correctness and performance verification;
8. mark, move, or delete the retired IV;
9. remove stale links, names, compatibility wrappers, and evidence claims;
10. record the replacement or superseding initiative where one exists.

A clean retirement removes misleading search results as well as dead runtime
behavior.

## 13. Review prompts

Use these prompts during design and review:

- Can a reader derive a useful search term from the task or IV?
- Does that search lead to the canonical definition rather than a near-match?
- Do paths and filenames expose the relevant domain concept?
- Are important call sites and tests searchable by the same terminology?
- Does the signature explain the inputs, outputs, units, and ownership?
- Could the compiler reject likely domain substitutions?
- Are hot-path and concurrency invariants stated at the definition?
- Is intentionally absent behavior documented?
- Is critical behavior hidden only behind a template, macro, operator, alias, or
  generated file?
- Did the refactoring preserve the intended runtime architecture?
- Are correctness and performance claims reproducible?
- Are environment assumptions recorded?
- Does the root IV still explain why the changed artifacts exist?
- Were stale names, links, wrappers, and evidence removed?
- Would retirement begin from a coherent lifecycle map?

## Core principle

Design the repository so that important behavior has a distinctive textual
address, a precise compile-time contract, a cognitively local explanation, a
lifecycle justification, and a reproducible verification path.

Write for humans, compilers, search-driven agents, and production hardware at
the same time.

## Revision notes

- Revision 1: Established the initial doctrine for agent-discoverable and
  performance-safe HFT C++, integrating grep-first code navigation with the
  IV/DC cognitive workspace and HFT verification requirements.

## References

- [How coding agents read your code (and how to write for them)](https://modem.dev/blog/how-coding-agents-read-your-code)
  — read for the external observations about text-search navigation,
  distinctive names, precise types, definition-local comments, and
  concept-named modules. Treat the experiments as illustrative.
- `RFC: IV/DC Agentic Workspace`
  — read for the governing model of initiatives, doctrines, annotated links,
  evidence, logical time, progressive disclosure, agent workflow, and feature
  retirement.
