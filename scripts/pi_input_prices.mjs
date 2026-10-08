#!/usr/bin/env node
// Append the installed Pi catalog's uncached input $/MTok to ccusage TSV rows.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function sdkPath(piCommand) {
  if (process.env.PI_CATALOG_MODULE) return process.env.PI_CATALOG_MODULE;
  if (!piCommand) throw new Error('pi is not on PATH');
  const launcher = realpathSync(piCommand);
  const text = readFileSync(launcher, 'utf8');
  const target = text.match(/^# cmd-shim-target=(.+)$/m)?.[1] ?? launcher;
  // Pi's CLI entry point is dist/bundle/cli.js; its SDK is dist/index.js.
  if (!target.endsWith('/dist/bundle/cli.js')) {
    throw new Error('cannot locate the installed Pi SDK from the pi launcher');
  }
  return resolve(dirname(target), '..', 'index.js');
}

export function inputPrice(modelName, models) {
  // ccusage's unified report labels Pi usage by agent, not by provider; Claude
  // Code rows carry no agent prefix and are billed at Anthropic's first-party price.
  const pi = modelName.startsWith('[pi] ');
  if (!pi && modelName.startsWith('[')) return 'N/A';
  const id = pi ? modelName.slice(5) : modelName;
  if (id.includes('…')) return 'N/A'; // table input truncated the identifier
  const candidates = models.filter((model) => pi
    ? model.id === id || (model.provider === 'openrouter' && model.id.endsWith(`/${id}`))
    // ccusage tables shorten Claude Code names to e.g. "opus-5-5".
    : model.provider === 'anthropic' && (model.id === id || model.id === `claude-${id}`)
  );
  // A zero-cost custom proxy is not evidence that its underlying model is free.
  const rates = [...new Set(candidates.map((m) => m.cost?.input).filter((n) => typeof n === 'number' && n > 0))];
  return rates.length === 1 ? String(rates[0]) : 'N/A';
}

async function main() {
  const { ModelRuntime } = await import(pathToFileURL(sdkPath(process.argv[2])).href);
  const runtime = await ModelRuntime.create();
  const models = runtime.getModels();
  const text = readFileSync(0, 'utf8');
  for (const row of text.split('\n')) {
    if (!row) continue;
    const fields = row.split('\t');
    if (fields.length !== 6) throw new Error('expected six ccusage TSV fields');
    process.stdout.write(`${row}\t${inputPrice(fields[1], models)}\n`);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))) {
  main().catch((error) => { console.error(`pi_input_prices: ${error.message}`); process.exitCode = 1; });
}
