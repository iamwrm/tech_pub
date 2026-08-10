"""
Basic protocol tests for pa-openai-server-compaction, driven with uv + Python.

The mock server emulates the Codex compaction endpoint; a Node driver process
runs the real TypeScript module and exchanges JSON over stdio. These tests
validate the wire contract (headers, body shape) and the client behaviors
(parse, retry, error classification, replay history) end to end.

Run with (from the package root):
    uv run --project tests/py python -m unittest discover -s tests/py -v
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PACKAGE_ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)

from mock_codex_server import (  # noqa: E402
    ARTIFACT,
    MODEL_ID,
    STANDARD_PATH,
    USAGE,
    CodexMockServer,
    codex_success_sse,
    make_codex_token,
    parse_sse_text,
    user_item,
)

MODEL = {
    "name": "GPT-5.6 Sol",
    "provider": "openai-codex",
    "api": "openai-codex-responses",
    "id": MODEL_ID,
    "baseUrl": "https://chatgpt.com/backend-api",
    "reasoning": True,
    "input": ["text"],
    "contextWindow": 272_000,
    "maxTokens": 128_000,
    "thinkingLevelMap": {"off": "none", "medium": "medium", "max": "xhigh"},
    "cost": {"input": 1.25, "output": 10, "cacheRead": 0.125, "cacheWrite": 0},
}


class DriverProcess:
    """One persistent node bridge process."""

    def __init__(self) -> None:
        node_bin = os.environ.get("PA_TEST_NODE") or shutil.which("node")
        if not node_bin:
            raise RuntimeError("node binary not found")
        self._proc = subprocess.Popen(
            [node_bin, "--experimental-strip-types", "driver.mjs"],
            cwd=HERE,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._next_id = 0
        self._lock = threading.Lock()

    def call(self, cmd: str, params: dict | None = None):
        with self._lock:
            self._next_id += 1
            request_id = self._next_id
            payload = json.dumps({"id": request_id, "cmd": cmd, "params": params or {}})
            self._proc.stdin.write(payload + "\n")
            self._proc.stdin.flush()
            line = self._proc.stdout.readline()
            if not line:
                stderr = self._proc.stderr.read()
                raise RuntimeError(f"driver died: {stderr}")
            response = json.loads(line)
            assert response.get("id") == request_id, response
            return response

    def close(self) -> None:
        self._proc.stdin.close()
        self._proc.wait(timeout=10)


class CompactionProtocolTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = CodexMockServer()
        cls.server.start()
        cls.driver = DriverProcess()
        cls.token = make_codex_token("acct_test")

    def setUp(self):
        self.server.clear()

    @classmethod
    def tearDownClass(cls):
        cls.driver.close()
        cls.server.stop()

    # ------------------------------------------------------------------
    # helpers
    # ------------------------------------------------------------------
    def _prepared_body(self) -> dict:
        prepared = {
            "model": MODEL_ID,
            "input": [user_item("first user message"), user_item("second user message")],
            "previous_response_id": "resp_old",
            "store": False,
            "stream": True,
        }
        tail = [user_item("tail message after checkpoint")]
        response = self.driver.call("build_prepared", {"payload": prepared, "tail": tail})
        self.assertTrue(response["ok"], response)
        return response["result"]

    def _compact(self, scenario: str = "ok", session_id: str = "sess-test", headers: dict | None = None):
        built = self._prepared_body()
        response = self.driver.call("remote_compact", {
            "url": self.server.codex_url,
            "apiKey": self.token,
            "sessionId": session_id,
            "body": built["body"],
            "compactedInput": built["compactedInput"],
            "model": MODEL,
            "headers": headers or {},
            "scenario": scenario,
        })
        return response

    # ------------------------------------------------------------------
    # wire contract
    # ------------------------------------------------------------------
    def test_built_request_ends_with_compaction_trigger(self):
        built = self._prepared_body()
        self.assertEqual(built["body"]["input"][-1], {"type": "compaction_trigger"})
        self.assertNotIn("previous_response_id", built["body"])
        # compactedInput = snapshot input + tail, without the trigger.
        self.assertEqual(len(built["compactedInput"]), 3)

    def test_remote_compact_success_parses_artifact_and_usage(self):
        response = self._compact()
        self.assertTrue(response["ok"], response)
        result = response["result"]
        history = result["replacementHistory"]
        self.assertEqual(history[-1]["type"], "compaction")
        self.assertEqual(history[-1]["encrypted_content"], ARTIFACT["encrypted_content"])
        self.assertEqual(history[-1]["internal_chat_message_metadata_passthrough"]["turn_id"], "turn_mock_1")
        # Retained recent user items precede the artifact.
        self.assertIn("second user message", json.dumps(history))
        self.assertEqual(result["responseId"], "resp_mock_1")
        self.assertEqual(result["usage"]["input"], 300)  # 1200 - 900 cached
        self.assertEqual(result["usage"]["cacheRead"], 900)
        # The mock validated the full header/body contract; no shape failures.
        self.assertEqual(self.server.failures, [])

    def test_remote_compact_http_500_retries_then_succeeds(self):
        response = self._compact(scenario="http-500", session_id="sess-retry-500")
        self.assertTrue(response["ok"], response)
        self.assertGreaterEqual(self.server.attempts_for("codex", "http-500", "sess-retry-500"), 3)

    def test_remote_compact_overload_event_retries_then_succeeds(self):
        response = self._compact(scenario="error-event", session_id="sess-retry-overload")
        self.assertTrue(response["ok"], response)
        self.assertGreaterEqual(self.server.attempts_for("codex", "error-event", "sess-retry-overload"), 3)

    def test_remote_compact_incomplete_stream_fails(self):
        response = self._compact(scenario="incomplete")
        self.assertFalse(response["ok"])
        self.assertIn("ended before completion", response["error"]["message"])

    def test_remote_compact_bad_artifact_rejected(self):
        response = self._compact(scenario="bad-id")
        self.assertFalse(response["ok"])
        self.assertIn("invalid", response["error"]["message"])

    def test_remote_compact_no_artifact_rejected(self):
        response = self._compact(scenario="no-artifact")
        self.assertFalse(response["ok"])
        self.assertIn("expected one artifact", response["error"]["message"])

    def test_remote_compact_response_failed_event(self):
        response = self._compact(scenario="response-failed")
        self.assertFalse(response["ok"])
        self.assertIn("mock failed", response["error"]["message"])

    def test_remote_compact_bad_auth_token_rejected_by_server_contract(self):
        # The module signs the request with whatever apiKey it was given; the
        # mock rejects a token whose account claim does not match the
        # chatgpt-account-id header the module derived from it, proving the
        # client and server agree on the auth contract.
        bad_token = make_codex_token("acct_other")
        built = self._prepared_body()
        response = self.driver.call("remote_compact", {
            "url": self.server.codex_url,
            "apiKey": bad_token,
            "sessionId": "sess-bad-auth",
            "body": built["body"],
            "compactedInput": built["compactedInput"],
            "model": MODEL,
            "headers": {},
            "scenario": "ok",
        })
        self.assertFalse(response["ok"])
        self.assertIn("400", response["error"]["message"])
        self.assertTrue(any("account id claim mismatch" in failure or "chatgpt-account-id" in failure for failure in self.server.failures), self.server.failures)

    # ------------------------------------------------------------------
    # standard Responses adapter
    # ------------------------------------------------------------------
    def test_standard_compact_success(self):
        prepared = {
            "model": MODEL_ID,
            "input": [user_item("a")],
            "instructions": "sys",
            "prompt_cache_key": "k",
            "store": False,
        }
        built = self.driver.call("build_standard", {"payload": prepared, "tail": [user_item("b")]})
        self.assertTrue(built["ok"], built)
        self.assertEqual(len(built["result"]["body"]["input"]), 2)
        response = self.driver.call("remote_compact", {
            "url": self.server.standard_url,
            "apiKey": self.token,
            "sessionId": "sess-standard",
            "body": built["result"]["body"],
            "compactedInput": built["result"]["compactedInput"],
            "model": {**MODEL, "api": "openai-responses", "provider": "fluxion-gpt", "baseUrl": "https://fluxionai.space/v1"},
            "adapter": "standard-responses-json",
            "scenario": "ok",
        })
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["result"]["replacementHistory"][-1]["type"], "compaction")
        self.assertEqual(self.server.failures, [])

    # ------------------------------------------------------------------
    # parse / retain pure functions via the bridge
    # ------------------------------------------------------------------
    def test_parse_sse_accepts_mock_framing(self):
        text = codex_success_sse()
        response = self.driver.call("parse_sse", {"text": text})
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["result"]["compactionItem"]["id"], "comp_mock_1")
        self.assertEqual(response["result"]["responseId"], "resp_mock_1")

    def test_python_reference_parser_agrees_on_artifact(self):
        events = parse_sse_text(codex_success_sse())
        artifacts = [e for e in events if e.get("type") == "response.output_item.done"]
        self.assertEqual(len(artifacts), 1)
        self.assertEqual(artifacts[0]["item"]["type"], "compaction")

    def test_retain_budget_via_bridge(self):
        response = self.driver.call("retain", {
            "input": [user_item("old message"), user_item("new message")],
            "maxTokens": 3,
        })
        self.assertTrue(response["ok"], response)
        texts = [p["text"] for item in response["result"] for p in item["content"]]
        self.assertEqual(texts, ["new message"])

    def test_details_roundtrip_via_bridge(self):
        details = {
            "strategy": "openai-responses-compaction-v2",
            "adapter": "codex-trigger-sse",
            "provider": "openai-codex",
            "api": "openai-codex-responses",
            "model": MODEL_ID,
            "baseUrl": "https://chatgpt.com/backend-api",
            "replacementHistory": [user_item("kept"), ARTIFACT],
            "createdAt": "2026-08-09T00:00:00.000Z",
        }
        response = self.driver.call("details", {"value": details})
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["result"]["replacementHistory"][-1]["type"], "compaction")

    def test_format_usage_via_bridge(self):
        response = self.driver.call("format_usage", {
            "usage": {"input": 300, "output": 300, "cacheRead": 900, "cacheWrite": 0, "totalTokens": 1500,
                      "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
        })
        self.assertTrue(response["ok"], response)
        self.assertIn("input 1,200", response["result"])
        self.assertIn("cache read 900 (75.0%)", response["result"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
