#!/usr/bin/env python3
import argparse
import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


def latest_assistant_text(session_path: str) -> str:
    target = Path(session_path)
    with target.open("rb") as handle:
        size = handle.seek(0, 2)
        handle.seek(max(0, size - 2 * 1024 * 1024))
        raw = handle.read().decode("utf-8", errors="ignore")
    for line in reversed(raw.splitlines()):
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        payload = row.get("payload") or {}
        if row.get("type") == "event_msg" and payload.get("type") == "agent_message":
            text = payload.get("message")
            if isinstance(text, str) and text.strip():
                return text.strip()
    raise AssertionError("destination fixture has no assistant message in its final 2MB")


def visible_text_probe(markdown: str) -> str:
    for raw_line in markdown.splitlines():
        line = re.sub(r"!?\[([^\]]+)\]\([^)]*\)", r"\1", raw_line)
        line = re.sub(r"^[\s>#*+\-`_~]+|[\s*`_~]+$", "", line).strip()
        if len(line) >= 12:
            return line[:180]
    compact = re.sub(r"\s+", " ", markdown).strip()
    if not compact:
        raise AssertionError("destination assistant message has no visible text")
    return compact[:180]


def main() -> None:
    parser = argparse.ArgumentParser(description="Measure sidebar session-open latency in the real React UI.")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--profile-id", required=True)
    parser.add_argument("--source-session-id", required=True)
    parser.add_argument("--source-title-fragment", required=True)
    parser.add_argument("--destination-session-id", required=True)
    parser.add_argument("--destination-session-path", required=True)
    parser.add_argument("--destination-title-fragment", required=True)
    args = parser.parse_args()

    expected_text = visible_text_probe(latest_assistant_text(args.destination_session_path))
    page_errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path="/snap/bin/chromium",
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = browser.new_context(viewport={"width": 390, "height": 844})
        unlock_cookie = os.environ.get("CODE_AI_DEVICE_UNLOCK_COOKIE", "").strip()
        if unlock_cookie:
            parsed_url = urlparse(args.base_url)
            context.add_cookies([{
                "name": "code_ai_device_unlock",
                "value": unlock_cookie,
                "url": f"{parsed_url.scheme}://{parsed_url.netloc}",
                "httpOnly": True,
                "sameSite": "Lax",
            }])
        page = context.new_page()
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto(args.base_url, wait_until="domcontentloaded", timeout=30_000)
        page.locator("header button").first.click()
        source_card = page.locator("button").filter(
            has_text=args.source_title_fragment
        ).first
        source_card.wait_for(state="visible", timeout=10_000)
        with page.expect_response(
            lambda response: f"/{args.source_session_id}/events" in response.url,
            timeout=30_000,
        ):
            source_card.click()

        page.locator("header button").first.click()
        destination_card = page.locator("button").filter(
            has_text=args.destination_title_fragment
        ).first
        destination_card.wait_for(state="visible", timeout=10_000)
        destination_card.hover()
        page.wait_for_timeout(300)
        visible_latency_ms = destination_card.evaluate(
            """(element, expected) => new Promise((resolve, reject) => {
                const normalize = value => value.replaceAll('\\u2068', '').replaceAll('\\u2069', '');
                const startedAt = performance.now();
                const check = () => {
                    if (!normalize(document.body.innerText).includes(expected)) return false;
                    observer.disconnect();
                    clearTimeout(timeout);
                    resolve(performance.now() - startedAt);
                    return true;
                };
                const observer = new MutationObserver(check);
                observer.observe(document.body, {childList: true, subtree: true, characterData: true});
                const timeout = setTimeout(() => {
                    observer.disconnect();
                    reject(new Error('destination session did not become visible'));
                }, 5000);
                element.click();
                check();
            })""",
            expected_text.replace("\u2068", "").replace("\u2069", ""),
        )
        browser.close()

    if page_errors:
        raise AssertionError(f"page errors during session click test: {page_errors}")
    print(json.dumps({"clickToVisibleMs": round(visible_latency_ms, 1)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
