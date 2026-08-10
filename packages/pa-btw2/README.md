# pa-btw2

`pa-btw2` is a private, path-installed Prime Agent extension that adds a
multi-turn, background, **no-tool** side branch and can materialize that branch
as a normal resumable session.

It intentionally differs from Prime Agent's native `/btw` (also `/side`):
BTW2 freezes the parent branch once, preserves the selected model, thinking
level, service tier, and effective system prompt, keeps follow-ups on that
frozen side branch, and supports explicit materialization. Native `/btw`
refreshes from the current main context on every turn and has no persistent
session to promote.

Lifecycle and design decisions: [IV-0014](../../docs/IV-DC/IV-0014-pa-btw2.md).

## Install

From this repository root:

```bash
prime-agent package install ./packages/pa-btw2
# Or use an absolute path.
```

Start a new Prime Agent session, or run `/reload` in an existing one. Verify
with `prime-agent package list`. This package is private/path-only and is not
published to npm.

Remove it with:

```bash
prime-agent package remove pa-btw2
```

## Commands

| Command | Action |
| --- | --- |
| `/btw2 <question>` | Start a side branch, or add a follow-up to the current one. |
| `/btw2` | Open the actions dialog (follow up, transcript, fork, discard, stop). |
| `/btw2 --fork [name]` | Materialize all completed turns as a sleeping normal session. |
| `/btw2 --stop` | Abort the response currently streaming; the partial turn is not promotable. |
| `/btw2 --discard` | Abort and forget the in-memory side branch. |
| `/btw2 --dismiss` | Clear the last completed-fork notice. |
| `/btw2 --help` or `-h` | Show command help. |

After `--fork`, BTW2 returns a session ID without replacing the parent terminal:

```bash
prime-agent -r <session-id>
```

Resume it in another terminal to get the host's normal tools and write access.

## Semantics

- The first question snapshots the persisted parent leaf, its built
  conversation context, the effective system prompt, selected model, thinking
  level, service tier, and effective cwd. Later main-thread changes are
  intentionally invisible to that BTW2 branch.
- The side agent uses `tools: []`. Follow-ups extend only its frozen in-memory
  conversation. There is one live BTW2 branch per source session in the worker.
- Failed, aborted, errored, or tool-containing turns are rolled back and cannot
  be materialized. Only complete user/assistant pairs are copied.
- Live side state is RAM-only. Shutdown, reload, source-session shutdown,
  discard, or process loss destroys it. It is absent from the parent transcript
  and parent session statistics, although provider calls still incur usage.
- `--fork` is the only persistent operation. It copies the captured parent
  branch and complete side turns into a new archived JSONL session and leaves
  the parent file byte-unchanged. Publication is no-clobber and all-or-nothing.

A materialized fork is **conversation branching, not process, filesystem, Git,
or security isolation**. The resumed session inherits the effective cwd and
shares the same workspace as the parent. Concurrent tools can conflict. On
resume, Prime Agent rebuilds its normal current system prompt, extensions, and
tool set; the BTW2 no-tool note is not installed as a permanent prompt. The
recorded model is requested, but current provider/model/auth availability still
governs whether it can be used.

## Request-pipeline boundary

BTW2 uses Prime Agent's public raw `Agent` and authenticated model registry. It
faithfully snapshots the model object, thinking level, service tier, system
prompt, and built message context, but it cannot inherit arbitrary private
parent-agent callbacks or future extension request hooks that Prime Agent does
not expose in `ExtensionCommandContext`.

For correctness, BTW2 refuses a source branch containing the opaque
`openai-responses-compaction-v2` checkpoint used by
`pa-openai-server-compaction`: replaying the pre-checkpoint context requires
that extension's provider hook, which a raw side agent cannot invoke. Use a
normal fork/resume path or a branch without that checkpoint instead. Readable
native Prime Agent compaction entries remain supported.

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
  substantial RAM; synchronous materialization can briefly block the worker.
- Widget, notice, transcript, and session-name display text is terminal-sanitized
  and bounded where rendered.
- Detached publication uses a same-directory hard link so the target cannot be
  partially observed or overwrite an existing file. It is validated on Linux;
  filesystems or platforms without hard-link support fail safely and return no
  session ID.

## Development

Validated target: Prime Agent 0.7.1, Node.js >= 22.8.0.

```bash
cd packages/pa-btw2
npm ci
npm run check
npm test
npm pack --dry-run
```

The suite covers command parsing/rendering, terminal safety, extension state
and parent immutability, and detached-session validation/publication. Live
daemon/provider/fork/resume/tool-write acceptance is recorded in IV-0014; unit
tests and that Linux smoke test cover different failure classes.
