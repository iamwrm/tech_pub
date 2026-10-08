---
name: live-context
description: Compact stale conversation history through Pi's private live-context mirror. Use when context pressure is high, tool outputs are large, or old exploration should be replaced by a durable summary.
---

# Live Context Management

Pi's live-context extension places the current model-visible conversation in the mirror
path named in the `## Live context management` section of the system prompt.

Use the mirror only when a meaningful batch compaction will improve future work. Do not
compact after every turn.

## Rules

1. Do **not** print or `cat` the entire mirror. Its contents are already in context.
2. Preserve the `[[LIVE_CONTEXT ...]]` line and every retained `[[CTX_TURN ...]]` header.
3. Never try to rewrite a `protected=true` turn; the extension restores it.
4. Make one batched mirror write in a turn. This is an atomicity rule, **not** a request
   for one global summary. One write should contain as many independent, localized block
   replacements or removals as the revision needs. Read-only inspection is never counted.
5. Default to a **surgical revision**: preserve message order and conversational structure,
   leave unrelated blocks unchanged, shorten stale bodies in place, and remove only
   clearly obsolete or redundant blocks. Do not repeatedly collapse the whole effective
   context into the same summary shape.
6. Preserve complete conversational units. If a user request remains relevant, normally
   retain its corresponding assistant analysis or replace that analysis with a local,
   specific summary at the same position. Do not keep only user messages while silently
   deleting all assistant-side reasoning and results.
7. Interpret retention language precisely:
   - "keep/preserve these messages" means retain the referenced user **and** assistant
     messages exactly unless the user narrows the roles;
   - "preserve the findings/analysis" permits a faithful semantic summary;
   - if the boundary or exactness is genuinely ambiguous, ask rather than choosing the
     most destructive interpretation.
8. Use one global consolidation only when the user explicitly requests deep/aggressive
   compression. Context pressure by itself is not permission to flatten every episode.
9. The complete result must have a lower Pi-estimated token count. Prefer removing large
   tool output and superseded exploration before compressing useful dialogue.
10. Preserve decisions, constraints, unresolved questions, file paths, commands still
    needed, test results, provenance that explains conclusions, and the next action.
11. Wait for the next `[LIVE CONTEXT]` notice to confirm whether the edit was accepted.

## Expected edit shape

Prefer a sparse patch over the existing conversation:

```text
before: user A -> assistant investigation A -> tool output -> user B -> assistant result B
after:  user A -> concise assistant A       -> user B      -> concise assistant B
```

Avoid flattening independent episodes into one synthetic message:

```text
avoid:  user A -> one global summary of everything -> user B
```

The concise assistant replacements should remain separate blocks near the requests they
answer. Existing good summaries should normally remain untouched in later revisions.

## Edit cost

An accepted edit changes the request prefix, so the provider re-processes everything
after the edit point on the next call and cached prefix tokens from that point on are
recomputed. Consequences:

- One large batched compaction costs less than several small edits.
- Compact stale early turns before a long, still-useful tail accumulates below them.
- Make replacement summaries detailed. The text after the edit is re-processed either
  way, so a thorough summary adds little cost and prevents repeated re-investigation.

## Recommended method

If exact turn IDs are not already known, print only headers carrying the **current**
document nonce. Do not use a broad `grep '^\\[\\['`: old tool output or documentation may
contain header-shaped examples.

```bash
LIVE_CTX="<mirror path from system prompt>" python3 - <<'PY'
import os, re
from pathlib import Path

lines = Path(os.environ["LIVE_CTX"]).read_text().splitlines()
meta = re.fullmatch(r"\[\[LIVE_CONTEXT .* document=([a-f0-9]{64}) baseline=[a-f0-9]{64}\]\]", lines[0])
if not meta:
    raise SystemExit("invalid live-context metadata")
doc = meta.group(1)
print(lines[0])
for line in lines[1:]:
    if line.startswith(f"[[CTX_TURN document={doc} "):
        print(line)
PY
```

The script reads bodies locally but emits only the active metadata/header lines. Then use
a script that locates blocks by their exact header IDs and replaces or removes them
without retyping the old body.

```bash
python3 - <<'PY'
from pathlib import Path
import re

p = Path("<mirror path from system prompt>")
s = p.read_text()

# Replace one stale turn body while preserving its header.
turn_id = "<id from an existing CTX_TURN header>"
summary = "[summary: exact findings, decisions, files, and next action]"
pattern = rf"(^\[\[CTX_TURN [^\n]* id={re.escape(turn_id)} [^\n]*\]\]\n).*?(?=\n\n\[\[CTX_TURN |\Z)"
s, count = re.subn(pattern, lambda m: m.group(1) + summary, s, count=1, flags=re.M | re.S)
if count != 1:
    raise SystemExit(f"turn not found: {turn_id}")

p.write_text(s)
PY
```

For a larger compaction, still prefer several local replacements: summarize each stale
investigation or tool-heavy episode in its original block, retain the surrounding
user/assistant exchange, and delete only blocks whose value is captured nearby. A single
script can perform all of these disjoint edits and write the mirror once. Only replace a
whole span with one comprehensive summary when the user explicitly requested global
consolidation. Use IDs returned by the nonce-filtered header listing. Do not invent IDs or
duplicate blocks.

## Durable continuity annotations

Before removing or rewriting an exact source that later work must revisit, call
`live_context_annotate` with the source block ID from its current `CTX_TURN` header:

- `pin` keeps a bounded exact textual source visible;
- `continuity` keeps its title, reason, next action, and recall ID visible while allowing
  the source to be summarized;
- `archive` keeps no normal-context pointer and is available only through bounded recall.

Use `live_context_recall` only when the source is needed. Resolve an annotation once its
future action is complete. An annotation complements a surgical edit; it is not a license
to collapse unrelated messages.

## What a durable summary should contain

```markdown
[summary]
Goal: ...
Constraints: ...
Findings:
- ...
Decisions:
- ...
Files and state:
- path: relevant status
Validation:
- command/result
Open questions:
- ...
Next action: ...
[/summary]
```

Prefer concrete state over narrative. A future model turn should be able to continue from
the summary without needing the removed output.
