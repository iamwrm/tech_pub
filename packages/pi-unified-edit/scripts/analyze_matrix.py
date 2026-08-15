#!/usr/bin/env python3
"""Analyze an E1-E24 model × edit-mode matrix.

The current runner writes ``run-metrics.json`` beside each fresh pi session.
This script combines final-state verdicts and settled wall time with the
assistant-message ``usage`` blocks from pi's JSONL session store.

Example:
    python3 scripts/analyze_matrix.py --tag five-20260815 \
      --output local_data/edit-ab/results/five-20260815
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import math
import os
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent.parent
DEFAULT_RUNS = REPO_ROOT / "local_data" / "edit-ab" / "runs"
MODES = ("rows", "patch", "code", "pi", "hash")
USAGE_KEYS = ("input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens")
MODEL_ALIASES = {
    "opencode-go/deepseek-v4-flash": "ds",
    "openai-codex/gpt-5.6-sol": "sol",
    "openai-codex/gpt-5.6-luna": "luna",
    "fluxion-claude/claude-opus-5": "opus",
}


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def mean(values: list[float]) -> float | None:
    return statistics.mean(values) if values else None


def parse_session(workdir: Path) -> dict[str, Any] | None:
    sessions = sorted((workdir / ".pi-session").glob("*.jsonl"))
    if not sessions:
        return None
    usage: dict[str, int | float] = {key: 0 for key in USAGE_KEYS}
    usage["cost"] = 0.0
    assistant_messages = 0
    messages_without_usage = 0
    edit_calls = 0
    read_calls = 0
    stop_reasons: Counter[str] = Counter()
    thinking_level: str | None = None

    for session in sessions:
        with session.open(encoding="utf-8") as handle:
            for raw in handle:
                try:
                    entry = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if entry.get("type") == "thinking_level_change":
                    thinking_level = str(entry.get("thinkingLevel") or "") or thinking_level
                    continue
                if entry.get("type") != "message":
                    continue
                message = entry.get("message") or {}
                if message.get("role") != "assistant":
                    continue
                assistant_messages += 1
                reason = message.get("stopReason")
                if reason:
                    stop_reasons[str(reason)] += 1
                current = message.get("usage")
                if not current:
                    messages_without_usage += 1
                else:
                    for key in USAGE_KEYS:
                        usage[key] += int(current.get(key, 0) or 0)
                    usage["cost"] += float((current.get("cost") or {}).get("total", 0) or 0)
                for part in message.get("content") or []:
                    if not isinstance(part, dict):
                        continue
                    name = part.get("name")
                    if name == "edit":
                        edit_calls += 1
                    if name in {"read", "grep", "find", "ls", "bash", "exec_command", "view"}:
                        read_calls += 1

    return {
        **usage,
        "assistant_messages": assistant_messages,
        "messages_without_usage": messages_without_usage,
        "edit_calls": edit_calls,
        "read_calls": read_calls,
        "stop_reasons": dict(stop_reasons),
        "thinking_level": thinking_level,
    }


def load_records(runs: Path, tag: str) -> tuple[list[dict[str, Any]], list[str]]:
    newest: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    warnings: list[str] = []
    for metrics_path in sorted(runs.glob("*-workdir/run-metrics.json")):
        try:
            metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            warnings.append(f"unreadable metrics {metrics_path}: {error}")
            continue
        if metrics.get("matrix_tag") != tag:
            continue
        mode = metrics.get("mode")
        if mode not in MODES:
            warnings.append(f"unknown mode in {metrics_path}: {mode!r}")
            continue
        provider = str(metrics.get("provider", ""))
        model = str(metrics.get("model", ""))
        case = str(metrics.get("case", ""))
        key = (provider, model, mode, case)
        workdir = metrics_path.parent
        session = parse_session(workdir)
        model_alias = MODEL_ALIASES.get(f"{provider}/{model}", f"{provider}/{model}")
        thinking_level = session.get("thinking_level") if session else None
        record = {
            **metrics,
            "workdir": str(workdir),
            "model_id": f"{provider}/{model}",
            "model_short": f"{model_alias}:{thinking_level}" if thinking_level else model_alias,
            "thinking_level": thinking_level,
            "passed": metrics.get("verdict") == "PASS",
            "settled": str(metrics.get("runner_state", "")).startswith("settled:")
            and str(metrics.get("runner_state", "")) not in {"settled:error", "settled:aborted"},
            "usage_available": session is not None and session.get("assistant_messages", 0) > 0,
            "usage": session,
        }
        prior = newest.get(key)
        if prior is None or str(record.get("ended_at", "")) >= str(prior.get("ended_at", "")):
            newest[key] = record
    return sorted(newest.values(), key=lambda row: (row["model_short"], row["mode"], row["case"])), warnings


def aggregate(records: list[dict[str, Any]]) -> dict[str, Any]:
    settled = [row for row in records if row["settled"]]
    usage_rows = [row for row in settled if row["usage_available"]]
    wall = [float(row["wall_time_seconds"]) for row in settled]
    tokens = [int(row["usage"]["totalTokens"]) for row in usage_rows]
    edits = [int(row["usage"]["edit_calls"]) for row in usage_rows]
    usage_totals = {
        key: sum(float(row["usage"][key]) for row in usage_rows)
        for key in (*USAGE_KEYS, "cost")
    }
    return {
        "runs": len(records),
        "passes": sum(bool(row["passed"]) for row in records),
        "pass_rate": (sum(bool(row["passed"]) for row in records) / len(records)) if records else None,
        "settled_runs": len(settled),
        "infra_runs": len(records) - len(settled),
        "usage_runs": len(usage_rows),
        "one_edit_runs": sum(value == 1 for value in edits),
        "one_edit_passes": sum(row["passed"] and int(row["usage"]["edit_calls"]) == 1 for row in usage_rows),
        "zero_edit_runs": sum(value == 0 for value in edits),
        "multi_edit_runs": sum(value >= 2 for value in edits),
        "edit_calls_total": sum(edits),
        "wall_seconds": {
            "mean": mean(wall),
            "median": median(wall),
            "p95": percentile(wall, 0.95),
            "total": sum(wall),
        },
        "tokens": {
            "mean": mean(tokens),
            "median": median(tokens),
            "p95": percentile([float(value) for value in tokens], 0.95),
            "total": sum(tokens),
        },
        "usage_totals": usage_totals,
    }


def fnum(value: float | int | None, digits: int = 1) -> str:
    if value is None:
        return "—"
    return f"{value:,.{digits}f}"


def fpct(value: float | None) -> str:
    return "—" if value is None else f"{100 * value:.1f}%"


def build_report(tag: str, records: list[dict[str, Any]], warnings: list[str]) -> tuple[dict[str, Any], str]:
    model_rank = {"ds": 0, "sol": 1, "luna": 2, "opus": 3}
    models = sorted(
        {row["model_short"] for row in records},
        key=lambda model: (model_rank.get(model.split(":", 1)[0], len(model_rank)), model),
    )
    by_mode = {mode: aggregate([row for row in records if row["mode"] == mode]) for mode in MODES}
    by_model_mode = {
        model: {mode: aggregate([row for row in records if row["model_short"] == model and row["mode"] == mode]) for mode in MODES}
        for model in models
    }
    cases = sorted({row["case"] for row in records})
    outcome_by_mode = {
        mode: {(row["model_short"], row["case"]): bool(row["passed"]) for row in records if row["mode"] == mode}
        for mode in MODES
    }
    hash_comparisons: dict[str, dict[str, Any]] = {}
    for baseline in ("rows", "patch", "code", "pi"):
        common = sorted(set(outcome_by_mode["hash"]) & set(outcome_by_mode[baseline]))
        hash_comparisons[baseline] = {
            "hash_wins": sum(outcome_by_mode["hash"][key] and not outcome_by_mode[baseline][key] for key in common),
            "hash_losses": sum(not outcome_by_mode["hash"][key] and outcome_by_mode[baseline][key] for key in common),
            "ties": sum(outcome_by_mode["hash"][key] == outcome_by_mode[baseline][key] for key in common),
        }
    without_e22 = {
        mode: aggregate([row for row in records if row["mode"] == mode and row["case"] != "e22-wrong-case"])
        for mode in MODES
    }
    expected = len(models) * len(MODES) * len(cases)
    report = {
        "schema_version": 1,
        "matrix_tag": tag,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "models": models,
        "modes": list(MODES),
        "cases": cases,
        "expected_runs": expected,
        "observed_runs": len(records),
        "warnings": warnings,
        "by_mode": by_mode,
        "by_model_mode": by_model_mode,
        "hash_comparisons": hash_comparisons,
        "without_e22": without_e22,
        "records": records,
    }

    lines = [
        f"# pi-unified-edit model × mode matrix: `{tag}`",
        "",
        f"Generated {report['generated_at']}. Observed **{len(records)}/{expected}** latest runs "
        f"({len(models)} models × {len(MODES)} modes × {len(cases)} cases).",
        "",
        f"Model configurations: {', '.join(f'`{model}`' for model in models)}.",
        "",
        "Pass rate is the deterministic final-state checker result. Wall time is prompt submission to a "
        "settled assistant stop and excludes runner timeouts/stalls. Token usage sums each settled session's "
        "assistant-message `usage.totalTokens`; totals also retain input/output/cache/reasoning breakdowns.",
        "Historical `four` totals are not directly comparable: that runner stopped when the checker first passed "
        "instead of waiting for assistant settlement and did not record per-run wall time. Comparisons below use "
        "only this five-mode rerun's uniform measurement path.",
        "",
        "## Headline mode summary",
        "",
        "| mode | pass rate | wall median / mean / p95 | total tokens |",
        "|---|---:|---:|---:|",
    ]
    for mode in MODES:
        item = by_mode[mode]
        lines.append(
            f"| {mode} | {item['passes']}/{item['runs']} ({fpct(item['pass_rate'])}) | "
            f"{fnum(item['wall_seconds']['median'])} / {fnum(item['wall_seconds']['mean'])} / "
            f"{fnum(item['wall_seconds']['p95'])}s | {item['tokens']['total'] / 1_000_000:.3f}M |"
        )

    lines += [
        "",
        "## All models combined",
        "",
        "| mode | pass | pass rate | settled | infra | one-edit pass | wall median | wall mean | wall p95 | tokens median | tokens mean | tokens total |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for mode in MODES:
        item = by_mode[mode]
        lines.append(
            f"| {mode} | {item['passes']}/{item['runs']} | {fpct(item['pass_rate'])} | "
            f"{item['settled_runs']} | {item['infra_runs']} | {item['one_edit_passes']}/{item['usage_runs']} | "
            f"{fnum(item['wall_seconds']['median'])}s | {fnum(item['wall_seconds']['mean'])}s | "
            f"{fnum(item['wall_seconds']['p95'])}s | {fnum(item['tokens']['median'], 0)} | "
            f"{fnum(item['tokens']['mean'], 0)} | {fnum(item['tokens']['total'], 0)} |"
        )

    lines += [
        "",
        "## Hash compared with each prior mode",
        "",
        "Deltas are hash relative to the baseline. Paired W/L/T compares final-state outcomes for the same model and case.",
        "",
        "| baseline | pass-rate delta | paired W/L/T | mean-wall delta | median-wall delta | p95-wall delta | token-total delta |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    hash_item = by_mode["hash"]
    for baseline in ("rows", "patch", "code", "pi"):
        base = by_mode[baseline]
        paired = hash_comparisons[baseline]
        def delta(current: float | None, prior: float | None) -> str:
            if current is None or prior in (None, 0):
                return "—"
            return f"{100 * (current / prior - 1):+.1f}%"
        pass_delta = 100 * ((hash_item["pass_rate"] or 0) - (base["pass_rate"] or 0))
        lines.append(
            f"| {baseline} | {pass_delta:+.1f} pp | {paired['hash_wins']}/{paired['hash_losses']}/{paired['ties']} | "
            f"{delta(hash_item['wall_seconds']['mean'], base['wall_seconds']['mean'])} | "
            f"{delta(hash_item['wall_seconds']['median'], base['wall_seconds']['median'])} | "
            f"{delta(hash_item['wall_seconds']['p95'], base['wall_seconds']['p95'])} | "
            f"{delta(hash_item['tokens']['total'], base['tokens']['total'])} |"
        )

    lines += [
        "",
        "### Sensitivity: exclude E22's deliberately wrong-case instruction",
        "",
        "| mode | pass | pass rate |",
        "|---|---:|---:|",
    ]
    for mode in MODES:
        item = without_e22[mode]
        lines.append(f"| {mode} | {item['passes']}/{item['runs']} | {fpct(item['pass_rate'])} |")

    mode_header = "| model | " + " | ".join(MODES) + " |"
    mode_rule = "|---|" + "---:|" * len(MODES)
    lines += [
        "",
        "## Model × mode (2D)",
        "",
        "### Pass rate",
        "",
        mode_header,
        mode_rule,
    ]
    for model in models:
        cells = [f"{by_model_mode[model][mode]['passes']}/{by_model_mode[model][mode]['runs']}" for mode in MODES]
        lines.append(f"| {model} | " + " | ".join(cells) + " |")

    lines += ["", "### Mean walltime per case", "", mode_header, mode_rule]
    for model in models:
        cells = [f"{fnum(by_model_mode[model][mode]['wall_seconds']['mean'])}s" for mode in MODES]
        lines.append(f"| {model} | " + " | ".join(cells) + " |")

    lines += ["", "### Mean token usage per case", "", mode_header, mode_rule]
    for model in models:
        cells = [f"{by_model_mode[model][mode]['tokens']['mean'] / 1_000:.1f}k" for mode in MODES]
        lines.append(f"| {model} | " + " | ".join(cells) + " |")

    lines += ["", "## Per-model detail", ""]
    for model in models:
        lines += [
            f"### {model}",
            "",
            "| mode | pass rate | wall median | wall mean | tokens median | tokens mean | edit calls |",
            "|---|---:|---:|---:|---:|---:|---:|",
        ]
        for mode in MODES:
            item = by_model_mode[model][mode]
            lines.append(
                f"| {mode} | {item['passes']}/{item['runs']} ({fpct(item['pass_rate'])}) | "
                f"{fnum(item['wall_seconds']['median'])}s | {fnum(item['wall_seconds']['mean'])}s | "
                f"{fnum(item['tokens']['median'], 0)} | {fnum(item['tokens']['mean'], 0)} | "
                f"{item['edit_calls_total']} |"
            )
        lines.append("")

    lines += [
        "## Token-usage totals",
        "",
        "| mode | input | output | reasoning | cache read | cache write | total tokens | usage cost |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for mode in MODES:
        totals = by_mode[mode]["usage_totals"]
        lines.append(
            f"| {mode} | {fnum(totals['input'], 0)} | {fnum(totals['output'], 0)} | "
            f"{fnum(totals['reasoning'], 0)} | {fnum(totals['cacheRead'], 0)} | "
            f"{fnum(totals['cacheWrite'], 0)} | {fnum(totals['totalTokens'], 0)} | "
            f"${fnum(totals['cost'], 4)} |"
        )
    failures = [row for row in records if not row["passed"]]
    lines += [
        "",
        "## Failed final-state checks",
        "",
        "| model | mode | case | edit calls | wall |",
        "|---|---|---|---:|---:|",
    ]
    for row in failures:
        usage = row.get("usage") or {}
        lines.append(
            f"| {row['model_short']} | {row['mode']} | {row['case']} | {usage.get('edit_calls', '—')} | "
            f"{fnum(row.get('wall_time_seconds'))}s |"
        )
    if warnings:
        lines += ["", "## Warnings", ""] + [f"- {warning}" for warning in warnings]
    return report, "\n".join(lines) + "\n"


def write_csv(path: Path, records: list[dict[str, Any]]) -> None:
    fields = [
        "run_id", "case", "provider", "model", "model_short", "thinking_level", "mode", "verdict", "settled",
        "runner_state", "wall_time_seconds", "edit_calls", "read_calls", *USAGE_KEYS, "cost", "workdir",
    ]
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in records:
            usage = row.get("usage") or {}
            writer.writerow({
                **{key: row.get(key) for key in fields},
                "edit_calls": usage.get("edit_calls"),
                "read_calls": usage.get("read_calls"),
                **{key: usage.get(key) for key in (*USAGE_KEYS, "cost")},
            })


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True, help="matrix_tag written by run_five_modes.sh")
    parser.add_argument("--runs", type=Path, default=Path(os.environ.get("EDITAB_RUNS", DEFAULT_RUNS)))
    parser.add_argument("--output", type=Path, help="output directory (default: local_data/edit-ab/results/TAG)")
    args = parser.parse_args()
    output = args.output or (REPO_ROOT / "local_data" / "edit-ab" / "results" / args.tag)
    output.mkdir(parents=True, exist_ok=True)

    records, warnings = load_records(args.runs, args.tag)
    if not records:
        raise SystemExit(f"no run-metrics.json records found for matrix tag {args.tag!r} under {args.runs}")
    report, markdown = build_report(args.tag, records, warnings)
    (output / "summary.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    (output / "summary.md").write_text(markdown, encoding="utf-8")
    write_csv(output / "runs.csv", records)
    print(markdown)
    print(f"Artifacts: {output / 'summary.md'}, {output / 'summary.json'}, {output / 'runs.csv'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
