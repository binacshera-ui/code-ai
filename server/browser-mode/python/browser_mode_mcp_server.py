#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import select
import signal
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from browser_mode_runtime import BrowserRuntime, BrowserRuntimeError

SERVER_NAME = "Code-AI Browser Mode"
SERVER_VERSION = "0.1.0"


def send(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def send_result(request_id, result):
    send({"jsonrpc": "2.0", "id": request_id, "result": result})


def send_error(request_id, code, message):
    send({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def tool_content(value):
    return [{
        "type": "text",
        "text": json.dumps(value, ensure_ascii=False, indent=2)
    }]


TOOL_DEFS = [
    {
        "name": "browser_health",
        "title": "Browser Health",
        "description": "Return the real browser runtime health, profile path, artifact path, and whether Playwright dependencies are available.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False},
    },
    {
        "name": "tabs_create",
        "title": "Create Browser Tab",
        "description": "Open a new browser tab and make it current.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": True},
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
    {
        "name": "tabs_context",
        "title": "Browser Tabs Context",
        "description": "List open tabs and which tab is current.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": True},
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True},
    },
    {
        "name": "navigate",
        "title": "Navigate",
        "description": "Navigate to a URL or move back, forward, or reload.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Destination URL or the literal back/forward."},
                "direction": {"type": "string", "description": "back, forward, or reload when url is omitted."},
                "tabId": {"type": "integer"},
                "timeout_ms": {"type": "integer"},
                "wait_until": {"type": "string"},
                "waitUntil": {"type": "string"}
            },
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
    {
        "name": "read_page",
        "title": "Read Page",
        "description": "Extract the current page as structured markdown or accessibility tree.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {"type": "integer"},
                "selector": {"type": "string"},
                "include_links": {"type": "boolean"},
                "max_chars": {"type": "integer"},
                "accessibility": {"type": "boolean"},
                "filter": {"type": "string"},
                "depth": {"type": "integer"}
            },
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True},
    },
    {
        "name": "read_accessibility_tree",
        "title": "Read Accessibility Tree",
        "description": "Read an accessibility-oriented tree of the current page or a selected subtree.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {"type": "integer"},
                "ref_id": {"type": "string"},
                "refId": {"type": "string"},
                "filter": {"type": "string"},
                "depth": {"type": "integer"},
                "max_chars": {"type": "integer"}
            },
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True},
    },
    {
        "name": "get_page_text",
        "title": "Get Page Text",
        "description": "Return raw extracted text from the current page or selector.",
        "inputSchema": {
            "type": "object",
            "properties": {"tabId": {"type": "integer"}, "selector": {"type": "string"}, "max_chars": {"type": "integer"}},
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True},
    },
    {
        "name": "find",
        "title": "Find Elements",
        "description": "Find matching elements by natural-language query.",
        "inputSchema": {
            "type": "object",
            "properties": {"tabId": {"type": "integer"}, "query": {"type": "string"}, "description": {"type": "string"}, "limit": {"type": "integer"}},
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True},
    },
    {
        "name": "find_element",
        "title": "Find Element Candidates",
        "description": "Return scored matching interactive elements for a natural-language description.",
        "inputSchema": {
            "type": "object",
            "properties": {"tabId": {"type": "integer"}, "query": {"type": "string"}, "description": {"type": "string"}, "limit": {"type": "integer"}},
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True},
    },
    {
        "name": "inspect_at_point",
        "title": "Inspect Element At Point",
        "description": "Inspect the DOM element at viewport coordinates without clicking it. Returns selectors, accessibility metadata, geometry, computed styles, matching CSS rules, source hints, and a redacted text summary.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {"type": "integer"},
                "x": {"type": "number"},
                "y": {"type": "number"}
            },
            "required": ["x", "y"],
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True},
    },
    {
        "name": "click",
        "title": "Click",
        "description": "Click an element using selector, ref, or natural-language description.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {"type": "integer"},
                "selector": {"type": "string"},
                "description": {"type": "string"},
                "ref": {"type": "string"},
                "button": {"type": "string"},
                "click_count": {"type": "integer"},
                "clickCount": {"type": "integer"},
                "timeout_ms": {"type": "integer"},
                "modifiers": {"type": "array", "items": {"type": "string"}}
            },
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
    {
        "name": "type",
        "title": "Type",
        "description": "Type into an element using selector, ref, or natural-language description.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {"type": "integer"},
                "selector": {"type": "string"},
                "description": {"type": "string"},
                "ref": {"type": "string"},
                "text": {"type": "string"},
                "clear_first": {"type": "boolean"},
                "delay_ms": {"type": "integer"},
                "press_enter": {"type": "boolean"},
                "timeout_ms": {"type": "integer"}
            },
            "required": ["text"],
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
    {
        "name": "form_input",
        "title": "Form Input",
        "description": "Set the value of a form field, checkbox, radio, or select.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {"type": "integer"},
                "selector": {"type": "string"},
                "description": {"type": "string"},
                "ref": {"type": "string"},
                "value": {}
            },
            "required": ["value"],
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
    {
        "name": "press_key",
        "title": "Press Key",
        "description": "Press a key or key chord on the current page or focused element.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {"type": "integer"},
                "key": {"type": "string"},
                "selector": {"type": "string"},
                "description": {"type": "string"},
                "ref": {"type": "string"},
                "timeout_ms": {"type": "integer"}
            },
            "required": ["key"],
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
    {
        "name": "scroll",
        "title": "Scroll",
        "description": "Scroll the page or a specific container.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {"type": "integer"},
                "direction": {"type": "string"},
                "amount": {"type": "integer"},
                "selector": {"type": "string"},
                "ref": {"type": "string"}
            },
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
    {
        "name": "run_js",
        "title": "Run JavaScript",
        "description": "Execute JavaScript in the current page with optional args.",
        "inputSchema": {
            "type": "object",
            "properties": {"tabId": {"type": "integer"}, "code": {"type": "string"}, "args": {}, "max_chars": {"type": "integer"}},
            "required": ["code"],
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
    {
        "name": "read_console_messages",
        "title": "Read Console Messages",
        "description": "Read captured console and pageerror messages.",
        "inputSchema": {
            "type": "object",
            "properties": {"tabId": {"type": "integer"}, "pattern": {"type": "string"}, "onlyErrors": {"type": "boolean"}, "limit": {"type": "integer"}, "clear": {"type": "boolean"}},
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
    {
        "name": "read_network_requests",
        "title": "Read Network Requests",
        "description": "Read captured network requests for the current tab.",
        "inputSchema": {
            "type": "object",
            "properties": {"tabId": {"type": "integer"}, "urlPattern": {"type": "string"}, "limit": {"type": "integer"}, "clear": {"type": "boolean"}},
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
    {
        "name": "resize_window",
        "title": "Resize Window",
        "description": "Resize the browser viewport.",
        "inputSchema": {
            "type": "object",
            "properties": {"tabId": {"type": "integer"}, "width": {"type": "integer"}, "height": {"type": "integer"}},
            "required": ["width", "height"],
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
    {
        "name": "upload_image",
        "title": "Upload Image",
        "description": "Upload a previously captured or local image by selector or coordinate.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {"type": "integer"},
                "imageId": {"type": "string"},
                "selector": {"type": "string"},
                "description": {"type": "string"},
                "ref": {"type": "string"},
                "coordinate": {"type": "array", "items": {"type": "number"}, "minItems": 2, "maxItems": 2},
                "filename": {"type": "string"}
            },
            "required": ["imageId"],
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
    {
        "name": "gif_creator",
        "title": "GIF Creator",
        "description": "Start, stop, clear, or export a GIF recording for the active tab.",
        "inputSchema": {
            "type": "object",
            "properties": {"tabId": {"type": "integer"}, "action": {"type": "string"}, "filename": {"type": "string"}, "options": {"type": "object"}},
            "required": ["action"],
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
    {
        "name": "screenshot",
        "title": "Screenshot",
        "description": "Capture a screenshot of the current page, selector, or region.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {"type": "integer"},
                "format": {"type": "string"},
                "selector": {"type": "string"},
                "ref": {"type": "string"},
                "region": {"type": "object"},
                "full_page": {"type": "boolean"},
                "quality": {"type": "integer"},
                "timeout_ms": {"type": "integer"}
            },
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
    {
        "name": "computer",
        "title": "Computer Tool",
        "description": "Perform lower-level browser interactions such as clicks, hover, drag, wait, and screenshots.",
        "inputSchema": {"type": "object", "properties": {"action": {"type": "string"}}, "required": ["action"], "additionalProperties": True},
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
    {
        "name": "browser_batch",
        "title": "Browser Batch",
        "description": "Execute a small batch of browser actions in sequence.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "actions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "input": {"type": "object"}
                        },
                        "required": ["name"],
                        "additionalProperties": True
                    }
                }
            },
            "required": ["actions"],
            "additionalProperties": True
        },
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": True},
    },
]


def build_runtime(args):
    if args.bridge_info_file:
        return BrowserBridgeProxy(args.bridge_info_file)

    settings = SimpleNamespace(
        web_browser_executable_path=args.executable_path or None,
        web_browser_profile_dir=args.profile_dir,
        web_browser_screenshot_dir=args.screenshot_dir,
        web_browser_headless=args.headless,
        web_browser_navigation_timeout_ms=args.navigation_timeout_ms,
        web_browser_launch_timeout_ms=args.launch_timeout_ms,
        web_page_max_chars=args.page_max_chars,
        web_run_js_max_chars=args.run_js_max_chars,
    )
    return BrowserRuntime(settings)


class BrowserBridgeProxy:
    """Forward MCP calls to the session-owned Chromium runtime.

    The Code-AI viewer owns the real BrowserRuntime process. Codex launches this
    lightweight stdio MCP adapter, which reads the owner-only bridge discovery
    file and calls that exact runtime. This keeps the visible tab and the tab
    operated by the model identical.
    """

    def __init__(self, bridge_info_file: str) -> None:
        self._bridge_info_file = Path(bridge_info_file).resolve()

    def _read_bridge(self) -> tuple[str, str]:
        try:
            stat = self._bridge_info_file.stat()
        except OSError as exc:
            raise BrowserRuntimeError(
                "BROWSER_BRIDGE_UNAVAILABLE",
                True,
                503,
                "The shared browser runtime is not ready.",
                "Retry after Code-AI finishes opening the session browser.",
            ) from exc

        if not self._bridge_info_file.is_file() or stat.st_mode & 0o077:
            raise BrowserRuntimeError(
                "BROWSER_BRIDGE_INSECURE",
                False,
                500,
                "The shared browser discovery file is not owner-only.",
                "Repair the browser-mode session permissions before retrying.",
            )

        try:
            payload = json.loads(self._bridge_info_file.read_text(encoding="utf-8"))
        except Exception as exc:
            raise BrowserRuntimeError(
                "BROWSER_BRIDGE_INVALID",
                True,
                503,
                "The shared browser discovery file is invalid.",
                "Retry after Code-AI restarts the session browser.",
            ) from exc

        bridge_url = payload.get("url")
        bridge_token = payload.get("token")
        profile_dir = payload.get("profile_dir")
        parsed_url = urlparse(bridge_url if isinstance(bridge_url, str) else "")
        expected_profile_dir = (self._bridge_info_file.parent / "profile").resolve()
        try:
            actual_profile_dir = Path(profile_dir).resolve() if isinstance(profile_dir, str) else None
        except OSError:
            actual_profile_dir = None

        if (
            parsed_url.scheme != "http"
            or parsed_url.hostname not in {"127.0.0.1", "localhost", "::1"}
            or parsed_url.port is None
            or not isinstance(bridge_token, str)
            or len(bridge_token) < 32
            or actual_profile_dir != expected_profile_dir
        ):
            raise BrowserRuntimeError(
                "BROWSER_BRIDGE_INVALID",
                False,
                500,
                "The shared browser discovery file did not identify this session runtime.",
                "Restart the browser-mode session and retry.",
            )

        return bridge_url.rstrip("/"), bridge_token

    def _post(self, endpoint: str, payload: dict) -> dict:
        last_connection_error: Exception | None = None
        for attempt in range(3):
            bridge_url, bridge_token = self._read_bridge()
            request = Request(
                f"{bridge_url}{endpoint}",
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {bridge_token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
                method="POST",
            )
            try:
                with urlopen(request, timeout=130) as response:
                    response_payload = json.loads(response.read().decode("utf-8") or "{}")
            except HTTPError as exc:
                try:
                    response_payload = json.loads(exc.read().decode("utf-8") or "{}")
                except Exception:
                    response_payload = {}
                error_payload = response_payload.get("error") if isinstance(response_payload, dict) else None
                error_payload = error_payload if isinstance(error_payload, dict) else {}
                raise BrowserRuntimeError(
                    str(error_payload.get("error_code") or "BROWSER_MODE_RUNTIME_FAILURE"),
                    bool(error_payload.get("is_retryable")),
                    int(error_payload.get("status_code") or exc.code or 500),
                    str(error_payload.get("message") or "The shared browser action failed."),
                    str(error_payload.get("suggested_remediation") or "Retry the browser action."),
                ) from exc
            except (URLError, TimeoutError, OSError) as exc:
                last_connection_error = exc
                if attempt < 2:
                    time.sleep(0.15 * (attempt + 1))
                    continue
                break
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise BrowserRuntimeError(
                    "BROWSER_BRIDGE_INVALID_RESPONSE",
                    True,
                    502,
                    "The shared browser runtime returned an invalid response.",
                    "Retry the browser action.",
                ) from exc

            if not isinstance(response_payload, dict) or response_payload.get("ok") is not True:
                error_payload = response_payload.get("error") if isinstance(response_payload, dict) else None
                error_payload = error_payload if isinstance(error_payload, dict) else {}
                raise BrowserRuntimeError(
                    str(error_payload.get("error_code") or "BROWSER_MODE_RUNTIME_FAILURE"),
                    bool(error_payload.get("is_retryable")),
                    int(error_payload.get("status_code") or 500),
                    str(error_payload.get("message") or "The shared browser action failed."),
                    str(error_payload.get("suggested_remediation") or "Retry the browser action."),
                )
            result = response_payload.get("result")
            return result if isinstance(result, dict) else {}

        raise BrowserRuntimeError(
            "BROWSER_BRIDGE_UNAVAILABLE",
            True,
            503,
            "The shared browser runtime is temporarily unavailable.",
            "Retry after Code-AI reopens the session browser.",
        ) from last_connection_error

    def dispatch_action(self, name: str, arguments: dict | None = None) -> dict:
        return self._post("/call", {"name": name, "arguments": dict(arguments or {})})


    def process_bridge_requests(self) -> None:
        return None

    def pump_browser_events(self) -> None:
        return None

    def close(self) -> None:
        return None


def call_runtime(runtime, name, arguments):
    return runtime.dispatch_action(name, dict(arguments or {}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bridge-info-file", required=False)
    parser.add_argument("--profile-dir", required=False)
    parser.add_argument("--screenshot-dir", required=False)
    parser.add_argument("--artifacts-dir", required=False)
    parser.add_argument("--executable-path", required=False)
    parser.add_argument("--headless", dest="headless", action="store_true")
    parser.add_argument("--no-headless", dest="headless", action="store_false")
    parser.set_defaults(headless=True)
    parser.add_argument("--navigation-timeout-ms", type=int, default=30000)
    parser.add_argument("--launch-timeout-ms", type=int, default=30000)
    parser.add_argument("--page-max-chars", type=int, default=12000)
    parser.add_argument("--run-js-max-chars", type=int, default=8000)
    args = parser.parse_args()

    if not args.bridge_info_file and (not args.profile_dir or not args.screenshot_dir):
        parser.error("--profile-dir and --screenshot-dir are required unless --bridge-info-file is used")

    runtime = build_runtime(args)
    stop_requested = False

    def request_stop(_signal_number, _frame):
        nonlocal stop_requested
        stop_requested = True

    previous_sigterm_handler = signal.signal(signal.SIGTERM, request_stop)

    def handle_request(message):
        request_id = message.get("id")
        method = message.get("method")
        params = message.get("params") or {}

        if method == "initialize":
            send_result(request_id, {
                "protocolVersion": params.get("protocolVersion", "2025-11-25"),
                "capabilities": {"tools": {}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "instructions": "Real Chromium browser tools are available for this Codex session through a session-scoped persistent profile.",
            })
            return

        if method == "ping":
            send_result(request_id, {})
            return

        if method == "tools/list":
            send_result(request_id, {"tools": TOOL_DEFS})
            return


        if method == "tools/call":
            try:
                tool_name = params.get("name")
                if not isinstance(tool_name, str) or not tool_name.strip():
                    raise BrowserRuntimeError(
                        "WEB_TOOL_VALIDATION_FAILED",
                        False,
                        400,
                        "Tool name is required.",
                        "Provide a valid browser tool name.",
                    )
                result = call_runtime(runtime, tool_name.strip(), params.get("arguments") or {})
                send_result(request_id, {
                    "content": tool_content(result),
                    "structuredContent": result,
                    "isError": False,
                })
            except BrowserRuntimeError as exc:
                payload = {
                    "error_code": exc.error_code,
                    "message": str(exc),
                    "is_retryable": exc.is_retryable,
                    "status_code": exc.status_code,
                    "suggested_remediation": exc.suggested_remediation,
                }
                send_result(request_id, {
                    "content": tool_content(payload),
                    "structuredContent": payload,
                    "isError": True,
                })
            except Exception as exc:
                payload = {
                    "error_code": "BROWSER_MODE_RUNTIME_FAILURE",
                    "message": str(exc),
                    "is_retryable": False,
                    "status_code": 500,
                    "suggested_remediation": "Inspect the local browser-mode MCP log and runtime profile state.",
                }
                send_result(request_id, {
                    "content": tool_content(payload),
                    "structuredContent": payload,
                    "isError": True,
                })
            return

        if request_id is not None:
            send_error(request_id, -32601, f"Method not found: {method}")

    try:
        stdin_stream = sys.stdin
        while not stop_requested:
            runtime.process_bridge_requests()
            runtime.pump_browser_events()

            try:
                ready, _, _ = select.select([stdin_stream], [], [], 0.025)
            except (OSError, ValueError):
                break

            runtime.process_bridge_requests()

            if not ready:
                continue

            line = stdin_stream.readline()
            if line == "":
                break
            if not line.strip():
                continue
            try:
                message = json.loads(line)
            except Exception:
                continue
            if message.get("method") is None:
                continue
            handle_request(message)
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm_handler)
        runtime.close()


if __name__ == "__main__":
    main()
