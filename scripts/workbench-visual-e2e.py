#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import sync_playwright


WORKBENCH_ORIGIN = os.environ.get(
    "CODE_AI_WORKBENCH_ORIGIN",
    "https://app-code-ai.bina-cshera.co.il",
).rstrip("/")
TARGET_ORIGIN = os.environ.get(
    "CODE_AI_WORKBENCH_E2E_TARGET",
    "https://app.bina-cshera.co.il/",
)


def read_dotenv_value(name: str) -> str:
    env_file = Path(__file__).resolve().parents[1] / ".env"
    if not env_file.is_file():
        return ""
    for raw_line in env_file.read_text("utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip() == name:
            return value.strip().strip('"').strip("'")
    return ""


def read_configured_device_password() -> str:
    configured = os.environ.get("CODEX_DEVICE_ADMIN_PASSWORD") or read_dotenv_value(
        "CODEX_DEVICE_ADMIN_PASSWORD"
    )
    if configured:
        return configured

    config_file = Path(__file__).resolve().parents[1] / "server" / "config.ts"
    match = re.search(
        r"deviceAdminPassword:\s*process\.env\.CODEX_DEVICE_ADMIN_PASSWORD\s*\|\|\s*(['\"])(.*?)\1",
        config_file.read_text("utf-8"),
    )
    return match.group(2) if match else ""


def main() -> None:
    device_password = read_configured_device_password()
    if not device_password:
        raise RuntimeError("CODEX_DEVICE_ADMIN_PASSWORD is not configured")

    executable_path = next(
        candidate
        for candidate in (
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
        )
        if Path(candidate).is_file()
    )

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=executable_path,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = browser.new_context(viewport={"width": 2048, "height": 1024}, locale="he-IL")
        page = context.new_page()
        viewer_identity: dict[str, str] = {}

        def remember_viewer_request(request) -> None:
            parsed = urlparse(request.url)
            if parsed.path != "/api/codex/session-browser-viewer":
                return
            query = parse_qs(parsed.query)
            profile_id = (query.get("profileId") or [""])[0]
            session_key = (query.get("sessionKey") or [""])[0]
            if profile_id and session_key:
                viewer_identity.update({"profileId": profile_id, "sessionKey": session_key})

        page.on("request", remember_viewer_request)
        page.goto(WORKBENCH_ORIGIN, wait_until="domcontentloaded", timeout=45_000)

        unlock = page.evaluate(
            """async (password) => {
              const response = await fetch('/api/codex/device-unlock', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
              });
              return { ok: response.ok, status: response.status };
            }""",
            device_password,
        )
        if not unlock.get("ok"):
            raise AssertionError(f"Workbench device unlock failed with HTTP {unlock.get('status')}")

        cleanup_keys = [
            value.strip()
            for value in os.environ.get("CODE_AI_WORKBENCH_CLEANUP_SESSION_KEYS", "").split(",")
            if value.strip()
        ]
        for session_key in cleanup_keys:
            page.evaluate(
                """async ({ profileId, sessionKey }) => {
                  const query = new URLSearchParams({ profileId, sessionKey });
                  await fetch(`/api/codex/session-browser-viewer?${query}`, {
                    method: 'DELETE',
                    credentials: 'same-origin',
                  });
                }""",
                {"profileId": "developer", "sessionKey": session_key},
            )
        if os.environ.get("CODE_AI_WORKBENCH_CLEANUP_ONLY") == "1":
            print(json.dumps({"ok": True, "cleaned": len(cleanup_keys)}))
            context.close()
            browser.close()
            return

        page.reload(wait_until="domcontentloaded", timeout=45_000)
        address = page.locator('input[placeholder="https://example.com"]')
        address.wait_for(state="visible", timeout=45_000)
        address.fill(TARGET_ORIGIN)

        identity_deadline = time.monotonic() + 45
        while not viewer_identity and time.monotonic() < identity_deadline:
            page.wait_for_timeout(100)
        if not viewer_identity:
            raise AssertionError("Workbench did not open a browser viewer")

        page.wait_for_function(
            """() => (document.body?.innerText || '').includes('Bina מחובר')""",
            timeout=45_000,
        )
        viewer_response = context.request.get(
            f"{WORKBENCH_ORIGIN}/api/codex/session-browser-viewer",
            params=viewer_identity,
        )
        if not viewer_response.ok:
            raise AssertionError(f"Workbench viewer state returned HTTP {viewer_response.status}")
        viewer = viewer_response.json().get("viewer") or {}
        navigate_response = context.request.post(
            f"{WORKBENCH_ORIGIN}/api/codex/session-browser-viewer/action",
            data={
                **viewer_identity,
                "action": "navigate",
                "tabId": viewer.get("currentTabId"),
                "url": TARGET_ORIGIN,
            },
        )
        if not navigate_response.ok:
            raise AssertionError(f"Workbench navigation returned HTTP {navigate_response.status}")

        page.wait_for_function(
            """() => [...document.querySelectorAll('section img')].some((image) => {
              const rect = image.getBoundingClientRect();
              return image.naturalWidth >= 1000 && image.naturalHeight >= 700 && rect.width >= 900;
            })""",
            timeout=60_000,
        )
        page.wait_for_function(
            """() => {
              const surface = document.querySelector('[data-workbench-frame-mode="live"]');
              const stream = document.querySelector('img[src*="/session-browser-viewer/stream?"]');
              return Boolean(surface && stream && stream.naturalWidth >= 1000 && stream.naturalHeight >= 700);
            }""",
            timeout=60_000,
        )
        page.wait_for_timeout(350)

        metrics = page.evaluate(
            """() => {
              const image = [...document.querySelectorAll('section img')].find((candidate) => (
                candidate.naturalWidth >= 1000 && candidate.naturalHeight >= 700
              ));
              if (!image) return null;
              const imageRect = image.getBoundingClientRect();
              const surface = image.closest('[tabindex="0"]');
              const surfaceRect = surface?.getBoundingClientRect();
              return {
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                renderedWidth: Math.round(imageRect.width),
                renderedHeight: Math.round(imageRect.height),
                surfaceWidth: Math.round(surfaceRect?.width || 0),
                surfaceHeight: Math.round(surfaceRect?.height || 0),
                widthScale: imageRect.width / image.naturalWidth,
                heightScale: imageRect.height / image.naturalHeight,
                surfaceFill: surfaceRect ? imageRect.height / surfaceRect.height : 0,
                measuredSurface: surface?.getAttribute('data-workbench-surface-size') || '',
                frameMode: surface?.getAttribute('data-workbench-frame-mode') || '',
                fitScale: Number(surface?.getAttribute('data-workbench-fit-scale') || 0),
                displayScale: Number(surface?.getAttribute('data-workbench-display-scale') || 0),
                liveStreamRendered: Boolean(document.querySelector('img[src*="/session-browser-viewer/stream?"]')),
              };
            }"""
        )
        if not metrics:
            raise AssertionError("Workbench preview image was not rendered")
        if metrics["heightScale"] < 0.82:
            raise AssertionError(f"Workbench preview is still too small: {metrics}")
        if metrics["surfaceFill"] < 0.9:
            raise AssertionError(f"Workbench preview does not fill its surface: {metrics}")
        if metrics["renderedHeight"] > metrics["surfaceHeight"]:
            raise AssertionError(f"Workbench preview is clipped vertically: {metrics}")
        if metrics["frameMode"] != "live" or not metrics["liveStreamRendered"]:
            raise AssertionError(f"Workbench did not render the live Chromium stream: {metrics}")

        split_layout = page.evaluate(
            """() => {
              const chat = document.querySelector('iframe[title="Code-AI"]')?.closest('aside');
              const browser = document.querySelector('section');
              if (!chat || !browser) return null;
              const chatRect = chat.getBoundingClientRect();
              const browserRect = browser.getBoundingClientRect();
              return {
                chatLeft: Math.round(chatRect.left),
                chatRight: Math.round(chatRect.right),
                browserLeft: Math.round(browserRect.left),
                browserRight: Math.round(browserRect.right),
              };
            }"""
        )
        if not split_layout or split_layout["chatLeft"] < split_layout["browserRight"] - 2:
            raise AssertionError(f"Code-AI session pane is not on the right: {split_layout}")

        def is_input_response(response, expected_input: str) -> bool:
            if urlparse(response.url).path != "/api/codex/session-browser-viewer/input":
                return False
            try:
                payload = json.loads(response.request.post_data or "{}")
            except json.JSONDecodeError:
                return False
            return payload.get("input") == expected_input

        live_stream = page.locator('img[src*="/session-browser-viewer/stream?"]').first
        stream_box = live_stream.bounding_box()
        if not stream_box:
            raise AssertionError("Workbench live stream has no interactive bounding box")
        with page.expect_response(lambda response: is_input_response(response, "hover"), timeout=10_000) as hover_response:
            page.mouse.move(
                stream_box["x"] + stream_box["width"] * 0.72,
                stream_box["y"] + stream_box["height"] * 0.42,
            )
        if hover_response.value.status != 202:
            raise AssertionError(f"Workbench hover input returned HTTP {hover_response.value.status}")

        with page.expect_response(lambda response: is_input_response(response, "scroll"), timeout=10_000) as scroll_response:
            page.mouse.wheel(0, 360)
        if scroll_response.value.status != 202:
            raise AssertionError(f"Workbench wheel input returned HTTP {scroll_response.value.status}")
        page.wait_for_timeout(350)
        if page.get_by_text("מעדכן תצוגה", exact=True).first.is_visible():
            raise AssertionError("Live pointer input still triggers the blocking loading overlay")

        page.locator('button[title="נייד"]').click()
        page.wait_for_function(
            """() => {
              const stream = document.querySelector('img[src*="/session-browser-viewer/stream?"]');
              return Boolean(stream && stream.naturalWidth === 390 && stream.naturalHeight === 844);
            }""",
            timeout=60_000,
        )
        mobile_viewport_stream = page.evaluate(
            """() => {
              const stream = document.querySelector('img[src*="/session-browser-viewer/stream?"]');
              return { src: stream?.getAttribute('src') || '', width: stream?.naturalWidth || 0, height: stream?.naturalHeight || 0 };
            }"""
        )
        if "width=390" not in mobile_viewport_stream["src"] or "height=844" not in mobile_viewport_stream["src"]:
            raise AssertionError(f"Mobile viewport did not receive a dimension-bound stream URL: {mobile_viewport_stream}")

        page.locator('button[title="מחשב"]').click()
        page.wait_for_function(
            """() => {
              const stream = document.querySelector('img[src*="/session-browser-viewer/stream?"]');
              return Boolean(stream && stream.naturalWidth === 1440 && stream.naturalHeight === 1000);
            }""",
            timeout=60_000,
        )
        desktop_viewport_stream = page.evaluate(
            """() => {
              const stream = document.querySelector('img[src*="/session-browser-viewer/stream?"]');
              return { src: stream?.getAttribute('src') || '', width: stream?.naturalWidth || 0, height: stream?.naturalHeight || 0 };
            }"""
        )

        page.screenshot(path="/tmp/code-ai-workbench-visual-e2e.png", full_page=True)

        close_chat = page.locator('button[title="סגור Code-AI"]').first
        if close_chat.is_visible():
            close_chat.click()

        responsive_metrics = []
        for label, width, height in (("narrow", 1100, 800), ("mobile", 430, 900)):
            page.set_viewport_size({"width": width, "height": height})
            page.wait_for_timeout(450)
            responsive = page.evaluate(
                """(label) => {
                  const surface = document.querySelector('[data-workbench-frame-mode]');
                  const stream = document.querySelector('img[src*="/session-browser-viewer/stream?"]');
                  if (!surface || !stream) return null;
                  const surfaceRect = surface.getBoundingClientRect();
                  const streamRect = stream.getBoundingClientRect();
                  return {
                    label,
                    frameMode: surface.getAttribute('data-workbench-frame-mode') || '',
                    surfaceWidth: Math.round(surfaceRect.width),
                    surfaceHeight: Math.round(surfaceRect.height),
                    renderedWidth: Math.round(streamRect.width),
                    renderedHeight: Math.round(streamRect.height),
                    naturalWidth: stream.naturalWidth,
                    naturalHeight: stream.naturalHeight,
                  };
                }""",
                label,
            )
            if not responsive:
                raise AssertionError(f"Workbench {label} preview was not rendered")
            if responsive["frameMode"] != "live":
                raise AssertionError(f"Workbench {label} preview lost the live stream: {responsive}")
            if responsive["renderedWidth"] > responsive["surfaceWidth"] or responsive["renderedHeight"] > responsive["surfaceHeight"]:
                raise AssertionError(f"Workbench {label} preview is clipped: {responsive}")
            responsive_metrics.append(responsive)
            page.screenshot(path=f"/tmp/code-ai-workbench-{label}-e2e.png", full_page=True)

        if viewer_identity:
            cleanup_response = context.request.delete(
                f"{WORKBENCH_ORIGIN}/api/codex/session-browser-viewer",
                params=viewer_identity,
            )
            if cleanup_response.status != 204:
                raise AssertionError(
                    f"Workbench visual test could not close its browser runtime: HTTP {cleanup_response.status}"
                )
        print(
            json.dumps(
                {
                    "ok": True,
                    "workbenchLoaded": True,
                    "binaConnected": True,
                    "responsiveFit": True,
                    "liveChromiumStream": True,
                    "liveHoverInput": True,
                    "nonBlockingWheelInput": True,
                    "aiSessionPaneOnRight": True,
                    "splitLayout": split_layout,
                    "viewportStreamReconnect": {
                        "desktop": desktop_viewport_stream,
                        "mobile": mobile_viewport_stream,
                    },
                    "responsiveModes": responsive_metrics,
                    "viewerCleaned": bool(viewer_identity),
                    "metrics": metrics,
                    "screenshot": "/tmp/code-ai-workbench-visual-e2e.png",
                },
                ensure_ascii=False,
            )
        )
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
