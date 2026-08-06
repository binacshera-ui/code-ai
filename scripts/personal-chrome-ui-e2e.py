#!/usr/bin/env python3
import asyncio
import json
import os
from pathlib import Path

from playwright.async_api import async_playwright


APP_ROOT = Path(__file__).resolve().parents[1]
BASE_URL = os.environ.get("CODE_AI_E2E_BASE_URL", "http://127.0.0.1:4106").rstrip("/")
CHROMIUM = os.environ.get(
    "CODE_AI_E2E_CHROMIUM",
    str(APP_ROOT / ".playwright-browsers/chromium-1223/chrome-linux64/chrome"),
)


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=CHROMIUM, headless=True)
        page = await browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=1)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        await page.goto(f"{BASE_URL}/chat", wait_until="networkidle")

        paperclip = page.locator("svg.lucide-paperclip").last
        await paperclip.wait_for(timeout=15_000)
        await paperclip.locator("xpath=..").click()
        additions = page.get_by_text("תוספות לשיחה", exact=True)
        await additions.wait_for(state="visible")
        await page.get_by_text("מצבים", exact=True).last.click()
        await page.get_by_text("Chrome אישי", exact=True).wait_for(state="visible")

        modes_scroller = page.locator("div.overflow-y-auto").filter(has=page.get_by_text("Chrome אישי", exact=True)).first
        dimensions = await modes_scroller.evaluate(
            "element => ({clientHeight: element.clientHeight, scrollHeight: element.scrollHeight})"
        )
        assert dimensions["clientHeight"] <= 744
        assert dimensions["scrollHeight"] >= dimensions["clientHeight"]

        await page.get_by_text("Chrome אישי", exact=True).click()
        await page.get_by_text("המכשירים שלי", exact=True).wait_for(state="visible")
        await page.get_by_text("חיבור תוסף חדש", exact=True).scroll_into_view_if_needed()
        dialog = page.get_by_text("Personal Chrome", exact=True).locator("xpath=ancestor::section")
        box = await dialog.bounding_box()
        assert box and box["height"] <= 844
        assert not errors, errors
        print(json.dumps({"ok": True, "viewport": "390x844", "modes": dimensions, "dialogHeight": round(box["height"])}))
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
