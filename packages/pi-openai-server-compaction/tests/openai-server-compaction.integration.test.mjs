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

		const result = spawnSync(piBin, [
			"--offline",
			"--no-extensions",
			"--extension", extensionPath,
			"--list-models", "xai",
		], {
			cwd: pkgDir,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(result.status, 0, result.stderr || result.stdout);
		for (const expected of [
			"xai  grok-4.6",
			"xai  grok-4.5",
			"xai  grok-4.3",
			"xai  grok-build-0.1",
		]) assert.match(result.stdout.replace(/\s+/g, " "), new RegExp(expected.replace(/\s+/g, "\\s+")));
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});
