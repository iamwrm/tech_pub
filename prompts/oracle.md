**Option 1 — General-purpose collector**

```text
You are preparing context for an Oracle AI that will solve a hard problem with higher cost
and latency. Given the problem statement: [PROBLEM], gather the most relevant external
information, source code, internal docs, configs, tests, logs, schemas, examples, and prior
decisions needed to solve it. Prefer high-signal files over bulk. Preserve file paths, include
a short README explaining why each item is included, add a manifest with paths and brief
descriptions, redact secrets and private credentials, then package everything into a .zip
ready to upload to the Oracle.
```

**Option 2 — Strict minimal bundle**

```text
Collect the smallest useful evidence bundle for an Oracle AI to solve: [PROBLEM].
Search the repo, docs, tickets, logs, configs, tests, data samples, and relevant external
sources. Include only files that directly explain the problem, constraints, behavior,
interfaces, failures, or attempted fixes. Preserve paths, redact secrets, add README.md
with the problem summary, assumptions, key files, and open questions, then create a
.zip containing the bundle and a manifest.
```

**Option 3 — Best default / pragmatic**

```text
Act as a context-gathering agent for an Oracle AI. For the problem: [PROBLEM], identify
all information the Oracle would need to reason effectively: relevant source files,
interfaces, configs, docs, tests, logs, sample inputs/outputs, error traces, design notes,
dependencies, and trustworthy external references. Avoid unrelated bulk, preserve original
paths, redact secrets, note missing context, write README.md and MANIFEST.md explaining
the bundle, then create a .zip for upload.
```

**Option 4 — Engineering/debugging focused**

```text
Prepare an Oracle upload bundle for debugging or solving this engineering problem:
[PROBLEM]. Collect the source files on the execution path, related tests, configs,
dependency files, build/run scripts, logs, stack traces, sample data, architecture docs,
recent changes, and any relevant external references. Exclude generated files and secrets.
Preserve paths, include reproduction steps and known hypotheses in README.md, include
MANIFEST.md, and zip the final bundle.
```

**Option 5 — Research-heavy / broad context**

```text
Build a high-signal research bundle for an Oracle AI to solve: [PROBLEM]. Gather relevant
internal files, source code, docs, design notes, configs, logs, tests, examples, datasets,
and external references that explain the domain, constraints, prior attempts, and likely
solution paths. Summarize what each item contributes, flag uncertainty and missing
evidence, remove secrets, preserve paths, create README.md and MANIFEST.md, then package
everything into a .zip.
```

**Recommendation**

```text
Use Option 3 as the default. It is broad enough to capture code, docs, logs, tests,
configs, examples, and external references, but still tells the collector to avoid noisy
bulk and to produce README.md plus MANIFEST.md. Use Option 2 when Oracle cost is very
sensitive, Option 4 for software debugging, and Option 5 when the problem needs more
research or domain context.
```
