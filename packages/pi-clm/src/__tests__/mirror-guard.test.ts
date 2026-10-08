import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { classifyMirrorToolCall } from "../mirror-guard.ts";

const MIRROR = "/tmp/pi-live-context-test/LIVE_CONTEXT.md";
const CWD = "/tmp/project";

function bash(command: string) {
	return classifyMirrorToolCall("bash", { command }, CWD, MIRROR);
}

describe("mirror tool-call classification", () => {
	test("edit and write tools targeting the mirror are writes", () => {
		assert.equal(classifyMirrorToolCall("write", { path: MIRROR, content: "x" }, CWD, MIRROR), "write");
		assert.equal(classifyMirrorToolCall("edit", { path: MIRROR, oldText: "a", newText: "b" }, CWD, MIRROR), "write");
		assert.equal(classifyMirrorToolCall("edit", { path: "/tmp/project/src/main.ts" }, CWD, MIRROR), "none");
	});

	test("the skill's header discovery command is a read", () => {
		const discovery = [
			`LIVE_CTX="${MIRROR}" python3 - <<'PY'`,
			"import os, re",
			"from pathlib import Path",
			"",
			'lines = Path(os.environ["LIVE_CTX"]).read_text().splitlines()',
			'meta = re.fullmatch(r"\\[\\[LIVE_CONTEXT .* document=([a-f0-9]{64}) baseline=[a-f0-9]{64}\\]\\]", lines[0])',
			"if not meta:",
			'    raise SystemExit("invalid live-context metadata")',
			"doc = meta.group(1)",
			"print(lines[0])",
			"for line in lines[1:]:",
			'    if line.startswith(f"[[CTX_TURN document={doc} "):',
			"        print(line)",
			"PY",
		].join("\n");
		assert.equal(bash(discovery), "read");
	});

	test("the skill's replacement recipe is a write", () => {
		const edit = [
			"python3 - <<'PY'",
			"from pathlib import Path",
			"import re",
			"",
			`p = Path("${MIRROR}")`,
			"s = p.read_text()",
			'turn_id = "2-abc123def456"',
			'summary = "[summary: findings]"',
			"s, count = re.subn(pattern, lambda m: m.group(1) + summary, s, count=1, flags=re.M | re.S)",
			"if count != 1:",
			'    raise SystemExit(f"turn not found: {turn_id}")',
			"",
			"p.write_text(s)",
			"PY",
		].join("\n");
		assert.equal(bash(edit), "write");
	});

	test("shell write operators targeting the mirror are writes", () => {
		assert.equal(bash(`cat /tmp/replacement.md > ${MIRROR}`), "write");
		assert.equal(bash(`printf 'x' | tee ${MIRROR}`), "write");
		assert.equal(bash(`sed -E -i '' 's/old/new/' ${MIRROR}`), "write");
		assert.equal(bash(`rm ${MIRROR}`), "write");
		assert.equal(bash(`mv ${MIRROR} /tmp/elsewhere.md`), "write");
	});

	test("plain inspection of the mirror is a read", () => {
		assert.equal(bash(`grep 'CTX_TURN' ${MIRROR}`), "read");
		assert.equal(bash(`head -n 3 ${MIRROR}`), "read");
		assert.equal(bash(`wc -l ${MIRROR}`), "read");
	});

	test("commands that do not reference the mirror are ignored", () => {
		assert.equal(bash("cat notes.md > summary.md"), "none");
		assert.equal(bash("python3 script.py"), "none");
	});
});
