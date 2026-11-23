#!/usr/bin/env python3
"""Visual smoke test for the layered architecture-flow canvas."""

from __future__ import annotations

import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("CODE_AI_E2E_BASE_URL", "http://127.0.0.1:4107").rstrip("/")
PROFILE_ID = os.environ.get("CODE_AI_E2E_PROFILE_ID", "developer")
SESSION_ID = os.environ.get("CODE_AI_E2E_FLOW_SESSION_ID", "01a07747-f2f5-7640-8327-629bb570c214")
CHROMIUM = os.environ.get("CODE_AI_E2E_CHROMIUM", "/snap/bin/chromium")


def read_dotenv_value(name: str) -> str:
    for filename in (".env", ".env.paths"):
        path = ROOT / filename
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.startswith(f"{name}="):
                continue
            return line.split("=", 1)[1].strip().strip("'\"")
    return ""


def configured_device_password() -> str:
    configured = os.environ.get("CODE_AI_E2E_DEVICE_PASSWORD") or read_dotenv_value("CODEX_DEVICE_ADMIN_PASSWORD")
    if configured:
        return configured
    config_source = (ROOT / "server" / "config.ts").read_text(encoding="utf-8")
    fallback = re.search(
        r"deviceAdminPassword:\s*process\.env\.CODEX_DEVICE_ADMIN_PASSWORD\s*\|\|\s*(['\"])(.*?)\1",
        config_source,
    )
    return fallback.group(2) if fallback else ""


def open_flow(page, composer_draft: str = "") -> None:
    password = configured_device_password()
    if not password:
        raise RuntimeError("CODEX_DEVICE_ADMIN_PASSWORD is not configured")
    unlock = page.request.post(f"{BASE_URL}/api/codex/device-unlock", data={"password": password})
    assert unlock.ok, f"device unlock failed with HTTP {unlock.status}"
    page.goto(f"{BASE_URL}/chat/session/{PROFILE_ID}/{SESSION_ID}", wait_until="domcontentloaded")
    if composer_draft:
        composer = page.get_by_placeholder("הודעה חדשה, בקשה או תזמון...")
        composer.wait_for(state="visible", timeout=30_000)
        composer.fill(composer_draft)
    flow_chip = page.get_by_text(re.compile(r"^זרימה ·"))
    flow_chip.wait_for(state="visible", timeout=30_000)
    flow_chip.click()
    page.get_by_role("tablist", name="מפות הזרימה בסשן").wait_for(state="visible", timeout=20_000)
    page.get_by_role("button", name="מפה חדשה").wait_for(state="visible", timeout=20_000)
    page.get_by_role("button", name=re.compile(r"^התחלה ")).wait_for(state="visible", timeout=20_000)
    page.locator(".react-flow__node").first.wait_for(state="visible", timeout=20_000)


def assert_canvas(page, expected_min_nodes: int) -> None:
    nodes = page.locator(".react-flow__node")
    assert nodes.count() >= expected_min_nodes, f"expected at least {expected_min_nodes} nodes, got {nodes.count()}"
    assert page.locator(".react-flow__edge-path").count() > 0, "flow edges were not rendered"
    assert page.get_by_text(re.compile(r"^שלב \d+ מתוך \d+$")).count() >= expected_min_nodes
    assert page.get_by_text("התחלה", exact=True).count() > 0
    assert page.get_by_text(re.compile(r"^(סיום|יעד)$")).count() > 0
    viewport = page.viewport_size
    assert viewport is not None
    overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
    assert overflow <= 1, f"dialog causes horizontal page overflow: {overflow}px"


def visible_node_ids(page) -> list[str]:
    return page.locator(".react-flow__node").evaluate_all(
        """nodes => {
            const canvas = document.querySelector('.react-flow')?.getBoundingClientRect();
            if (!canvas) return [];
            return nodes.filter(node => {
                const rect = node.getBoundingClientRect();
                return rect.right > canvas.left && rect.left < canvas.right
                    && rect.bottom > canvas.top && rect.top < canvas.bottom;
            }).map(node => node.dataset.id || '');
        }"""
    )


def main() -> None:
    errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=CHROMIUM,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )

        desktop = browser.new_page(viewport={"width": 1440, "height": 960}, device_scale_factor=1)
        desktop.set_default_timeout(20_000)
        desktop.on("pageerror", lambda error: errors.append(str(error)))
        existing_draft = "זו טיוטה שכבר נכתבה ואסור למחוק אותה"
        open_flow(desktop, existing_draft)
        desktop.get_by_role("button", name="מפה חדשה").click()
        desktop.get_by_role("heading", name="יצירת מפה חדשה").wait_for(state="visible")
        desktop.get_by_role("textbox", name="שם המפה").wait_for(state="visible")
        desktop.get_by_role("button", name="ביטול").click()
        assert_canvas(desktop, 40)
        desktop.wait_for_timeout(700)
        visible_desktop_nodes = visible_node_ids(desktop)
        assert visible_desktop_nodes, "automatic entry focus left every desktop node outside the viewport"
        desktop.screenshot(path="/tmp/code-ai-flow-layout-desktop-before-focus.png", full_page=True)
        desktop.locator(f'.react-flow__node[data-id="{visible_desktop_nodes[0]}"]').click()
        assert desktop.locator(".react-flow__node .opacity-20").count() > 0, "node click did not focus its route"
        desktop.screenshot(path="/tmp/code-ai-flow-layout-desktop.png", full_page=True)
        flow_request = "בדוק את המודול הזה והמשך לטפל בו"
        desktop.locator(
            'textarea[placeholder^="מה תרצה"], textarea[placeholder^="למשל:"]'
        ).first.fill(flow_request)
        desktop.get_by_role("button", name="העבר לתיבת ההודעה").click()
        composer = desktop.get_by_placeholder("הודעה חדשה, בקשה או תזמון...")
        composer.wait_for(state="visible")
        combined_prompt = composer.input_value()
        assert combined_prompt.startswith(existing_draft), "flow handoff replaced the existing composer draft"
        assert flow_request in combined_prompt, "flow handoff was not appended to the composer"

        mobile = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=1)
        mobile.set_default_timeout(20_000)
        mobile.on("pageerror", lambda error: errors.append(str(error)))
        open_flow(mobile)
        assert_canvas(mobile, 40)
        mobile.wait_for_timeout(700)
        assert visible_node_ids(mobile), "automatic entry focus left every mobile node outside the viewport"
        mobile.get_by_role("button", name="פתח רק את הזרימה על כל המסך").click()
        mobile.get_by_role("button", name=re.compile(r"חזור למסך העריכה")).wait_for(state="visible")
        canvas_box = mobile.locator(".react-flow").bounding_box()
        assert canvas_box and canvas_box["height"] >= 800, f"mobile full-screen canvas is too short: {canvas_box}"
        mobile.screenshot(path="/tmp/code-ai-flow-layout-mobile.png", full_page=True)

        browser.close()

    assert not errors, f"browser page errors: {errors}"
    print("FLOW_MODE_VISUAL_E2E_OK")


if __name__ == "__main__":
    main()
