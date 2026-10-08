#!/usr/bin/env bash
# show_usd_per_mtok.sh - per-period, per-model blended $/MTok and prompt-cache
# hit rate from a ccusage report (daily, weekly, monthly, session).
#
# Usage:
#   npx ccusage@latest [daily|weekly|monthly|session] [--last N] -b [-j] | scripts/show_usd_per_mtok.sh
#   scripts/show_usd_per_mtok.sh [ccusage args...]   # no pipe: runs npx ccusage@latest <args> -j (default --last 2)
#
# stdin is auto-detected: JSON (ccusage -j, requires jq) or the rendered table
# (ccusage -b). Requires Node.js and the installed pi CLI for catalog pricing.
# Table input rounds USD to cents and may truncate model names as "…"
# (rows sharing a truncated name are merged); pipe -j for exact values.
#
# One row per period x model; periods are never merged. PERIOD is the date,
# week start, YYYY-MM, or session id as printed by ccusage.
#   total_tokens    input + output + cache_create + cache_read
#   usd             cost as reported by ccusage
#   cache_hit_rate  cache_read / (input + cache_create + cache_read); output excluded
#   $/MTOK          usd / total_tokens * 1e6 (blended; cache reads included)
#   $/MTOK_IN       installed Pi catalog's uncached input USD per million tokens
#                    (Pi rows by catalog match, Claude Code rows by the anthropic
#                    provider; N/A if unknown, ambiguous, or another agent; base tier only)
#   RATIO           $/MTOK / $/MTOK_IN (N/A without a list price)
#
# On a terminal the report is colored with zebra rows (scripts/usd_per_mtok_render.mjs).
#   USD_MTOK_THEME  auto (default: ask the terminal's background) | light | dark
# NO_COLOR, USD_MTOK_STYLE=plain, or a non-terminal stdout prints the plain table;
# FORCE_COLOR forces color.
set -euo pipefail

PROG=${0##*/}
die() { printf '%s: %s\n' "$PROG" "$*" >&2; exit 1; }
need_jq() { command -v jq >/dev/null 2>&1 || die "jq is required for JSON input but is not installed; install it (apt-get install jq / brew install jq) and re-run"; }

# ccusage JSON -> TSV: period, model, total_tokens, usd, cache_read, prompt_tokens
# (prompt_tokens = input + cache_create + cache_read, the cache hit rate denominator).
# With --by-agent the per-model rows live under .agents[]; use those to avoid double counting.
JQ='
  [ (.daily?, .weekly?, .monthly?, .session?) | arrays[] ] | .[]
  | (.period // "") as $p
  | (if (.agents? | type) == "array" and (.agents | length) > 0
     then .agents[].modelBreakdowns[]? else .modelBreakdowns[]? end)
  | select(type == "object" and .modelName != null)
  | [ $p, .modelName,
      ((.inputTokens // 0) + (.outputTokens // 0) + (.cacheCreationTokens // 0) + (.cacheReadTokens // 0)),
      (.cost // 0), (.cacheReadTokens // 0),
      ((.inputTokens // 0) + (.cacheCreationTokens // 0) + (.cacheReadTokens // 0)) ]
  | @tsv'

# ccusage table -> same TSV. Model rows start with "└─"/"├─" in the Models column and
# wrap onto continuation lines whose numeric columns are empty.
table_rows() {
  sed 's/│/|/g' | LC_ALL=C awk -F'|' '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function num(s)  { gsub(/[,$]/, "", s); return s + 0 }
    function flush() { if (rec && cur != "") printf "%s\t%s\t%s\t%s\t%s\t%s\n", per, cur, t, u, c, q; rec = 0; cur = "" }
    NF < 10 { flush(); next }
    {
      d = trim($2); m = trim($4)
      if (d ~ /^[0-9][0-9][0-9][0-9]$/) year = d                      # wrapped date: "2026" / "09-17"
      else if (d ~ /^[0-9][0-9](-[0-9][0-9])?$/ && year != "") period = year "-" d
      else if (d != "") period = d                                    # full date, YYYY-MM, or session id
      if (index(m, "└─") == 1 || index(m, "├─") == 1) {
        flush(); rec = 1; cur = trim(substr(m, 7)); per = period
        t = num($9); u = num($10); c = num($8); q = num($5) + num($7) + num($8); next
      }
      if (rec && m != "" && trim($5 $6 $7 $8 $9 $10) == "") { cur = trim(cur " " m); next }
      flush()
    }
    END { flush() }'
}

# TSV rows (sorted by period asc, tokens desc) with catalog input price -> aligned table with TOTAL.
render() {
  LC_ALL=C awk -F'\t' -v prog="$PROG" '
    function th(n,  s, o) { s = sprintf("%.0f", n); while (length(s) > 3) { o = "," substr(s, length(s) - 2) o; s = substr(s, 1, length(s) - 3) } return s o }
    function dw(s) { return length(s) - 2 * gsub(/…/, "", s) }          # display width under LC_ALL=C
    function pad(s, w) { return s sprintf("%*s", (w > dw(s) ? w - dw(s) : 0), "") }
    function money(x) { return x ~ /^[0-9.]+$/ ? sprintf("%.4f", x) : x }
    function ratio(r, x) { return x ~ /^[0-9.]+$/ && x + 0 > 0 ? sprintf("%.4f", r / x) : "N/A" }
    function line(p, m, t, u, c, q, price,  r) { r = t ? u / t * 1e6 : 0; printf "%s  %s  %14s %12.4f %11.1f%% %10.4f %10s %8s\n", pad(p, pw), pad(m, mw), th(t), u, (q ? c / q * 100 : 0), r, money(price), ratio(r, price) }
    { n++; P[n] = $1; M[n] = $2; T[n] = $3; U[n] = $4; C[n] = $5; Q[n] = $6; R[n] = $7; tt += $3; tu += $4; tc += $5; tq += $6
      if (dw($1) > pw) pw = dw($1); if (dw($2) > mw) mw = dw($2) }
    END {
      if (!n) { print prog ": no per-model rows in the report (pass -b for table output)" > "/dev/stderr"; exit 1 }
      if (pw < 6) pw = 6; if (mw < 5) mw = 5
      print "# period: " P[1] (P[n] != P[1] ? ".." P[n] : "")
      print "# TOTAL_TOKENS = input+output+cache_create+cache_read   CACHE_HIT% = cache_read/(input+cache_create+cache_read)"
      print "# $/MTOK = USD/TOTAL_TOKENS (blended)   $/MTOK_IN = catalog uncached input list price (base tier)   RATIO = $/MTOK / $/MTOK_IN"
      printf "%s  %s  %14s %12s %12s %10s %10s %8s\n", pad("PERIOD", pw), pad("MODEL", mw), "TOTAL_TOKENS", "USD", "CACHE_HIT%", "$/MTOK", "$/MTOK_IN", "RATIO"
      dash = sprintf("%*s", pw + mw + 75, ""); gsub(/ /, "-", dash); print dash
      for (i = 1; i <= n; i++) line(P[i], M[i], T[i], U[i], C[i], Q[i], R[i])
      print dash; line("TOTAL", "ALL", tt, tu, tc, tq, "N/A")
    }'
}

main() {
  case "${1:-}" in -h|--help) sed -n '2,/^set -/{/^set -/!{s/^# \{0,1\}//;p;};}' "$0"; exit 0;; esac
  local input
  if [ -t 0 ]; then
    need_jq
    local -a args=("$@"); [ $# -eq 0 ] && args=(--last 2)
    case " ${args[*]} " in *" -j "*|*" --json "*) ;; *) args+=(-j);; esac
    printf '%s: running npx --yes ccusage@latest %s\n' "$PROG" "${args[*]}" >&2
    input=$(npx --yes ccusage@latest "${args[@]}") || die "ccusage failed"
  else
    input=$(cat)
  fi
  [ -n "$(printf '%s' "$input" | tr -d '[:space:]')" ] || die "empty input (upstream ccusage command failed or printed nothing)"

  local rows
  if [[ "$input" =~ ^[[:space:]]*\{ ]]; then
    need_jq
    printf '%s' "$input" | jq -e 'has("daily") or has("weekly") or has("monthly") or has("session")' >/dev/null 2>&1 \
      || die "input JSON is not a ccusage report (expected daily/weekly/monthly/session keys)"
    rows=$(printf '%s' "$input" | jq -r "$JQ") || die "jq failed to parse the input"
  else
    grep -q '…' <<<"$input" && printf '%s: note: ccusage truncated some names as "…" (rows sharing a truncated name are merged); pipe -j for exact names\n' "$PROG" >&2
    rows=$(table_rows <<<"$input")
  fi
  local priced script_dir pi_command
  script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
  pi_command=$(command -v pi || true)
  priced=$(printf '%s\n' "$rows" | sed '/^$/d' | node "$script_dir/pi_input_prices.mjs" "$pi_command") \
    || die "could not read the installed Pi catalog"
  local sorted
  sorted=$(printf '%s\n' "$priced" | sort -t "$(printf '\t')" -k1,1 -k3,3nr)
  # Colored, zebra-striped view on a terminal; the plain aligned table otherwise
  # (pipes, files, NO_COLOR, or USD_MTOK_STYLE=plain) so output stays greppable.
  if [ "${USD_MTOK_STYLE:-}" != plain ] && [ -z "${NO_COLOR:-}" ] && { [ -t 1 ] || [ -n "${FORCE_COLOR:-}" ]; }; then
    printf '%s\n' "$sorted" | node "$script_dir/usd_per_mtok_render.mjs"
  else
    printf '%s\n' "$sorted" | render
  fi
}

main "$@"
