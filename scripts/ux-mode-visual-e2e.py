#!/usr/bin/env python3
"""Mobile UI smoke test for the session-scoped Codex × Gemini UX Debate Mode."""

from __future__ import annotations

import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("CODE_AI_E2E_BASE_URL", "http://127.0.0.1:4107").rstrip("/")
CHROMIUM = os.environ.get("CODE_AI_E2E_CHROMIUM", "/snap/bin/chromium")
DEVICE_PASSWORD = os.environ.get("CODE_AI_E2E_DEVICE_PASSWORD", "change-me-now")


def main() -> None:
    browser_path = Path(CHROMIUM)
    if not browser_path.exists():
        raise RuntimeError(f"Chromium executable was not found: {browser_path}")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=str(browser_path),
            args=["--no-sandbox"],
        )
        page = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=1)
        page.set_default_timeout(15_000)
        errors: list[str] = []
        page.on("pageerror", lambda error: errors.append(str(error)))

        unlock = page.request.post(
            f"{BASE_URL}/api/codex/device-unlock",
            data={"password": DEVICE_PASSWORD},
        )
        assert unlock.ok, unlock.text()

        # The app intentionally keeps background connections open (for live session
        # updates), so networkidle is neither reachable nor meaningful here.  Wait
        # for the initial document and then assert against an interactive control.
        page.goto(BASE_URL, wait_until="domcontentloaded")
        page.locator("button:has(svg.lucide-paperclip)").wait_for(state="visible")
        # Force a short mobile viewport: this is the state in which the header
        # action panel used to clip its lower controls instead of scrolling.
        page.set_viewport_size({"width": 390, "height": 480})
        page.get_by_role("button", name="פעולות").click()
        action_scroll_area = page.get_by_test_id("header-actions-scroll-area")
        action_scroll_area.wait_for(state="visible")
        assert action_scroll_area.evaluate("element => element.scrollHeight > element.clientHeight"), "Header actions must scroll internally on mobile"
        action_scroll_area.evaluate("element => { element.scrollTop = element.scrollHeight; }")
        page.get_by_role("button", name="טרמינל בתיקייה הפעילה").wait_for(state="visible")
        page.get_by_label("Close actions menu").click(position={"x": 8, "y": 8})
        page.set_viewport_size({"width": 390, "height": 844})
        page.locator("button:has(svg.lucide-paperclip)").click()
        page.get_by_text("מצבים", exact=True).click()
        page.get_by_text("מצב חוויית משתמש", exact=True).click()

        assert "חילופי טיעון" in page.locator("body").inner_text()
        assert "שאלה ניטרלית" in page.locator("body").inner_text()
        toggle = page.locator('[role="switch"]')
        assert toggle.count() == 1
        if toggle.get_attribute("aria-checked") != "true":
            toggle.click()

        page.get_by_label("בריף מוצר קבוע").fill("Onboarding must remain transparent and reach first value quickly.")
        with page.expect_response(
            lambda response: "/api/codex/session-ux-mode" in response.url
            and response.request.method == "POST"
        ) as saved_response:
            page.get_by_role("button", name="שמור מצב UX").click()
        payload = saved_response.value.json()
        assert payload["uxMode"]["enabled"] is True
        assert payload["uxMode"]["depth"] == "deep"

        chip = page.get_by_text(re.compile(r"^מצב UX ·"))
        chip.wait_for(state="visible")
        chip.click()
        with page.expect_response(
            lambda response: "/api/codex/session-ux-mode" in response.url
            and response.request.method == "POST"
        ) as disabled_response:
            page.get_by_role("button", name="כבה מצב").click()
        assert disabled_response.value.json()["uxMode"]["enabled"] is False
        assert not errors, f"Browser page errors: {errors}"
        browser.close()

    print("UX_MODE_VISUAL_E2E_OK")


if __name__ == "__main__":
    main()
