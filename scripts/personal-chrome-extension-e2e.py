#!/usr/bin/env python3
import asyncio
import json
import os
from pathlib import Path
import urllib.error
import urllib.request

from playwright.async_api import async_playwright


APP_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_ROOT = APP_ROOT / "chrome-extension"
BASE_URL = os.environ.get("CODE_AI_E2E_BASE_URL", "http://127.0.0.1:4106").rstrip("/")
CHROMIUM = os.environ.get(
    "CODE_AI_E2E_CHROMIUM",
    str(APP_ROOT / ".playwright-browsers/chromium-1223/chrome-linux64/chrome"),
)


def request_json(pathname, method="GET", payload=None, headers=None, expected=200):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request_headers = {"content-type": "application/json", **(headers or {})}
    request = urllib.request.Request(
        f"{BASE_URL}{pathname}", data=body, headers=request_headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=130) as response:
            status = response.status
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        status = error.code
        result = json.loads(error.read().decode("utf-8"))
    if status != expected:
        raise AssertionError(f"{pathname}: expected {expected}, got {status}: {result}")
    return result


async def wait_for_service_worker(context):
    if context.service_workers:
        return context.service_workers[0]
    return await context.wait_for_event("serviceworker", timeout=15_000)


async def main():
    pairing = await asyncio.to_thread(
        request_json, "/api/codex/browser-extension/pairing/start", "POST", {}
    )
    profile_root = Path(os.environ.get("CODE_AI_E2E_CHROME_PROFILE", "/tmp/code-ai-extension-e2e-profile"))
    if profile_root.exists():
        import shutil
        shutil.rmtree(profile_root)
    profile_root.mkdir(parents=True, exist_ok=True)

    device_id = None
    binding_id = None
    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(
            str(profile_root),
            executable_path=CHROMIUM,
            headless=False,
            viewport={"width": 1280, "height": 900},
            args=[
                f"--disable-extensions-except={EXTENSION_ROOT}",
                f"--load-extension={EXTENSION_ROOT}",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        try:
            worker = await wait_for_service_worker(context)
            extension_id = worker.url.split("/")[2]
            manifest_name = await worker.evaluate("chrome.runtime.getManifest().name")
            assert manifest_name == "CODE-AI Personal Chrome"

            panel = await context.new_page()
            await panel.goto(f"chrome-extension://{extension_id}/panel.html")
            await panel.locator("#control-origin").fill(BASE_URL)
            await panel.locator("#device-name").fill("Chromium E2E")
            await panel.locator("#pairing-code").fill(pairing["code"])
            await panel.locator("#pair-button").click()
            await panel.locator("#connected").wait_for(state="visible", timeout=15_000)
            await panel.locator("#connection-label").get_by_text("מחובר", exact=False).wait_for(timeout=15_000)
            frame = panel.locator("#code-ai-frame")
            await frame.wait_for(state="visible")

            devices = await asyncio.to_thread(request_json, "/api/codex/browser-extension/devices")
            device = next(item for item in devices["devices"] if item["name"] == "Chromium E2E")
            device_id = device["id"]
            assert device["online"] is True

            profiles_payload = await asyncio.to_thread(request_json, "/api/codex/profiles")
            profiles = profiles_payload if isinstance(profiles_payload, list) else profiles_payload["profiles"]
            profile = next((item for item in profiles if item.get("provider") == "codex"), profiles[0])
            binding = await asyncio.to_thread(
                request_json,
                "/api/codex/browser-extension/bindings",
                "POST",
                {
                    "deviceId": device_id,
                    "profileId": profile["id"],
                    "sessionKey": "draft:real-chromium-e2e",
                    "scopes": ["read", "write"],
                    "approvalPolicy": "risky",
                },
                None,
                201,
            )
            binding_id = binding["binding"]["id"]
            auth = {"authorization": f"Bearer {binding['bindingToken']}"}

            target = await context.new_page()
            await target.goto(f"{BASE_URL}/chat?personalChromeE2E=1", wait_until="domcontentloaded")
            await target.bring_to_front()

            tabs = await asyncio.to_thread(
                request_json,
                "/api/codex/browser-extension/tool-call",
                "POST",
                {"toolName": "browser_tabs", "arguments": {}},
                auth,
            )
            assert any("personalChromeE2E=1" in (tab.get("url") or "") for tab in tabs["result"]["tabs"])

            snapshot = await asyncio.to_thread(
                request_json,
                "/api/codex/browser-extension/tool-call",
                "POST",
                {"toolName": "browser_snapshot", "arguments": {"maxChars": 4000}},
                auth,
            )
            assert snapshot["result"]["url"].startswith(BASE_URL)
            assert isinstance(snapshot["result"]["controls"], list)

            screenshot = await asyncio.to_thread(
                request_json,
                "/api/codex/browser-extension/tool-call",
                "POST",
                {"toolName": "browser_screenshot", "arguments": {"format": "jpeg", "quality": 60}},
                auth,
            )
            assert screenshot["result"]["imageDataUrl"].startswith("data:image/jpeg;base64,")
            assert screenshot["result"]["bytes"] > 100

            print(json.dumps({
                "ok": True,
                "extensionId": extension_id,
                "deviceId": device_id,
                "tools": ["browser_tabs", "browser_snapshot", "browser_screenshot"],
            }))
        finally:
            if binding_id:
                await asyncio.to_thread(
                    request_json,
                    f"/api/codex/browser-extension/bindings/{binding_id}",
                    "DELETE",
                )
            if device_id:
                await asyncio.to_thread(
                    request_json,
                    f"/api/codex/browser-extension/devices/{device_id}",
                    "DELETE",
                )
            await context.close()


if __name__ == "__main__":
    asyncio.run(main())
