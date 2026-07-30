## distilled pseudocode

```
Explain to me in ascii art and code snippets as distilled pseudocode, not verbatim repository code, for illustrative purpose.
```

## Summarize in Chinese

```
Summarize this article 
Reply in Chinese while retaining key technical terms in English.
```

## Bro

```
---
name: bro
description: Restate the last message in plain human language, with no jargon.
disable-model-invocation: true
---

Restate your last message. Stop using jargon and speak coherently. State it more simply and concisely, like one human talking to another.
```


## Batch interaction

```
Only stop when you need my judgement, batch your questions, so we can save interaction times.
```

## Git commit related

```
git commit and push changes, only related to this session, keep unrelated change untouched.
```

## Show State Board

```
Show me your state board, including CLOSED, NOW, NEXT, TODO, BLOCKED, BACKLOG, MAINLINE
```


## Reply in Chinese

```
Reply in Chinese while retaining key technical terms in English.
```

## I have ADHD

```
# ADHD-friendly response mode

Use the following communication style for the rest of this conversation, until I say “turn off ADHD-friendly mode.”

Treat these as my response preferences—not assumptions about every person with ADHD. My explicit request in each message takes priority. Correctness, safety, necessary context, and meaningful uncertainty override these formatting preferences.

## Default style

- Start with the direct answer or, for an actionable task, the smallest useful next action. Skip filler and commentary about how you will answer.
- Be concise but complete. Use short paragraphs and clear headings when they improve scanning.
- Use numbered lists for sequences and bullets for options or facts. Make each step one bounded action, and include exact commands, paths, examples, or wording when available.
- Aim for five or fewer items in an immediate action list. Group additional material under “Later” or “Optional” rather than omitting anything necessary.
- In multi-turn work, briefly show the state with labels such as “Done,” “Now,” and “Next.” Do not repeat context that is already obvious.
- Finish the current goal before raising related issues. Keep tangents out of the main answer.
- When something is completed, make the concrete result easy to spot.
- Explain errors neutrally in this order: what failed → likely cause → next check or fix.
- Give a time estimate only when it is useful and supportable. Use a range plus assumptions; do not invent precision.
- If work remains, end with one small, concrete next action. If no action is needed, end when the answer is complete.

## Adapt to the task

- For explanations, comparisons, reviews, or brainstorming, lead with the conclusion and provide enough detail. Do not force informational answers into action steps.
- If ambiguity would materially change the answer, ask one focused question.
- Before destructive, irreversible, expensive, or security-sensitive actions, explain the risk and ask for confirmation.
- If repeated fixes have not worked, stop proposing minor variations. Identify the assumption most likely to be wrong and ask for one diagnostic result.
- Do not remove important caveats, oversimplify, or use a patronizing tone for the sake of brevity.
- Use a direct, respectful, adult-to-adult tone. Brief warmth is welcome when the situation calls for it.
- Do not mention this mode or my ADHD unless it is directly relevant.

## Before sending

Remove filler openings, repeated conclusions, unnecessary side notes, vague next steps, and generic closers such as “let me know if you need anything else.”

Make the answer or current state—and the next useful action, when one exists—immediately visible.
```




## IV-DC

```
# RFC: IV/DC Agentic Workspace

## Purpose

This repository uses Markdown documents as a cognitive workspace for humans
and LLM coding agents. The system preserves intent, guides attention, enables
progressive disclosure, records reproducible evidence, and supports safe
feature retirement.

It is intentionally not a formal database or deterministic dependency system.
Use reasoning, repository search, verification, and human judgment.

## Document dimensions

### IV — Initiative

An IV is the lifecycle entry point for a user need, campaign, issue, or major
system change. It records the relevant requirements, external knowledge,
important facts, assumptions, decisions, non-goals, implementation locations,
known consumers, evidence, and reproduction methods.

The IV explains why related repository artifacts exist.

When an IV grows beyond one coherent working context, split cognitively local
parts into child documents. Keep a summary and annotated link in the parent.
Every child must link back to its root IV.

Split by semantic and domain locality, not merely by file length. Merge files
when they are almost always read or changed together.

### DC — Doctrine

A DC records horizontal engineering doctrine that may influence many
initiatives: conventions, reasoning principles, verification loops, recurring
constraints, and lessons learned.

Doctrines guide intelligent judgment. They are not a deterministic policy
engine.

## Links

Links are attention routes and lifecycle clues, not formally typed pointers.

Use links to show:

- where detailed context lives;
- where implementation lives;
- which initiatives consume shared behavior;
- which evidence or reproduction method applies;
- what replaced or superseded something.

Prefer annotated links that explain when the target should be read.

## Evidence

Record important evidence near the relevant claim:

- the observed result;
- the command or procedure that reproduces it;
- any environment assumptions needed to rerun it.

Results may become stale. Rerun the reproduction method when current truth
matters. Preserve the reproduction path more carefully than the old result.

## Time

Use logical time only. Clearly mark or remove information that is retired,
superseded, moved, or stale. Use revision notes only for semantically important
transitions; Git provides detailed history.

## Agent workflow

Before changing the repository:

1. Locate and read the relevant root IV.
2. Follow only the child links relevant to the task.
3. Read applicable DCs.
4. Inspect linked code and search for additional dependencies or consumers.
5. Confirm the intended outcome and non-goals.

While changing the repository:

1. Keep IVs, child documents, code, and evidence consistent.
2. Return to the root IV to prevent interpretation drift.
3. Update reproduction methods when verification procedures change.
4. Preserve cognitive locality when splitting, moving, or merging documents.

When retiring an initiative:

1. Start from the root IV.
2. Follow its links through documents, code, tests, configuration,
   infrastructure, data, APIs, jobs, dashboards, and other artifacts.
3. Search the repository for unlinked consumers and dynamic dependencies.
4. Identify behavior still required by other initiatives.
5. Delete only what no longer has lifecycle justification.
6. Run the strongest practical verification loops.
7. Mark, move, or delete the retired IV and remove stale links.

## Core principle

Markdown is the repository’s durable memory and attention map.
The agent supplies interpretation and intelligence.
IVs organize reality vertically by intent and lifecycle.
DCs organize behavior horizontally by doctrine.
Progressive disclosure keeps each working context cognitively coherent.
```


## update upstream and plan updates

```
Pull the latest upstream source and changelog, compare them with the current repository baseline, and identify new features, breaking changes, deprecations, removed APIs,
compatibility risks, and stale documentation or dependencies. Sweep the repository for affected code and references, then propose a concise update plan with files, rationale,
validation steps, and deferred items. Do not modify files or run state-changing commands until I explicitly reply “go”; treat every other reply as feedback to revise the plan.
```

## Improve prompt

```
Improve the following prompt, this is for instructing coding agent in claude code.
Only 1 paragraph. Minimal format.
```

## Dev plan

```
Propose a plan (files affected, approach) before making any changes.
Read-only exploration is fine, but don't edit files or run state-modifying commands until I approve with "go", 
any other reply is feedback to revise the plan.
```

### 10 level of expertise

```
Help me design 10 level of skills/expertise to understand a javascript or typescript project

I don't want some game titles, but pragmatic names, each <= 3 words.
and with detailed explanation 

language lawyer or standard sharper are not needed in this spectrum, we are not asking the skill on the language itself, but what engineering project one can work on. 

Real world projects requires more knowledge than only knowing the syntax. Also people usually use a subset of syntax in real world projects.

Give me 10 levels of "cracked" open source projects, with code example to illustrate how sick the skill in this level is.


Anchor:
	Level 1 is 100-level undergraduate student.
	Level 10 is "only that domain, that project expert, with years of prior knowledge, sophisticated training, implicit knowledge, can ever understand or maintain"

```

### unknown unknowns

```
I'm working on adding a new auth provider but I know nothing about the auth modules in this codebase. Can you do a blindspot pass to help me figure out my relevant unknown unknowns and help me prompt you better.
I don’t know what color grading is but I need to grade this video. Can you teach me to understand my unknown unknowns about color grading, so that I can prompt better?
```
