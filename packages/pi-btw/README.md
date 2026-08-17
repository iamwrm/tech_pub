# pi-btw

Private, path-installed pi extension adding one background, multi-turn side
branch per source session. It starts **no-tool by default**, supports explicit
`/tools` opt-in to all core tools, and can materialize completed turns as a
normal resumable session. The branch freezes its parent context, model,
thinking level, effective system prompt, and cwd at the first question. It is
a pi 0.84.1 background side-branch extension.

Lifecycle and design: [`IV-0017`](../../docs/IV-DC/IV-0017-pi-btw.md).

## Install

```bash
pi install ./packages/pi-btw
# Or use an absolute path.
```

Start a new pi session or `/reload`; verify with `pi list`. This private package
is path-only and is not published to npm. Remove it with:

```bash
pi remove pi-btw
```

## Commands

| Command | Effect |
| --- | --- |
| `/btw2 <question>` | Start the branch or add a follow-up. |
| `/btw2` | Open the question editor with no branch, or the actions dialog with one. |
| `/btw2 --fork [name]` | Materialize all completed turns as a sleeping normal session. |
| `/btw2 --stop` | Abort the streaming response; its partial turn is not promotable. |
| `/btw2 --discard` | Abort and forget the in-memory branch. |
| `/btw2 --dismiss` | Clear the last completed-fork notice. |
| `/btw2 --help` / `-h` | Show help. |
| `/tools` | Enable core `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`. |
| `/tools off` | Disable tools again. |

With no live branch, bare `/btw2` opens the multi-line editor headed
`BTW2 question · no tools · Esc returns to the main session`; its newline
binding is used for multi-line input. Esc or a blank submission returns without
creating state. With a live branch it opens actions instead. Direct
`/btw2 <question>` skips the dialog. Answers stream in a widget while focus
stays on the main prompt; `/btw2 --stop` also appears in the actions dialog.

## Side-branch contract

- The first question snapshots the persisted parent leaf, built context,
  effective system prompt, selected model, thinking level, and effective cwd.
  Later main-thread changes are intentionally invisible. There is one live
  branch per source session, and follow-ups use only its successful turns.
- The side Agent uses `tools: []` until `/tools`. Enabling/disabling rebuilds it
  with the full core set rooted at the frozen cwd, only while idle, preserving
  frozen context, model, thinking level, session ID, and completed turns. The
  public pi tool factories provide `prepareArguments`/schema validation and
  the raw Agent loops through tool results until final text. The widget changes
  from `· no tools` to `· with tools`. Tool effects are real in the shared
  workspace; tool-bearing completed turns are promotable.
- Failed, aborted, errored, or incomplete turns roll back and cannot be
  materialized. Only complete user/assistant pairs, plus tool-call/tool-result
  messages from enabled turns, are copied.
- Live state is RAM-only: shutdown, reload, source-session shutdown, discard,
  or process loss destroys it. It never enters the parent transcript or parent
  statistics, although provider usage and billing still apply.
- `--fork` is the only persistence operation. It copies the captured parent
  branch and complete side turns into a new JSONL file in the parent's session
  directory, leaves the parent byte-unchanged, and publishes with no-clobber,
  all-or-nothing staging; failed publication cleans its staging file. It
  returns an ID without replacing the parent
  terminal; resume in another terminal with:

  ```bash
  pi --session <session-id>
  ```

The resumed session has pi's normal tools and write access. BTW2 is
conversation branching, not process, filesystem, Git, or security isolation:
it shares the frozen cwd/workspace, so concurrent tools can conflict. On
resume, pi rebuilds the current prompt, extensions, and tool set; the no-tool
note is not permanent. The recorded model/thinking level is requested, but
current provider/model/auth availability controls the result. Prime's service
tier is not part of this port.

## Request-pipeline and checkpoint boundary

BTW2 uses pi's raw `Agent` from `@earendil-works/pi-agent-core`, authenticated
`streamSimple` from `@earendil-works/pi-ai/compat`, and
`ctx.modelRegistry.getApiKeyAndHeaders`. It snapshots the public model/system/
message state but cannot inherit arbitrary parent extension callbacks such as
`before_provider_request` or `before_provider_headers`.

The known `openai-responses-compaction-v2` checkpoint written by
`0017-openai-server-compaction` is replayed portably: its
provider/adapter/model/base-URL identity is validated. Pi's compaction summary
has no retained-message count, so the post-checkpoint tail is derived as the
entries after the checkpoint on the leaf path; `replacementHistory` is
prepended to final Responses payloads; the standard-Responses prefix and
`messages`/`previous_response_id` are removed. Malformed checkpoints, identity
drift, or non-Responses payloads fail closed before transport. Other opaque
formats and future mandatory request hooks are unsupported unless explicitly
adapted. BTW2 does not create a second full `AgentSession`, so it does not
re-run extension factories or lifecycle side effects; readable Pi compactions
remain ordinary context.

## Security, cost, and limits

- “Private side branch” means absent from the parent session file, not private
  from the configured provider. The frozen prompt and prior conversation,
  including already-present secrets or tool output, are sent to that provider.
  Tools off prevents new tool execution, not data transmission; `/tools` permits
  real workspace side effects.
- Discarded runs leave no parent JSONL accounting/audit entry, but still consume
  provider quota. Memory has no TTL, turn cap, or separate token cap beyond the
  provider context limit; large branches can consume substantial RAM, and
  synchronous materialization can briefly block the runtime.
- Widget, notice, transcript, and session-name display text is terminal-
  sanitized and bounded. Detached publication uses a same-directory hard link:
  no partial file or overwrite is exposed. Linux is validated; unsupported
  filesystems/platforms fail safely and return no session ID.

## Development

Validated target: pi 0.84.1, Node.js >= 22.8.0.

```bash
cd packages/pi-btw
npm ci
npm run check
npm test
npm pack --dry-run
```

The suite covers command/UI models, terminal safety, state and parent
immutability, checkpoint replay, and detached publication. Live TUI/editor/Esc,
native-checkpoint replay, fork/resume, and restored-tool acceptance remain
pending as recorded in IV-0017; unit tests cover their failure classes.
