import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { inputPrice } from '../pi_input_prices.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const prices = fileURLToPath(new URL('./fixtures/pi-price-catalog.mjs', import.meta.url));
const models = [
  { provider: 'openai-codex', id: 'gpt-6-sol', cost: { input: 2, tiers: [{ inputTokensAbove: 272000, input: 4 }] } },
  { provider: 'openrouter', id: 'openai/gpt-6-sol', cost: { input: 2 } },
  { provider: 'fluxion', id: 'claude-opus-5-5', cost: { input: 0 } },
  { provider: 'openrouter', id: 'anthropic/claude-opus-5-5', cost: { input: 4 } },
  { provider: 'anthropic', id: 'claude-sonnet-5-5', cost: { input: 3 } },
  { provider: 'a', id: 'conflicting', cost: { input: 1 } },
  { provider: 'b', id: 'conflicting', cost: { input: 3 } },
];

function report(input, env = {}) {
  return spawnSync('bash', ['./scripts/show_usd_per_mtok.sh'], {
    cwd: root,
    input,
    encoding: 'utf8',
    env: { ...process.env, MIN_USD: '', PI_CATALOG_MODULE: prices, ...env },
  });
}

test('catalog matching uses base input price, not historical blended rate or tier', () => {
  assert.equal(inputPrice('[pi] gpt-6-sol', models), '2');
  assert.equal(inputPrice('[pi] claude-opus-5-5', models), '4');
  assert.equal(inputPrice('[pi] conflicting', models), 'N/A');
  assert.equal(inputPrice('[pi] claude-opus…', models), 'N/A');
  assert.equal(inputPrice('[prime-agent] gpt-6-sol', models), 'N/A');
  assert.equal(inputPrice('[pi] missing', models), 'N/A');
});

test('unprefixed Claude Code rows use only the first-party anthropic price', () => {
  assert.equal(inputPrice('claude-sonnet-5-5', models), '3');
  assert.equal(inputPrice('sonnet-5-5', models), '3');
  // Only an OpenRouter or zero-cost proxy entry exists: no first-party price.
  assert.equal(inputPrice('claude-opus-5-5', models), 'N/A');
  assert.equal(inputPrice('claude-sonnet…', models), 'N/A');
});

test('JSON report shows input list price beside blended rate and no total list price', () => {
  const result = report(JSON.stringify({ daily: [{ period: '2026-09-23', modelBreakdowns: [
    { modelName: '[pi] gpt-6-sol', inputTokens: 100, cacheReadTokens: 900, outputTokens: 0, cacheCreationTokens: 0, cost: 0.0004 },
    { modelName: '[pi] claude-opus-5-5', inputTokens: 100, cacheReadTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cost: 0.0004 },
    { modelName: '[pi] conflicting', inputTokens: 10, cost: 0.0001 },
    { modelName: 'claude-sonnet-5-5', inputTokens: 100, cacheReadTokens: 300, outputTokens: 600, cacheCreationTokens: 0, cost: 0.001 },
  ] }] }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\$\/MTOK\s+\$\/MTOK_IN\s+RATIO$/m);
  assert.match(result.stdout, /\[pi\] gpt-6-sol\s+1,000\s+0\.0004\s+90\.0%\s+0\.4000\s+2\.0000\s+0\.2000$/m);
  assert.match(result.stdout, /\[pi\] claude-opus-5-5\s+100\s+0\.0004\s+0\.0%\s+4\.0000\s+4\.0000\s+1\.0000$/m);
  assert.match(result.stdout, /\[pi\] conflicting\s+10\s+0\.0001\s+0\.0%\s+10\.0000\s+N\/A\s+N\/A$/m);
  // Output tokens are excluded from the cache hit denominator: 300 / (100 + 300).
  assert.match(result.stdout, /claude-sonnet-5-5\s+1,000\s+0\.0010\s+75\.0%\s+1\.0000\s+3\.0000\s+0\.3333$/m);
  // TOTAL hit: 1,200 cache reads / 1,510 prompt tokens.
  assert.match(result.stdout, /TOTAL\s+ALL\s+2,110\s+0\.0019\s+79\.5%\s+0\.9005\s+N\/A\s+N\/A$/m);
});

test('MIN_USD collapses cheap rows per period into a trailing "+N Models" row', () => {
  const input = JSON.stringify({ daily: [
    { period: '2026-09-23', modelBreakdowns: [
      { modelName: '[pi] gpt-6-sol', inputTokens: 100, cacheReadTokens: 900, cost: 5 },
      { modelName: '[pi] small-a', inputTokens: 50, cacheReadTokens: 50, cost: 0.2 },
      { modelName: '[pi] small-b', inputTokens: 5000, cost: 0.3 },
    ] },
    { period: '2026-09-24', modelBreakdowns: [
      { modelName: '[pi] gpt-6-sol', inputTokens: 100, cost: 3 },
      { modelName: '[pi] small-a', inputTokens: 10, cost: 0.1 },
    ] },
  ] });
  const result = report(input, { MIN_USD: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /small-/);
  // The merged row follows the period's kept rows even though it has more tokens.
  assert.match(result.stdout, /2026-09-23\s+\[pi\] gpt-6-sol.*\n2026-09-23\s+\+2 Models\s+5,100\s+0\.5000\s+1\.0%\s+98\.0392\s+N\/A\s+N\/A$/m);
  assert.match(result.stdout, /2026-09-24\s+\+1 Model\s+10\s+0\.1000\s+0\.0%\s+10000\.0000\s+N\/A\s+N\/A$/m);
  // TOTAL is unchanged by collapsing.
  assert.match(result.stdout, /TOTAL\s+ALL\s+6,210\s+8\.6000\s+15\.3%/);
  assert.match(report(input).stdout, /\[pi\] small-b/);
  assert.notEqual(report(input, { MIN_USD: 'abc' }).status, 0);
});

test('table input preserves parsing and does not price truncated identifiers', () => {
  const pipeRow = (date, model, input, output, read, total, cost) =>
    `│ ${date} │ pi-agent │ └─ ${model} │ ${input} │ ${output} │ 0 │ ${read} │ ${total} │ $${cost} │`;
  const result = report([
    pipeRow('2026-09-23', '[pi] gpt-6-sol', '100', '800', '900', '1,800', '0.01'),
    pipeRow('', '[pi] claude-opus…', '50', '0', '50', '100', '0.01'),
  ].join('\n'));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[pi\] gpt-6-sol\s+1,800\s+0\.0100\s+90\.0%\s+5\.5556\s+2\.0000\s+2\.7778$/m);
  assert.match(result.stdout, /\[pi\] claude-opus…\s+100\s+0\.0100\s+50\.0%\s+100\.0000\s+N\/A\s+N\/A$/m);
});

test('terminal view colors zebra rows from the forced theme; NO_COLOR keeps the plain table', () => {
  const input = JSON.stringify({ daily: [{ period: '2026-09-23', modelBreakdowns: [
    { modelName: '[pi] gpt-6-sol', inputTokens: 100, cacheReadTokens: 900, cost: 0.0004 },
    { modelName: '[pi] conflicting', inputTokens: 10, cost: 0.0001 },
    { modelName: 'claude-sonnet-5-5', inputTokens: 100, cacheReadTokens: 300, cost: 0.001 },
  ] }] });
  const run = (env) => spawnSync('bash', ['./scripts/show_usd_per_mtok.sh'], {
    cwd: root, input, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '', PI_CATALOG_MODULE: prices, COLORTERM: 'truecolor', COLUMNS: '160', ...env },
  });
  const colored = run({ FORCE_COLOR: '1', USD_MTOK_THEME: 'light' });
  assert.equal(colored.status, 0, colored.stderr);
  const lines = colored.stdout.split('\n');
  const row = (name) => lines.find((l) => l.includes(name));
  // Rows sort by tokens; the light zebra tint (near-white background) marks every other row.
  const zebra = /\x1b\[48;2;24[0-9];24[0-9];24[0-9]m/;
  assert.doesNotMatch(row('gpt-6-sol'), zebra);
  assert.match(row('claude-sonnet-5-5'), zebra);
  assert.doesNotMatch(row('conflicting'), zebra);
  // $/MTOK is shaded across rows: cheapest in the theme's good color, priciest in its bad color.
  assert.match(row('gpt-6-sol'), /\x1b\[38;2;26;127;55m0\.4000/);
  assert.match(row('conflicting'), /\x1b\[38;2;207;34;46m10\.0000/);
  const plain = colored.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /2026-09-23\s+\[pi\] gpt-6-sol\s+1,000\s+0\.0004\s+90\.0%\s+0\.4000\s+2\.0000\s+0\.2000/);
  assert.match(plain, /TOTAL\s+3 rows\s+1,410\s+0\.0015\s+85\.1%\s+1\.0638/);

  const noColor = run({ FORCE_COLOR: '', NO_COLOR: '1' });
  assert.doesNotMatch(noColor.stdout, /\x1b\[/);
  assert.match(noColor.stdout, /^TOTAL\s+ALL/m);
});
