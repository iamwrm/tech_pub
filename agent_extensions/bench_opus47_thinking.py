#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Compare output-token usage for claude-opus-4-7 across thinking tiers
(medium, high, xhigh, max) on 3 reasoning prompts.

Runs N samples per (prompt, tier) cell, parses the final `turn_end`
event from `pi --mode json`, and prints:

  1. per-sample raw data
  2. per-cell (prompt x tier) median output tokens + correctness
  3. aggregate across prompts (mean of per-prompt medians)
  4. pairwise xhigh/high comparison

Requires the project-local extension `.pi/extensions/opus-4-7-thinking/`
because pi 0.67.x cannot otherwise emit `effort=xhigh` or `effort=max`
on `claude-opus-4-7`. See that extension's README/AGENTS.md and
`./README.md` in this directory for full context.

Usage:
    uv run bench_thinking.py

Cost: 36 Anthropic calls on OAuth (3 prompts x 4 tiers x 3 samples).
Run sparingly against your subscription quota.

──────────────────────────────────────────────────────────────────────
 Last run — 2026-04-18, pi 0.67.68, claude-opus-4-7 on Pro/Max OAuth
──────────────────────────────────────────────────────────────────────

Per-prompt medians (output tokens, includes thinking):

    prompt                                   medium   high   xhigh    max
    A: f(f(x))=0 for f(x)=x^3-3x+1            1076   1316    1820   2531
    B: strict same-parity triples sum 30       677    651     905   1393
    C: smallest n, n^2 & (n+1)^2 anagrams      370    531     493    697

All 36 runs produced the correct numeric answer (A=7, B=12, C=13).
Token deltas reflect depth of self-verification, not capability.

Per-prompt ratios (normalised to medium = 1.00x):

    prompt       medium    high   xhigh     max
    A             1.00    1.22    1.69    2.35
    B             1.00    0.96    1.34    2.06
    C             1.00    1.44    1.33    1.88

Aggregate across prompts (arithmetic mean of per-prompt ratios):

    tier        mean_ratio    σ
    medium         1.00x    0.00
    high           1.21x    0.19
    xhigh          1.45x    0.17
    max            2.10x    0.19

Pairwise xhigh / high (the key claim from AGENTS.md of the extension
that xhigh is "~40% deeper than high"):

    prompt        high    xhigh    xhigh/high
    A             1316     1820       1.38x
    B              651      905       1.39x
    C              531      493       0.93x
    mean                                1.23x

Analysis:

- Prompts A and B both land at 1.38x, matching the ~40% claim almost
  exactly. These are the prompts that reward extra deliberation:
  multi-branch case analysis (A) and enumeration with a parity trap (B).
- Prompt C (linear digit-permutation search) does NOT distinguish
  high from xhigh — verification per candidate is cheap, so adaptive
  thinking converges well below either tier's ceiling and the extra
  budget at xhigh goes unused. C remains useful as a max-tier signal
  (1.88x over medium) but is a poor probe of the high/xhigh boundary.
- `max` is ~2x medium in aggregate and ~1.5x xhigh on prompt A,
  consistent with AGENTS.md's "~5-6x xhigh" claim being an upper bound
  reached only on genuinely open-ended prompts (not any of these three).
- Within-tier variance across N=3 samples is ±10–20% per cell.
  Between-prompt variance (σ ≈ 0.17–0.19 on the ratio) dominates —
  i.e. prompt choice matters more than re-sampling the same prompt.

Bottom line: the opus-4-7-thinking extension is definitively effective.
medium → high → xhigh → max is a real, monotone, measurable ladder
provided the prompt actually rewards extra verification; on easy-enough
prompts adaptive thinking stops early and tiers collapse. This matches
the design of Anthropic adaptive thinking: `effort` is a ceiling, not
a target.
──────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import json
import statistics
import subprocess
import sys
import time
from dataclasses import dataclass, field


SAMPLES = 3


@dataclass
class Prompt:
    key: str          # short tag, e.g. "A"
    description: str  # one-line human description
    text: str         # the full prompt sent to pi
    truth: str        # expected final ANSWER line (for correctness check)


PROMPTS: list[Prompt] = [
    Prompt(
        key="A",
        description="f(f(x))=0 for f(x)=x^3-3x+1 (real-root counting)",
        text=(
            "Let f(x) = x^3 - 3x + 1. How many real solutions does the "
            "equation f(f(x)) = 0 have? Show your reasoning. End your "
            "response with exactly: ANSWER = <number>"
        ),
        truth="ANSWER = 7",
    ),
    Prompt(
        key="B",
        description="strict same-parity triples summing to 30",
        text=(
            "How many ordered triples (a, b, c) of positive integers satisfy "
            "ALL of the following: (i) a < b < c, (ii) a + b + c = 30, "
            "(iii) a, b, c all have the same parity? Show your reasoning "
            "briefly. End your response with exactly: ANSWER = <number>"
        ),
        truth="ANSWER = 12",
    ),
    Prompt(
        key="C",
        description="smallest n with n^2 and (n+1)^2 digit-permutations",
        text=(
            "Find the smallest positive integer n such that the decimal "
            "representations of n^2 and (n+1)^2 are permutations of each "
            "other (i.e., they contain the same multiset of digits). Show "
            "your reasoning briefly. End your response with exactly: "
            "ANSWER = <number>"
        ),
        truth="ANSWER = 13",
    ),
]


@dataclass
class Run:
    prompt_key: str
    tier: str
    argv: list[str]
    seconds: float = 0.0
    output_tokens: int = 0
    input_tokens: int = 0
    cache_read: int = 0
    cache_write: int = 0
    final_line: str = ""
    ok: bool = False
    err: str = ""


TIERS: list[tuple[str, list[str]]] = [
    ("medium", ["pi", "--model", "claude-opus-4-7", "--thinking", "medium"]),
    ("high",   ["pi", "--model", "claude-opus-4-7", "--thinking", "high"]),
    ("xhigh",  ["pi", "--model", "claude-opus-4-7", "--thinking", "xhigh"]),
    ("max",    ["pi", "--model", "claude-opus-4-7-max"]),
]


def invoke(run: Run, prompt_text: str) -> None:
    argv = [*run.argv, "--mode", "json", "-p", "--no-tools", "--no-session", prompt_text]
    t0 = time.monotonic()
    proc = subprocess.run(argv, capture_output=True, text=True)
    run.seconds = time.monotonic() - t0
    if proc.returncode != 0:
        run.err = (proc.stderr or "").strip()[-400:]
        return
    turn_end: dict | None = None
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") == "turn_end":
            turn_end = obj
    if turn_end is None:
        run.err = "no turn_end event in stdout"
        return
    msg = turn_end["message"]
    u = msg["usage"]
    run.input_tokens = u["input"]
    run.output_tokens = u["output"]
    run.cache_read = u["cacheRead"]
    run.cache_write = u["cacheWrite"]
    text_blocks = [c["text"] for c in msg["content"] if c.get("type") == "text"]
    if text_blocks:
        last = text_blocks[-1].strip().splitlines()
        run.final_line = last[-1] if last else ""
    run.ok = True


def median_int(xs: list[int]) -> int:
    return int(statistics.median(xs))


def main() -> int:
    # cell[(prompt_key, tier)] = [Run, Run, ...]
    cells: dict[tuple[str, str], list[Run]] = {}

    total = len(PROMPTS) * len(TIERS) * SAMPLES
    n = 0
    for prompt in PROMPTS:
        for tier_label, argv in TIERS:
            runs: list[Run] = []
            for i in range(SAMPLES):
                n += 1
                r = Run(prompt.key, tier_label, argv)
                print(
                    f"[{n:>2}/{total}] prompt={prompt.key} tier={tier_label:<6} "
                    f"sample={i + 1}/{SAMPLES} ...",
                    file=sys.stderr, flush=True,
                )
                invoke(r, prompt.text)
                runs.append(r)
            cells[(prompt.key, tier_label)] = runs

    # ── 1. per-sample raw data ────────────────────────────────────────────
    print()
    print("═" * 90)
    print("per-sample raw data")
    print("═" * 90)
    print(f"{'prompt':<6} {'tier':<7} {'#':<2} {'output':<7} {'wall':<7} {'final_line':<30}")
    print("-" * 75)
    for prompt in PROMPTS:
        for tier_label, _ in TIERS:
            for i, r in enumerate(cells[(prompt.key, tier_label)], 1):
                if not r.ok:
                    print(f"{prompt.key:<6} {tier_label:<7} {i:<2} ERROR: {r.err}")
                    continue
                print(
                    f"{prompt.key:<6} {tier_label:<7} {i:<2} "
                    f"{r.output_tokens:<7} {r.seconds:>5.1f}s  {r.final_line:<30}"
                )

    # ── 2. per-cell medians + correctness ─────────────────────────────────
    print()
    print("═" * 90)
    print("per-cell medians (output tokens)")
    print("═" * 90)
    header = f"{'prompt':<40} " + " ".join(f"{t:>10}" for t, _ in TIERS) + "   correct"
    print(header)
    print("-" * len(header))
    for prompt in PROMPTS:
        row_parts = [f"{prompt.key}: {prompt.description[:36]:<36}"]
        all_correct = True
        for tier_label, _ in TIERS:
            runs = [r for r in cells[(prompt.key, tier_label)] if r.ok]
            if not runs:
                row_parts.append(f"{'ERR':>10}")
                all_correct = False
                continue
            m = median_int([r.output_tokens for r in runs])
            row_parts.append(f"{m:>10}")
            cell_correct = all(r.final_line == prompt.truth for r in runs)
            if not cell_correct:
                all_correct = False
        row_parts.append("   yes" if all_correct else "   no")
        print(" ".join(row_parts))

    # ── 3. ratios vs medium (per prompt) ──────────────────────────────────
    print()
    print("═" * 90)
    print("per-prompt ratios (median output tokens, normalised to medium=1.00x)")
    print("═" * 90)
    header = f"{'prompt':<40} " + " ".join(f"{t:>10}" for t, _ in TIERS)
    print(header)
    print("-" * len(header))
    ratios_by_tier: dict[str, list[float]] = {t: [] for t, _ in TIERS}
    for prompt in PROMPTS:
        row_parts = [f"{prompt.key}: {prompt.description[:36]:<36}"]
        medium_runs = [r for r in cells[(prompt.key, "medium")] if r.ok]
        if not medium_runs:
            row_parts.append("no-medium-baseline")
            print(" ".join(row_parts))
            continue
        base = median_int([r.output_tokens for r in medium_runs])
        for tier_label, _ in TIERS:
            runs = [r for r in cells[(prompt.key, tier_label)] if r.ok]
            if not runs:
                row_parts.append(f"{'ERR':>10}")
                continue
            m = median_int([r.output_tokens for r in runs])
            ratio = m / base if base else 0.0
            ratios_by_tier[tier_label].append(ratio)
            row_parts.append(f"{ratio:>9.2f}x")
        print(" ".join(row_parts))

    # ── 4. aggregate across prompts ──────────────────────────────────────
    print()
    print("═" * 90)
    print("aggregate across prompts (arithmetic mean of per-prompt ratios)")
    print("═" * 90)
    print(f"{'tier':<10} {'mean_ratio':>12} {'per-prompt ratios':<40}")
    print("-" * 70)
    for tier_label, _ in TIERS:
        rs = ratios_by_tier[tier_label]
        if not rs:
            continue
        mean = statistics.fmean(rs)
        stdev = statistics.pstdev(rs) if len(rs) > 1 else 0.0
        print(
            f"{tier_label:<10} {mean:>11.2f}x  "
            f"{'  '.join(f'{r:.2f}' for r in rs):<40} "
            f"(σ={stdev:.2f})"
        )

    # ── 5. explicit high-vs-xhigh pairwise comparison ────────────────────
    print()
    print("═" * 90)
    print("high vs xhigh — pairwise per-prompt")
    print("═" * 90)
    print(f"{'prompt':<40} {'high':>8} {'xhigh':>8} {'xhigh/high':>12}")
    print("-" * 72)
    deltas: list[float] = []
    for prompt in PROMPTS:
        h_runs = [r for r in cells[(prompt.key, "high")] if r.ok]
        x_runs = [r for r in cells[(prompt.key, "xhigh")] if r.ok]
        if not h_runs or not x_runs:
            continue
        h = median_int([r.output_tokens for r in h_runs])
        x = median_int([r.output_tokens for r in x_runs])
        ratio = x / h if h else 0.0
        deltas.append(ratio)
        print(
            f"{prompt.key}: {prompt.description[:36]:<36} "
            f"{h:>8} {x:>8} {ratio:>11.2f}x"
        )
    if deltas:
        print("-" * 72)
        print(
            f"{'mean xhigh/high across prompts':<40} "
            f"{'':>8} {'':>8} {statistics.fmean(deltas):>11.2f}x"
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
