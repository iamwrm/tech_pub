import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const piBin = path.join(pkgDir, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
const extensionPath = path.join(pkgDir, "openai-server-compaction.ts");

function model(id, contextWindow = 272_000) {
	return {
		id,
		name: id,
		reasoning: true,
		input: ["text", "image"],
		contextWindow,
		maxTokens: 128_000,
		compat: { supportsStore: false },
	};
}

/** Run `pi --list-models <search>` in a scratch agent dir, optionally with this extension loaded. */
function runListModels(agentDir, search, extension) {
	return spawnSync(piBin, [
		"--offline",
		"--no-extensions",
		...(extension === undefined ? [] : ["--extension", extension]),
		"--list-models", search,
	], {
		cwd: pkgDir,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		encoding: "utf8",
		timeout: 30_000,
	});
}

/** "xai grok-4.3" rows of `--list-models` output, header row skipped. */
function listedModelIds(stdout) {
	const ids = new Set();
	for (const line of stdout.split("\n")) {
		const [provider, id] = line.trim().split(/\s+/);
		if (!provider || !id || provider === "provider") continue;
		ids.add(`${provider} ${id}`);
	}
	return ids;
}

test("Pi composes Fluxion stream decorators above models.json without replacing GPT, Grok, or Kimi catalogs", () => {
	const agentDir = mkdtempSync(path.join(tmpdir(), "pi-openai-server-compaction-model-composition-"));
	try {
		writeFileSync(path.join(agentDir, "models.json"), `${JSON.stringify({
			providers: {
				"fluxion-gpt": {
					baseUrl: "https://fluxionai.space/v1",
					api: "openai-responses",
					apiKey: "synthetic-test-key",
					models: [model("gpt-5.5"), model("gpt-5.6-sol")],
				},
				"fluxion-grok": {
					baseUrl: "https://fluxionai.space/v1",
					api: "openai-responses",
					apiKey: "synthetic-test-key",
					models: [model("grok-4.5", 500_000), model("grok-4.6", 500_000)],
				},
				"fluxion-cn": {
					baseUrl: "https://fluxionai.space/v1",
					api: "openai-responses",
					apiKey: "synthetic-test-key",
					models: [model("kimi-k3", 1_000_000)],
				},
			},
		}, null, 2)}\n`);
		writeFileSync(path.join(agentDir, "settings.json"), "{}\n");

		const result = spawnSync(piBin, [
			"--offline",
			"--no-extensions",
			"--extension", extensionPath,
			"--list-models", "fluxion",
		], {
			cwd: pkgDir,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(result.status, 0, result.stderr || result.stdout);
		for (const expected of [
			"fluxion-gpt  gpt-5.5",
			"fluxion-gpt  gpt-5.6-sol",
			"fluxion-grok  grok-4.5",
			"fluxion-grok  grok-4.6",
			"fluxion-cn  kimi-k3",
		]) assert.match(result.stdout.replace(/\s+/g, " "), new RegExp(expected.replace(/\s+/g, "\\s+")));
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("Pi composes the xAI stream decorator above models.json without replacing Grok catalogs", () => {
	const agentDir = mkdtempSync(path.join(tmpdir(), "pi-openai-server-compaction-xai-composition-"));
	try {
		writeFileSync(path.join(agentDir, "models.json"), `${JSON.stringify({
			providers: {
				"xai": {
					baseUrl: "https://api.x.ai/v1",
					api: "openai-responses",
					apiKey: "synthetic-test-key",
					models: [model("grok-4.6", 500_000)],
				},
			},
		}, null, 2)}\n`);
		writeFileSync(path.join(agentDir, "settings.json"), "{}\n");

		// Baseline catalog: the builtin xAI models merged with models.json, as pi
		// builds it without this extension. Read it at runtime rather than
		// hardcoding ids, so the assertion survives a pi catalog change.
		const baseline = runListModels(agentDir, "xai");
		assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
		const baselineIds = listedModelIds(baseline.stdout);

		// Guard: the baseline must expose builtin xAI models beyond models.json,
		// otherwise the survival check below would pass vacuously.
		assert.ok(
			[...baselineIds].some((id) => id !== "xai grok-4.6"),
			`baseline xAI catalog carries no builtin model beyond models.json:\n${baseline.stdout}`,
		);

		const result = runListModels(agentDir, "xai", extensionPath);
		assert.equal(result.status, 0, result.stderr || result.stdout);
		const decoratedIds = listedModelIds(result.stdout);
		for (const id of baselineIds) {
			assert.ok(decoratedIds.has(id), `extension dropped ${id} from the xAI catalog:\n${result.stdout}`);
		}
		// models.json entries are merged above the builtin catalog.
		assert.match(result.stdout.replace(/\s+/g, " "), /xai\s+grok-4\.6/);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
