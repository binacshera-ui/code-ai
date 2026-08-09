#!/usr/bin/env python3
import asyncio
import json
import os
from pathlib import Path
import shutil
import urllib.error
import urllib.request

from playwright.async_api import async_playwright


APP_ROOT = Path(__file__).resolve().parents[1]
SOURCE_EXTENSION_ROOT = APP_ROOT / "chrome-extension"
BASE_URL = os.environ.get("CODE_AI_E2E_BASE_URL", "http://127.0.0.1:4106").rstrip("/")
API_BASE_URL = os.environ.get("CODE_AI_E2E_API_BASE_URL", BASE_URL).rstrip("/")
CLEANUP_BASE_URL = os.environ.get("CODE_AI_E2E_CLEANUP_BASE_URL", API_BASE_URL).rstrip("/")
DEVICE_PASSWORD = os.environ.get("CODE_AI_E2E_DEVICE_PASSWORD", "test-device-password")
SEED_STALE_ORIGIN = os.environ.get("CODE_AI_E2E_SEED_STALE_ORIGIN", "0") == "1"
PANEL_ONLY = os.environ.get("CODE_AI_E2E_PANEL_ONLY", "0") == "1"
CHROMIUM = os.environ.get(
    "CODE_AI_E2E_CHROMIUM",
    str(APP_ROOT / ".playwright-browsers/chromium-1223/chrome-linux64/chrome"),
)


def request_json(pathname, method="GET", payload=None, headers=None, expected=200, base_url=None):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request_headers = {"content-type": "application/json", **(headers or {})}
    request = urllib.request.Request(
        f"{base_url or API_BASE_URL}{pathname}", data=body, headers=request_headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=130) as response:
            status = response.status
            raw_result = response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        status = error.code
        raw_result = error.read().decode("utf-8")
    try:
        result = json.loads(raw_result)
    except json.JSONDecodeError:
        result = {"raw": raw_result[:500]}
    if status != expected:
        raise AssertionError(f"{pathname}: expected {expected}, got {status}: {result}")
    return result


async def wait_for_service_worker(context):
    if context.service_workers:
        return context.service_workers[0]
    return await context.wait_for_event("serviceworker", timeout=15_000)


async def launch_extension_context(playwright, profile_root, extension_root):
    return await playwright.chromium.launch_persistent_context(
        str(profile_root),
        executable_path=CHROMIUM,
        headless=False,
        viewport={"width": 1280, "height": 900},
        args=[
            f"--disable-extensions-except={extension_root}",
            f"--load-extension={extension_root}",
            "--no-first-run",
            "--no-default-browser-check",
        ],
    )


async def main():
    extension_root = Path("/tmp/code-ai-extension-e2e-unpacked")
    if extension_root.exists():
        shutil.rmtree(extension_root)
    shutil.copytree(SOURCE_EXTENSION_ROOT, extension_root)
    panel_html = extension_root / "panel.html"
    panel_html.write_text(
        panel_html.read_text(encoding="utf-8").replace(
            'content="http://127.0.0.1:4000"', f'content="{BASE_URL}"'
        ),
        encoding="utf-8",
    )
    profile_root = Path(os.environ.get("CODE_AI_E2E_CHROME_PROFILE", "/tmp/code-ai-extension-e2e-profile"))
    if profile_root.exists():
        shutil.rmtree(profile_root)
    profile_root.mkdir(parents=True, exist_ok=True)

    device_id = None
    binding_id = None
    extension_headers = None
    async with async_playwright() as playwright:
        context = await launch_extension_context(playwright, profile_root, extension_root)
        try:
            worker = await wait_for_service_worker(context)
            extension_id = worker.url.split("/")[2]
            manifest_name = await worker.evaluate("chrome.runtime.getManifest().name")
            assert manifest_name == "CODE-AI Personal Chrome"
            if SEED_STALE_ORIGIN:
                await worker.evaluate(
                    """async settings => {
                      await chrome.storage.local.set({codeAiPersonalChromeSettings: settings});
                    }""",
                    {
                        "controlOrigin": "http://127.0.0.1:9",
                        "deviceName": "Stale Chrome device",
                        "deviceId": "stale-device-id",
                        "deviceToken": "stale-device-token",
                    },
                )
                await context.close()
                context = await launch_extension_context(playwright, profile_root, extension_root)
                worker = await wait_for_service_worker(context)
                assert worker.url.split("/")[2] == extension_id

            panel = await context.new_page()
            browser_errors = []
            panel.on("pageerror", lambda error: browser_errors.append(str(error)))
            panel.on(
                "console",
                lambda message: browser_errors.append(message.text)
                if message.type == "error"
                else None,
            )
            await panel.goto(f"chrome-extension://{extension_id}/panel.html")
            await panel.locator("#connected").wait_for(state="visible", timeout=15_000)
            frame_element = panel.locator("#code-ai-frame")
            assert (await frame_element.get_attribute("src") or "").endswith("/extension-panel")
            app = panel.frame_locator("#code-ai-frame")
            password_input = app.locator('input[type="password"]')
            await password_input.wait_for(state="visible", timeout=20_000)
            await password_input.fill(DEVICE_PASSWORD)
            await app.get_by_role("button", name="פתח מכשיר זה").click()
            await panel.locator("#connection-label").get_by_text("כלי דפדפן מחוברים", exact=False).wait_for(timeout=20_000)
            frame = frame_element
            await frame.wait_for(state="visible")

            stored = await worker.evaluate(
                "async () => (await chrome.storage.local.get('codeAiPersonalChromeSettings')).codeAiPersonalChromeSettings"
            )
            assert stored["controlOrigin"] == BASE_URL
            assert stored["deviceToken"] != "stale-device-token"
            device_id = stored["deviceId"]
            extension_headers = {
                "x-code-ai-extension-device": device_id,
                "x-code-ai-extension-token": stored["deviceToken"],
            }
            devices = await asyncio.to_thread(
                request_json, "/api/codex/browser-extension/devices", "GET", None, extension_headers
            )
            device = next(item for item in devices["devices"] if item["id"] == device_id)
            assert device["online"] is True
            assert not any(
                "Failed to execute 'postMessage'" in error
                or "X-Frame-Options" in error
                or "Refused to display" in error
                for error in browser_errors
            ), browser_errors

            initial_device_id = device_id
            await asyncio.to_thread(
                request_json,
                f"/api/codex/browser-extension/devices/{initial_device_id}?preserveTrust=1",
                "DELETE",
                None,
                extension_headers,
            )
            device_id = None
            extension_headers = None
            await worker.evaluate(
                """async () => {
                  const key = 'codeAiPersonalChromeSettings';
                  const current = (await chrome.storage.local.get(key))[key] || {};
                  await chrome.storage.local.set({
                    [key]: {
                      controlOrigin: current.controlOrigin,
                      deviceName: current.deviceName || 'Chrome במחשב האישי',
                    },
                  });
                }"""
            )
            await context.close()
            context = await launch_extension_context(playwright, profile_root, extension_root)
            worker = await wait_for_service_worker(context)
            assert worker.url.split("/")[2] == extension_id
            panel = await context.new_page()
            panel.on("pageerror", lambda error: browser_errors.append(str(error)))
            panel.on(
                "console",
                lambda message: browser_errors.append(message.text)
                if message.type == "error"
                else None,
            )
            await panel.goto(f"chrome-extension://{extension_id}/panel.html")
            await panel.locator("#connection-label").get_by_text(
                "כלי דפדפן מחוברים", exact=False
            ).wait_for(timeout=20_000)
            frame_element = panel.locator("#code-ai-frame")
            app = panel.frame_locator("#code-ai-frame")
            assert not await app.locator('input[type="password"]').is_visible()
            stored = await worker.evaluate(
                "async () => (await chrome.storage.local.get('codeAiPersonalChromeSettings')).codeAiPersonalChromeSettings"
            )
            assert stored["deviceId"] != initial_device_id
            device_id = stored["deviceId"]
            extension_headers = {
                "x-code-ai-extension-device": device_id,
                "x-code-ai-extension-token": stored["deviceToken"],
            }
            recovered_devices = await asyncio.to_thread(
                request_json, "/api/codex/browser-extension/devices", "GET", None, extension_headers
            )
            recovered_device = next(item for item in recovered_devices["devices"] if item["id"] == device_id)
            assert recovered_device["online"] is True
            if PANEL_ONLY:
                print(json.dumps({
                    "ok": True,
                    "extensionId": extension_id,
                    "deviceId": device_id,
                    "panelLoaded": True,
                    "originMigrated": stored["controlOrigin"] == BASE_URL,
                    "autoRecovered": True,
                    "webSocketOnline": True,
                }))
                return

            profiles_payload = await asyncio.to_thread(
                request_json, "/api/codex/profiles", "GET", None, extension_headers
            )
            profiles = profiles_payload if isinstance(profiles_payload, list) else profiles_payload["profiles"]
            profile = next((item for item in profiles if item.get("provider") == "codex"), profiles[0])
            auto_session_key = "draft:automatic-chromium-e2e"
            auto_sync = await panel.evaluate(
                "async context => await chrome.runtime.sendMessage({type: 'SYNC_ACTIVE_SESSION', context})",
                {
                    "authenticated": True,
                    "deviceUnlocked": True,
                    "serverId": "local",
                    "provider": "codex",
                    "profileId": profile["id"],
                    "sessionKey": auto_session_key,
                },
            )
            assert auto_sync["ok"] is True
            assert auto_sync["personalChromeMode"]["enabled"] is True
            assert auto_sync["personalChromeMode"]["allowJavascript"] is True
            automatic_mode = await asyncio.to_thread(
                request_json,
                f"/api/codex/session-personal-chrome-mode?profileId={profile['id']}&sessionKey={auto_session_key}",
                "GET",
                None,
                extension_headers,
            )
            assert automatic_mode["personalChromeMode"]["deviceId"] == device_id
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
                extension_headers,
                201,
            )
            binding_id = binding["binding"]["id"]
            auth = {"authorization": f"Bearer {binding['bindingToken']}"}
            selected_session_key = "draft:real-chromium-e2e"
            await asyncio.to_thread(
                request_json,
                "/api/codex/session-personal-chrome-mode",
                "POST",
                {
                    "profileId": profile["id"],
                    "sessionKey": selected_session_key,
                    "personalChromeMode": {
                        "enabled": True,
                        "deviceId": device_id,
                        "deviceName": "Chromium E2E",
                        "tabId": None,
                        "approvalPolicy": "risky",
                        "allowJavascript": False,
                        "allowUploads": False,
                        "allowPorts": False,
                        "bindingId": binding_id,
                        "bindingToken": binding["bindingToken"],
                        "controlUrl": API_BASE_URL,
                    },
                },
                extension_headers,
            )
            selection_sync = await panel.evaluate(
                "async context => await chrome.runtime.sendMessage({type: 'SYNC_ACTIVE_SESSION', context})",
                {
                    "authenticated": True,
                    "deviceUnlocked": True,
                    "serverId": "local",
                    "provider": "codex",
                    "profileId": profile["id"],
                    "sessionKey": selected_session_key,
                },
            )
            assert selection_sync["ok"] is True
            assert selection_sync["personalChromeMode"]["bindingId"] == binding_id

            target = await context.new_page()
            await target.goto(f"{BASE_URL}/chat?personalChromeE2E=1", wait_until="domcontentloaded")
            await target.bring_to_front()

            picker_task = asyncio.create_task(
                panel.evaluate(
                    "async () => await chrome.runtime.sendMessage({type: 'PANEL_PICK', mode: 'element_picker'})"
                )
            )
            await target.wait_for_timeout(600)
            await target.mouse.click(120, 120)
            picker_result = await asyncio.wait_for(picker_task, timeout=10)
            assert picker_result["ok"] is True
            assert picker_result["selection"]["kind"] == "element"
            picked_element = picker_result["selection"]["element"]
            assert picked_element["primarySelector"]
            assert isinstance(picked_element["selectorCandidates"], list)
            assert isinstance(picked_element["computedStyleSubset"], dict)
            assert isinstance(picked_element["matchedCssRules"], list)
            assert isinstance(picked_element["semanticPath"], list)
            assert isinstance(picked_element["componentHints"], list)
            assert isinstance(picked_element["interaction"], dict)

            region_task = asyncio.create_task(
                panel.evaluate(
                    "async () => await chrome.runtime.sendMessage({type: 'PANEL_PICK', mode: 'region_picker'})"
                )
            )
            await target.wait_for_timeout(400)
            await target.mouse.move(40, 40)
            await target.mouse.down()
            await target.mouse.move(420, 300, steps=8)
            await target.mouse.up()
            region_result = await asyncio.wait_for(region_task, timeout=10)
            assert region_result["ok"] is True
            assert region_result["selection"]["kind"] == "region"
            assert region_result["selection"]["region"]["bounds"]["width"] >= 300
            assert isinstance(region_result["selection"]["region"]["elements"], list)
            panel_state = await panel.evaluate(
                "async () => await chrome.runtime.sendMessage({type: 'PANEL_GET_STATE'})"
            )
            assert len(panel_state["selections"]) == 2
            assert panel_state["selections"][0]["selectionId"] == picker_result["selection"]["selectionId"]
            assert panel_state["selections"][1]["selectionId"] == region_result["selection"]["selectionId"]
            await app.get_by_text("2 מוקדים נבחרו מהאתר", exact=True).wait_for(timeout=10_000)

            selected_context = await asyncio.to_thread(
                request_json,
                "/api/codex/browser-extension/tool-call",
                "POST",
                {"toolName": "browser_selection_context", "arguments": {}},
                auth,
            )
            assert selected_context["result"]["version"] == 2
            assert selected_context["result"]["trust"] == "untrusted-page-content"
            assert selected_context["result"]["count"] == 2
            assert selected_context["result"]["selections"][0]["selectionId"] == picker_result["selection"]["selectionId"]
            assert selected_context["result"]["selections"][1]["kind"] == "region"

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
            assert not any(
                "Receiving end does not exist" in error or "Could not establish connection" in error
                for error in browser_errors
            ), browser_errors

            print(json.dumps({
                "ok": True,
                "extensionId": extension_id,
                "deviceId": device_id,
                "autoRecovered": True,
                "tools": ["browser_tabs", "browser_snapshot", "browser_screenshot", "browser_selection_context"],
                "picker": [picker_result["selection"]["kind"], region_result["selection"]["kind"]],
                "selectionContextVersion": 2,
            }))
        finally:
            if binding_id:
                await asyncio.to_thread(
                    request_json,
                    f"/api/codex/browser-extension/bindings/{binding_id}",
                    "DELETE",
                    None,
                    extension_headers,
                    200,
                    CLEANUP_BASE_URL,
                )
            if device_id:
                await asyncio.to_thread(
                    request_json,
                    f"/api/codex/browser-extension/devices/{device_id}",
                    "DELETE",
                    None,
                    extension_headers,
                    200,
                    CLEANUP_BASE_URL,
                )
            await context.close()


if __name__ == "__main__":
    asyncio.run(main())
