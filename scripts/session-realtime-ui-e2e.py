#!/usr/bin/env python3
import argparse
import json
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate live Codex session updates in the real React UI.")
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--session-path", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--profile-id", required=True)
    parser.add_argument("--session-title-fragment", required=True)
    args = parser.parse_args()

    marker = f"ui-live-e2e-{int(time.time() * 1000)}"
    page_errors: list[str] = []
    queue_request_count = 0

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path="/snap/bin/chromium",
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        page = browser.new_page(viewport={"width": 390, "height": 844})
        page.on("pageerror", lambda error: page_errors.append(str(error)))

        def count_queue_request(request) -> None:
            nonlocal queue_request_count
            if "/api/codex/queue/items" in request.url:
                queue_request_count += 1

        page.on("request", count_queue_request)
        page.goto(args.base_url, wait_until="domcontentloaded", timeout=30_000)
        page.locator("header button").first.click()
        session_card = page.locator("button").filter(
            has_text=args.session_title_fragment
        ).first
        session_card.wait_for(state="visible", timeout=10_000)
        with page.expect_response(
            lambda response: (
                f"/{args.session_id}/events?" in response.url
                and f"profile={args.profile_id}" in response.url
            ),
            timeout=30_000,
        ) as stream_info:
            session_card.click()
        assert stream_info.value.status == 200
        page.wait_for_timeout(200)

        timestamp = "2026-08-07T12:00:00.000Z"
        rows = [
            {"type": "event_msg", "timestamp": timestamp, "payload": {"type": "task_started"}},
            {"type": "event_msg", "timestamp": timestamp, "payload": {"type": "user_message", "message": marker}},
            {
                "type": "event_msg",
                "timestamp": timestamp,
                "payload": {"type": "agent_message", "phase": "commentary", "message": f"{marker}-answer"},
            },
        ]
        started_at = time.perf_counter()
        with Path(args.session_path).open("a", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")

        page.wait_for_function(
            """expected => document.body.innerText
                .replaceAll('\\u2068', '')
                .replaceAll('\\u2069', '')
                .includes(expected)""",
            arg=f"{marker}-answer",
            timeout=5_000,
        )
        visible_latency_ms = (time.perf_counter() - started_at) * 1000
        browser.close()

    if page_errors:
        raise AssertionError(f"page errors during realtime test: {page_errors}")
    if queue_request_count > 5:
        raise AssertionError(f"queue polling storm detected: {queue_request_count} requests")
    print(json.dumps({
        "visibleLatencyMs": round(visible_latency_ms, 1),
        "queueRequests": queue_request_count,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
