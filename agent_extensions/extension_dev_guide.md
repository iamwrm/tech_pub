# Pi Extension Dev Guide

Practical notes for building pi extensions quickly next time.

## 1) Start here

For pi-specific work, read these first:

- Main docs:
  - `/home/wr/.local/share/pnpm/global/5/.pnpm/@mariozechner+pi-coding-agent@0.62.0_ws@8.19.0_zod@4.3.6/node_modules/@mariozechner/pi-coding-agent/README.md`
- Core extension docs:
  - `/home/wr/.local/share/pnpm/global/5/.pnpm/@mariozechner+pi-coding-agent@0.62.0_ws@8.19.0_zod@4.3.6/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- TUI / status / widgets:
  - `/home/wr/.local/share/pnpm/global/5/.pnpm/@mariozechner+pi-coding-agent@0.62.0_ws@8.19.0_zod@4.3.6/node_modules/@mariozechner/pi-coding-agent/docs/tui.md`
- Session structure:
  - `/home/wr/.local/share/pnpm/global/5/.pnpm/@mariozechner+pi-coding-agent@0.62.0_ws@8.19.0_zod@4.3.6/node_modules/@mariozechner/pi-coding-agent/docs/session.md`
- Models / provider behavior:
  - `/home/wr/.local/share/pnpm/global/5/.pnpm/@mariozechner+pi-coding-agent@0.62.0_ws@8.19.0_zod@4.3.6/node_modules/@mariozechner/pi-coding-agent/docs/models.md`

Useful examples:

- `examples/extensions/status-line.ts`
- `examples/extensions/model-status.ts`
- `examples/extensions/custom-footer.ts`
- `examples/extensions/provider-payload.ts`
- `examples/extensions/send-user-message.ts`

## 2) Recommended workflow

### Extension location

Use project-local auto-discovery so `/reload` works:

- `.pi/extensions/*.ts`
- `.pi/extensions/*/index.ts`

For small one-off extensions, a single file is best.

### Fast iteration loop

1. Create extension in:
   - `.pi/extensions/my-extension.ts`
2. Validate it loads:
   - `pi --no-extensions -e ./.pi/extensions/my-extension.ts -p "hi"`
3. Then use it normally via auto-discovery and `/reload`.

### Important note

Footer status from `ctx.ui.setStatus()` is **not persisted**. If the extension shows historical state, reconstruct it from the session on lifecycle events.

## 3) Event selection heuristics

Choose the narrowest event that matches the UX.

### Good default rules

- Use `agent_end` when the feature is about **one user prompt as a whole**.
- Use `turn_end` when the feature is about **one LLM turn** inside a larger tool loop.
- Use `message_*` events when the feature is about **streaming or per-message UI**.
- Use `model_select` when the feature responds to model changes.
- Use session events when the UI must survive reload/resume/navigation.

### Session events commonly needed for restoration

- `session_start`
- `session_switch`
- `session_tree`
- `session_fork`

These are the right hooks when UI state depends on current session/branch history.

## 4) UI surface selection heuristics

Prefer the simplest surface that fits.

### Use `ctx.ui.setStatus()` when

- one compact footer line is enough
- state should persist across renders
- you want low-risk integration with built-in footer

### Use `ctx.ui.setWidget()` when

- you need multiple lines
- you want content above/below the editor
- richer persistent UI is needed

### Use custom footer only when

- built-in footer is not sufficient
- you need full layout control

For most extensions, start with `setStatus()`.

## 5) Session reconstruction pattern

If the displayed state is derived from prior conversation state, reconstruct from:

```ts
const branch = ctx.sessionManager.getBranch();
```

General pattern:

1. Get current branch.
2. Filter to relevant entries, often `entry.type === "message"`.
3. Walk backward to find the latest relevant completed segment.
4. Aggregate only the messages that belong to that segment.
5. Re-render status/widget.

### Why this matters

After `/reload`, `/resume`, `/tree`, or `/fork`, there may be no new runtime event to replay. Reconstruction keeps the UI truthful.

## 6) Provider/model data strategy

Prefer normalized pi message data over raw provider payloads.

### Good rule

If pi already puts the data on assistant messages, use that.

For token/cost/cache work, prefer:

- `assistantMessage.usage`
- `assistantMessage.provider`
- `assistantMessage.model`

Avoid building primary logic on `before_provider_request` unless the feature is explicitly about raw request inspection/debugging.

### Why

- provider payloads differ
- usage is most useful after completion
- pi normalizes many provider differences for you

## 7) OAuth/subscription detection

If you need to show whether a historical model used OAuth:

```ts
const model = ctx.modelRegistry.find(provider, modelId);
const usingOAuth = model ? ctx.modelRegistry.isUsingOAuth(model) : false;
```

Important: use the **historical assistant message model/provider**, not necessarily `ctx.model`, because the current model may have changed since the historical turn.

## 8) Common implementation skeleton

```ts
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "my-extension";

function recomputeFromBranch(ctx: ExtensionContext) {
  // inspect ctx.sessionManager.getBranch()
  // derive state
  // ctx.ui.setStatus(STATUS_KEY, text)
}

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (event, ctx) => {
    // primary live update path
  });

  pi.on("session_start", async (_event, ctx) => {
    recomputeFromBranch(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    recomputeFromBranch(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    recomputeFromBranch(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    recomputeFromBranch(ctx);
  });
}
```

## 9) Formatting guidance for status lines

Rules that worked well:

- keep it single-line
- avoid ambiguous naked numbers like bare `%`
- use short labels with meaning, e.g. `H67%` not `67%`
- group related metrics together
- dim labels, highlight important values

Example compact pattern:

- `provider/model ↑73k R145k H67% W26k ↓398 $0.224`

Meaning:

- `↑` non-cached input
- `R` cache read
- `H` cache hit rate
- `W` cache write
- `↓` output
- `$` total cost

## 10) Testing checklist

For any extension that depends on history or lifecycle, test:

- one normal prompt
- a prompt with tool loops
- `/reload`
- `/resume`
- `/tree`
- `/fork`
- model switch before next prompt
- brand new session with no historical data
- aborted / no-result path

For status-based extensions, verify:

- status updates on the primary event
- status restores correctly on session lifecycle events
- status clears or stays stable in intentional edge cases

## 11) Useful commands for investigation

### Find files in docs/examples

```bash
rg --files -n .
```

### Search pi docs/runtime types

```bash
rg -n "agent_end|setStatus|model_select|getBranch|isUsingOAuth" <path>
```

### Validate extension can load

```bash
pi --no-extensions -e ./.pi/extensions/my-extension.ts -p "hi"
```

## 12) Notes from the token-usage extension

File:

- `.pi/extensions/token-usage-last-turn.ts`

Key design decisions that worked well:

- use `agent_end` as primary aggregation boundary
- aggregate only assistant message usage
- reconstruct from `ctx.sessionManager.getBranch()` on session lifecycle events
- render with `ctx.ui.setStatus()`
- use normalized `message.usage` instead of raw provider payloads
- avoid ambiguous footer labels; use `H67%` instead of bare `67%`

## 13) Quick decision checklist before coding

Ask these before implementation:

1. Is this feature about a **prompt**, a **turn**, a **message**, or a **session**?
2. Is the UI **ephemeral live state** or **historical state that must be restored**?
3. Can pi’s normalized message/session model provide the data already?
4. Is `setStatus()` enough, or do we need widget/footer customization?
5. Which lifecycle events must trigger reconstruction?

## 14) Safe default approach

If unsure, start with this strategy:

- derive state from session/messages, not ad hoc globals
- update on the most semantically correct event
- reconstruct from branch on session lifecycle events
- use compact status UI first
- add commands/debug tooling only after core behavior works
