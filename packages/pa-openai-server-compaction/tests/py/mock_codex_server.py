"""
Mock OpenAI Codex compaction endpoint for basic protocol testing.

Emulates POST https://chatgpt.com/backend-api/codex/responses (SSE) and the
standard Responses compaction endpoint POST /v1/responses/compact (JSON).
The mock validates the exact request shape the extension sends and records
every attempt, so the Python tests can assert both the client behavior and
the wire contract.

Run standalone:  python mock_codex_server.py --port 0
"""
from __future__ import annotations

import base64
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

CODEX_PATH = "/backend-api/codex/responses"
STANDARD_PATH = "/v1/responses/compact"

ARTIFACT = {
    "type": "compaction",
    "id": "comp_mock_1",
    "encrypted_content": "enc:opaque-mock-ciphertext",
    "internal_chat_message_metadata_passthrough": {"turn_id": "turn_mock_1"},
}

USAGE = {
    "input_tokens": 1200,
    "output_tokens": 300,
    "total_tokens": 1500,
    "input_tokens_details": {"cached_tokens": 900},
}

MODEL_ID = "gpt-5.6-sol"
ACCOUNT_ID = "acct_test"


def make_codex_token(account_id: str = ACCOUNT_ID) -> str:
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(
        json.dumps({"https://api.openai.com/auth": {"chatgpt_account_id": account_id}}).encode()
    ).rstrip(b"=").decode()
    return f"{header}.{payload}.signature"


def decode_account_id(token: str) -> str:
    payload = token.split(".")[1] + "=" * (-len(token.split(".")[1]) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))["https://api.openai.com/auth"]["chatgpt_account_id"]


def user_item(text: str) -> dict:
    return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}


def compaction_trigger() -> dict:
    return {"type": "compaction_trigger"}


def sse_event(event_type: str, data: dict) -> str:
    return f"event: {event_type}\ndata: {json.dumps(data)}\n\n"


def codex_success_sse(artifact: dict | None = None, usage: dict | None = None) -> str:
    artifact = artifact or ARTIFACT
    usage = usage or USAGE
    chunks = [
        sse_event("response.created", {"type": "response.created", "response": {"id": "resp_mock_1", "status": "in_progress"}}),
        sse_event("response.output_item.done", {"type": "response.output_item.done", "item": artifact}),
        sse_event("response.completed", {
            "type": "response.completed",
            "response": {"id": "resp_mock_1", "status": "completed", "output": [artifact], "usage": usage},
        }),
        "data: [DONE]\n\n",
    ]
    return "".join(chunks)


def codex_error_sse(code: str, message: str) -> str:
    return sse_event("error", {"type": "error", "code": code, "message": message})


def codex_failed_sse(message: str) -> str:
    return sse_event("response.failed", {"type": "response.failed", "response": {"error": {"message": message}}})


def codex_incomplete_sse() -> str:
    return sse_event("response.created", {"type": "response.created", "response": {"id": "resp_mock_1", "status": "in_progress"}})


def parse_sse_text(text: str) -> list[dict]:
    """Reference SSE parser used by the Python-side cross-check."""
    events = []
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        data_lines = [line[5:].strip() for line in block.split("\n") if line.startswith("data:")]
        if not data_lines:
            continue
        data = "\n".join(data_lines).strip()
        if data == "[DONE]":
            continue
        events.append(json.loads(data))
    return events


class RequestShapeError(AssertionError):
    """Raised when the compaction request does not match the wire contract."""


def validate_codex_request(headers: dict, body: dict, expected_token: str | None, expected_session_id: str) -> None:
    lower = {k.lower(): v for k, v in headers.items()}
    token = lower.get("authorization", "")
    if not token.startswith("Bearer "):
        raise RequestShapeError(f"authorization missing: {token[:20]!r}")
    bearer = token.removeprefix("Bearer ")
    if expected_token is not None and bearer != expected_token:
        raise RequestShapeError(f"authorization mismatch: {bearer[:20]!r} != expected")
    if decode_account_id(bearer) != ACCOUNT_ID:
        raise RequestShapeError(f"account id claim mismatch: {decode_account_id(bearer)!r}")
    if lower.get("chatgpt-account-id") != ACCOUNT_ID:
        raise RequestShapeError("chatgpt-account-id mismatch")
    if lower.get("originator") != "pi":
        raise RequestShapeError("originator mismatch")
    if lower.get("openai-beta") != "responses=experimental":
        raise RequestShapeError("openai-beta mismatch")
    features = lower.get("x-codex-beta-features", "")
    if "remote_compaction_v2" not in features:
        raise RequestShapeError("missing remote_compaction_v2 feature")
    if lower.get("session_id") != expected_session_id:
        raise RequestShapeError(f"session_id mismatch: {lower.get('session_id')!r} != {expected_session_id!r}")
    if lower.get("accept") != "text/event-stream":
        raise RequestShapeError("accept mismatch")
    if lower.get("content-type") != "application/json":
        raise RequestShapeError("content-type mismatch")
    if body.get("model") != MODEL_ID:
        raise RequestShapeError(f"model mismatch: {body.get('model')!r}")
    inp = body.get("input")
    if not isinstance(inp, list) or not inp:
        raise RequestShapeError("input missing or empty")
    if inp[-1] != {"type": "compaction_trigger"}:
        raise RequestShapeError("input must end with compaction_trigger")
    if "previous_response_id" in body:
        raise RequestShapeError("previous_response_id must be dropped")
    if "messages" in body:
        raise RequestShapeError("messages field must be dropped")


def validate_standard_request(headers: dict, body: dict, expected_token: str | None) -> None:
    lower = {k.lower(): v for k, v in headers.items()}
    token = lower.get("authorization", "")
    if not token.startswith("Bearer "):
        raise RequestShapeError("authorization missing")
    if expected_token is not None and token.removeprefix("Bearer ") != expected_token:
        raise RequestShapeError("authorization mismatch")
    if lower.get("accept") != "application/json":
        raise RequestShapeError("accept mismatch")
    for banned in ("chatgpt-account-id", "openai-beta", "originator", "x-codex-beta-features", "session_id"):
        if lower.get(banned):
            raise RequestShapeError(f"unexpected header {banned}")
    if body.get("model") != MODEL_ID:
        raise RequestShapeError("model mismatch")
    inp = body.get("input")
    if not isinstance(inp, list) or not inp:
        raise RequestShapeError("input missing or empty")
    if any(isinstance(item, dict) and item.get("type") == "compaction_trigger" for item in inp):
        raise RequestShapeError("standard lane must not carry compaction_trigger")


class CodexMockHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # keep output quiet
        pass

    def _read_body(self) -> dict:
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw or b"{}")

    def _respond(self, status: int, payload: dict, content_type: str = "application/json") -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _respond_sse(self, status: int, text: str) -> None:
        data = text.encode()
        self.send_response(status)
        self.send_header("content-type", "text/event-stream")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        scenario = self.headers.get("x-test-scenario") or "ok"
        expected_session_id = self.headers.get("x-test-session-id") or "sess-test"
        expected_token = self.headers.get("x-test-api-key")
        body = self._read_body()
        headers = dict(self.headers.items())

        if path == CODEX_PATH:
            self.server.mock.record_attempt("codex", scenario, expected_session_id)
            try:
                validate_codex_request(headers, body, expected_token, expected_session_id)
            except RequestShapeError as error:
                self.server.mock.record_failure(str(error))
                self._respond(400, {"error": {"message": str(error)}})
                return
            self._handle_codex_scenario(scenario, expected_session_id)
            return
        if path == STANDARD_PATH:
            self.server.mock.record_attempt("standard", scenario, expected_session_id)
            try:
                validate_standard_request(headers, body, expected_token)
            except RequestShapeError as error:
                self.server.mock.record_failure(str(error))
                self._respond(400, {"error": {"message": str(error)}})
                return
            self._handle_standard_scenario(scenario)
            return
        self._respond(404, {"error": {"message": f"unknown path {path}"}})

    def _handle_codex_scenario(self, scenario: str, session_id: str) -> None:
        if scenario == "http-500":
            attempts = self.server.mock.attempts_for("codex", scenario, session_id)
            if attempts <= 2:
                self._respond(500, {"error": {"message": "internal"}})
                return
            self._respond_sse(200, codex_success_sse())
            return
        if scenario == "error-event":
            attempts = self.server.mock.attempts_for("codex", scenario, session_id)
            if attempts <= 2:
                self._respond_sse(200, codex_error_sse("server_is_overloaded", "mock overloaded"))
                return
            self._respond_sse(200, codex_success_sse())
            return
        if scenario == "response-failed":
            self._respond_sse(200, codex_failed_sse("mock failed"))
            return
        if scenario == "incomplete":
            self._respond_sse(200, codex_incomplete_sse())
            return
        if scenario == "bad-id":
            artifact = dict(ARTIFACT, id="bad id with spaces")
            self._respond_sse(200, codex_success_sse(artifact=artifact))
            return
        if scenario == "no-artifact":
            self._respond_sse(200, sse_event("response.completed", {
                "type": "response.completed",
                "response": {"id": "resp_mock_1", "status": "completed", "output": [], "usage": USAGE},
            }))
            return
        self._respond_sse(200, codex_success_sse())

    def _handle_standard_scenario(self, scenario: str) -> None:
        if scenario == "http-500":
            attempts = self.server.mock.attempts_for("standard", scenario, "sess-test")
            if attempts <= 2:
                self._respond(500, {"error": {"message": "internal"}})
                return
        self._respond(200, {
            "id": "resp_mock_std_1",
            "status": "completed",
            "output": [ARTIFACT],
            "usage": USAGE,
        })


class CodexMockServer:
    def __init__(self) -> None:
        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), CodexMockHandler)
        self._httpd.mock = self  # handler sees `self.server` = httpd; mock lives here
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._lock = threading.Lock()
        self.attempts: dict[tuple[str, str, str], int] = {}
        self.failures: list[str] = []

    @property
    def port(self) -> int:
        return self._httpd.server_address[1]

    @property
    def codex_url(self) -> str:
        return f"http://127.0.0.1:{self.port}{CODEX_PATH}"

    @property
    def standard_url(self) -> str:
        return f"http://127.0.0.1:{self.port}{STANDARD_PATH}"

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()

    def record_attempt(self, lane: str, scenario: str, session_id: str) -> None:
        with self._lock:
            key = (lane, scenario, session_id)
            self.attempts[key] = self.attempts.get(key, 0) + 1

    def attempts_for(self, lane: str, scenario: str, session_id: str) -> int:
        with self._lock:
            return self.attempts.get((lane, scenario, session_id), 0)

    def record_failure(self, detail: str) -> None:
        with self._lock:
            self.failures.append(detail)

    def clear(self) -> None:
        with self._lock:
            self.attempts.clear()
            self.failures.clear()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args()
    server = CodexMockServer()
    if args.port:
        server._httpd.server_address = ("127.0.0.1", args.port)  # pragma: no cover
    server.start()
    print(f"mock codex compaction listening on {server.codex_url}")
    threading.Event().wait()
