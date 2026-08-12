# pi-btw

`pi-btw` is a private, path-installed pi extension that adds a multi-turn,
background, **no-tool** side branch and can materialize that branch as a
normal resumable session. It is the pi port of the Prime Agent
[`pa-btw2`](../../packages/pa-btw2/README.md) package: the same `/btw2`
command surface and semantics, fitted to the pi 0.84.1 extension API.

It intentionally differs from pi's built-in capabilities: BTW2 freezes the
parent branch once, preserves the selected model, thinking level, and
effective system prompt, keeps follow-ups on that frozen side branch, and
supports explicit materialization. A forked session is resumable with normal
tools in a second terminal.

Lifecycle and design decisions: [IV-0017](../../docs/IV-DC/IV-0017-pi-btw.md).

## Install

From this repository root:

```bash
pi install ./packages/pi-btw
# Or use an absolute path.
```

Start a new pi session, or run `/reload` in an existing one. Verify with
`pi list`. This package is private/path-only and is not published to npm.

Remove it with:

```bash
pi remove pi-btw
```

## Commands

| Command | Action |
| --- | --- |
| `/btw2 <question>` | Start a side branch, or add a follow-up to the current one. |
| `/btw2` | With no branch, open the question editor; with a branch, open the actions dialog. |
| `/btw2 --fork [name]` | Materialize all completed turns as a sleeping normal session. |
| `/btw2 --stop` | Abort the response currently streaming; the partial turn is not promotable. |
| `/btw2 --discard` | Abort and forget the in-memory side branch. |
| `/btw2 --dismiss` | Clear the last completed-fork notice. |
| `/btw2 --help` or `-h` | Show command help. |
| `/tools` | Enable all core tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) on the live side branch. |
| `/tools off` | Disable tools again; the side branch is no-tool. |

### Bare `/btw2` dialog

With no live branch, bare `/btw2` opens pi's multi-line editor with the
heading `BTW2 question · no tools · Esc returns to the main session`. Submit
to start the background side branch; use the editor's newline binding for a
multi-line question. **Esc cancels the dialog, returns focus to the main
prompt, and creates no BTW2 state.** A blank submission has the same no-op
result.

Once a branch exists, bare `/btw2` opens its actions dialog instead. Direct
`/btw2 <question>` remains the fastest way to start or follow up without the
extra dialog.

The answer streams in the BTW2 widget above the main editor while focus stays
on the main session. Stop a running side response with `/btw2 --stop` or the
actions dialog.

### Tools: no-tool by default, opt in with `/tools`

The side branch starts strictly no-tool: the widget header reads
`BTW2 · <model> · thinking <level> · no tools` and the frozen system prompt
carries a no-tool contract. Typing `/tools` while a branch is live rebuilds
the side Agent with the full core tool set (`read`, `write`, `edit`, `bash`,
`grep`, `find`, `ls`) rooted at the branch's frozen cwd; the widget header
flips to `· with tools`. The actions dialog offers the same toggle
("Enable all tools" / "Disable tools"). Only completed turns and the frozen
context survive the rebuild; the change is allowed while the branch is idle.
Tool side effects are real and share the parent's workspace — the same
conflict caveats as a resumed fork apply. With tools on, completed turns may
contain tool-call/tool-result messages, and forks preserve them.

After `--fork`, BTW2 returns a session ID without replacing the parent
terminal:

```bash
pi --session <session-id>
```

Resume it in another terminal to get the host's normal tools and write access.

## Semantics

- The first question snapshots the persisted parent leaf, its built
  conversation context, the effective system prompt, selected model, thinking
  level, and effective cwd. Later main-thread changes are intentionally
  invisible to that BTW2 branch.
- The side agent uses `tools: []` by default. Follow-ups extend only its
  frozen in-memory conversation. There is one live BTW2 branch per source
  session. `/tools` opts the branch into the core tool set (see above); the
  tool set can be toggled back off.
- Failed, aborted, errored, or incomplete turns are rolled back and cannot
  be materialized. Only complete turns (user/assistant pairs, plus the
  tool-call/tool-result messages of tool-enabled turns) are copied.
- Live side state is RAM-only. Shutdown, reload, source-session shutdown,
  discard, or process loss destroys it. It is absent from the parent transcript
  and parent session statistics, although provider calls still incur usage.
- `--fork` is the only persistent operation. It copies the captured parent
  branch and complete side turns into a new JSONL session file in the parent's
  session directory and leaves the parent file byte-unchanged. Publication is
  no-clobber and all-or-nothing.

A materialized fork is **conversation branching, not process, filesystem, Git,
or security isolation**. The resumed session inherits the effective cwd and
shares the same workspace as the parent. Concurrent tools can conflict. On
resume, pi rebuilds its normal current system prompt, extensions, and tool
set; the BTW2 no-tool note is not installed as a permanent prompt. The
recorded model and thinking level are requested, but current
provider/model/auth availability still governs whether they can be used.
(Service tier is a Prime Agent concept and is not part of the pi port.)

## Request-pipeline boundary

BTW2 uses pi's raw `Agent` (`@earendil-works/pi-agent-core`) with an
authenticated `streamSimple` stream function (`@earendil-works/pi-ai/compat`)
and `ctx.modelRegistry.getApiKeyAndHeaders` auth. It faithfully snapshots the
model object, thinking level, system prompt, and built message context, but it
cannot inherit arbitrary private parent callbacks or pi extension request
hooks (`before_provider_request` and friends) that run inside the parent's
agent loop. Extensions whose correctness depends on request-payload rewriting
(e.g. `0021-gpt-reasoning-replay` in the public bundle) do not apply to BTW2
side calls.

The known `openai-responses-compaction-v2` checkpoint written by the
`0017-openai-server-compaction` extension is handled portably inside BTW2. It
validates the persisted provider/adapter/model/base-URL identity, derives the
post-checkpoint tail from the persisted branch (pi's compaction summary
message carries no retained-message count, so the boundary is the set of
entries after the checkpoint entry on the leaf path), and prepends the
checkpoint's persisted `replacementHistory` to each final Responses payload.
Post-checkpoint parent messages and completed BTW2 turns are still serialized
by the current pi-ai provider; the standard-Responses developer/system prefix
is removed because the checkpoint already owns it, and
`messages`/`previous_response_id` fallback fields are removed just as they are
on normal native-checkpoint replay. A malformed checkpoint, an identity
change, or a non-Responses payload fails closed before transport.

BTW2 deliberately does not create a second full `AgentSession`: rediscovering
extensions would invoke their factories and lifecycle side effects again, and
the side branch is intentionally free of extension request hooks. Other opaque
checkpoint formats and arbitrary future request hooks are therefore still
unsupported unless BTW2 adds an explicit portable replay path. Readable
native pi compaction entries remain supported (they stay in the transcript as
regular context).

## Security, cost, and limits

- “Private side branch” means absent from the **parent session file**, not local
  or private from the configured provider. The frozen system prompt and prior
  conversation—including tool/file output or secrets already present—are sent
  to that provider. No-tools prevents new tool execution; it does not prevent
  data transmission.
- Provider billing/quota applies. A discarded side run leaves no accounting or
  audit entry in the parent JSONL.
- Memory is currently unbounded: there is no TTL, turn cap, or separate token
  cap beyond the model/provider context limit. Large branches can consume
  substantial RAM; synchronous materialization can briefly block the runtime.
- Widget, notice, transcript, and session-name display text is terminal-sanitized
  and bounded where rendered.
- Detached publication uses a same-directory hard link so the target cannot be
  partially observed or overwrite an existing file. It is validated on Linux;
  filesystems or platforms without hard-link support fail safely and return no
  session ID.

## Development

Validated target: pi 0.84.1, Node.js >= 22.8.0.

```bash
cd packages/pi-btw
npm ci
npm run check
npm test
npm pack --dry-run
```

The suite covers command parsing/rendering, terminal safety, extension state
and parent immutability, opaque-checkpoint replay, and detached-session
validation/publication. Live TUI/editor/Esc, native-checkpoint replay,
fork/resume, and restored-tool acceptance is recorded in IV-0017; unit tests
cover the failure classes.
