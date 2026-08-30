#!/usr/bin/env python3
"""Mobile UI smoke test for the session-scoped Codex × Gemini Design Mode."""

from __future__ import annotations

import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("CODE_AI_E2E_BASE_URL", "http://127.0.0.1:4107").rstrip("/")
CHROMIUM = os.environ.get("CODE_AI_E2E_CHROMIUM", "/snap/bin/chromium")


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
        page_errors: list[str] = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        page.goto(BASE_URL, wait_until="networkidle")
        page.locator("button:has(svg.lucide-paperclip)").click()
        page.get_by_text("מצבים", exact=True).click()
        page.get_by_text("מצב עיצוב", exact=True).click()

        canvas = page.locator("canvas")
        canvas.wait_for(state="visible")
        assert "Codex × Gemini" in page.locator("body").inner_text()
        assert "חיתוך ממוקד" in page.locator("body").inner_text()

        bounds = canvas.bounding_box()
        assert bounds is not None
        page.mouse.move(bounds["x"] + 35, bounds["y"] + 35)
        page.mouse.down()
        page.mouse.move(bounds["x"] + min(180, bounds["width"] - 20), bounds["y"] + 90, steps=8)
        page.mouse.up()

        mode_switch = page.locator('[role="switch"]')
        assert mode_switch.count() == 1
        if mode_switch.get_attribute("aria-checked") != "true":
            mode_switch.click()

        with page.expect_response(
            lambda response: "/api/codex/session-design-mode" in response.url
            and response.request.method == "POST"
        ) as save_response:
            page.get_by_role("button", name="שמור מצב עיצוב").click()
        saved_payload = save_response.value.json()
        assert saved_payload["designMode"]["enabled"] is True
        assert saved_payload["designMode"]["canvasAvailable"] is True

        active_chip = page.get_by_text(re.compile(r"^מצב עיצוב ·"))
        active_chip.wait_for(state="visible")
        assert "קנבס" in active_chip.inner_text()
        active_chip.click()

        with page.expect_response(
            lambda response: "/api/codex/session-design-mode" in response.url
            and response.request.method == "POST"
        ) as disable_response:
            page.get_by_role("button", name="כבה מצב").click()
        disabled_payload = disable_response.value.json()
        assert disabled_payload["designMode"]["enabled"] is False
        assert not page_errors, f"Browser page errors: {page_errors}"
        browser.close()

    print("DESIGN_MODE_VISUAL_E2E_OK")


if __name__ == "__main__":
    main()
