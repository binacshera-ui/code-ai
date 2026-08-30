#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

from playwright.sync_api import sync_playwright


WORKBENCH_ORIGIN = os.environ.get(
    "CODE_AI_WORKBENCH_ORIGIN",
    "https://app-code-ai.bina-cshera.co.il",
).rstrip("/")


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


def read_device_password() -> str:
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


def wait_for_viewer_identity(page, expected_profile: str, expected_session_key: str) -> dict[str, str]:
    identity: dict[str, str] = {}

    def remember(request) -> None:
        parsed = urlparse(request.url)
        if parsed.path != "/api/codex/session-browser-viewer":
            return
        query = parse_qs(parsed.query)
        profile_id = (query.get("profileId") or [""])[0]
        session_key = (query.get("sessionKey") or [""])[0]
        if profile_id and session_key:
            identity.update({"profileId": profile_id, "sessionKey": session_key})

    page.on("request", remember)
    expected_path = (
        f"/session/{quote(expected_profile, safe='')}/draft/"
        f"{quote(expected_session_key, safe='')}"
    )
    page.goto(f"{WORKBENCH_ORIGIN}{expected_path}", wait_until="domcontentloaded", timeout=45_000)
    page.locator('input[placeholder="https://example.com"]').wait_for(state="visible", timeout=45_000)
    deadline = time.monotonic() + 45
    while not identity and time.monotonic() < deadline:
        page.wait_for_timeout(100)
    if identity != {"profileId": expected_profile, "sessionKey": expected_session_key}:
        raise AssertionError(
            f"Wrong viewer binding for {expected_path}: expected "
            f"{expected_profile}/{expected_session_key}, got {identity}"
        )
    if urlparse(page.url).path != expected_path:
        raise AssertionError(f"Workbench route drifted: expected {expected_path}, got {page.url}")
    frame_src = page.locator('iframe[title="Code-AI"]').get_attribute("src") or ""
    expected_frame_prefix = (
        f"/chat/session/{quote(expected_profile, safe='')}/draft/"
        f"{quote(expected_session_key, safe='')}"
    )
    if not frame_src.startswith(expected_frame_prefix):
        raise AssertionError(f"Chat iframe is not bound to its outer route: {frame_src}")
    return identity


def get_viewer(context, identity: dict[str, str]) -> dict:
    response = context.request.get(
        f"{WORKBENCH_ORIGIN}/api/codex/session-browser-viewer",
        params=identity,
    )
    if not response.ok:
        raise AssertionError(f"Viewer state returned HTTP {response.status}: {identity}")
    return response.json().get("viewer") or {}


def navigate_viewer(context, identity: dict[str, str], target_url: str) -> dict:
    viewer = get_viewer(context, identity)
    response = context.request.post(
        f"{WORKBENCH_ORIGIN}/api/codex/session-browser-viewer/action",
        data={
            **identity,
            "action": "navigate",
            "tabId": viewer.get("currentTabId"),
            "url": target_url,
        },
    )
    if not response.ok:
        raise AssertionError(f"Viewer navigation returned HTTP {response.status}: {identity}")
    return response.json().get("viewer") or {}


def main() -> None:
    password = read_device_password()
    if not password:
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

    suffix = uuid.uuid4().hex
    draft_keys = [f"draft-parallel-a-{suffix}", f"draft-parallel-b-{suffix}"]
    targets = [
        f"https://example.com/?code-ai-tab=a-{suffix}",
        f"https://example.org/?code-ai-tab=b-{suffix}",
    ]
    identities: list[dict[str, str]] = []
    pages = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=executable_path,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context = browser.new_context(viewport={"width": 1440, "height": 900}, locale="he-IL")
        try:
            unlock = context.request.post(
                f"{WORKBENCH_ORIGIN}/api/codex/device-unlock",
                data={"password": password},
            )
            if not unlock.ok:
                raise AssertionError(f"Device unlock returned HTTP {unlock.status}")
            profiles_response = context.request.get(f"{WORKBENCH_ORIGIN}/api/codex/profiles")
            if not profiles_response.ok:
                raise AssertionError(f"Profiles returned HTTP {profiles_response.status}")
            profiles = profiles_response.json().get("profiles") or []
            profile = next((item for item in profiles if item.get("provider") == "codex"), None)
            if not profile:
                raise AssertionError("No Codex profile is available for the parallel-tab test")
            profile_id = str(profile["id"])

            pages = [context.new_page(), context.new_page()]
            for page, draft_key in zip(pages, draft_keys, strict=True):
                identities.append(wait_for_viewer_identity(page, profile_id, draft_key))

            first_viewer = navigate_viewer(context, identities[0], targets[0])
            second_viewer = navigate_viewer(context, identities[1], targets[1])
            if first_viewer.get("profileDir") == second_viewer.get("profileDir"):
                raise AssertionError("Parallel routes unexpectedly share one Chromium profile directory")
            if first_viewer.get("currentUrl") != targets[0] or second_viewer.get("currentUrl") != targets[1]:
                raise AssertionError(
                    f"Parallel viewer URLs crossed: {first_viewer.get('currentUrl')} / "
                    f"{second_viewer.get('currentUrl')}"
                )

            for page, target_url in zip(pages, targets, strict=True):
                page.wait_for_function(
                    """(expected) => {
                      const input = document.querySelector('input[placeholder="https://example.com"]');
                      return input instanceof HTMLInputElement && input.value === expected;
                    }""",
                    arg=target_url,
                    timeout=20_000,
                )

            scoped_storage = pages[0].evaluate(
                """() => Object.fromEntries(
                  Object.entries(localStorage).filter(([key]) => key.startsWith('code-ai-workbench-target-url:v2:'))
                )"""
            )
            if not all(target in scoped_storage.values() for target in targets):
                raise AssertionError(f"Session-scoped target URLs were not persisted independently: {scoped_storage}")

            for page, draft_key, target_url in zip(pages, draft_keys, targets, strict=True):
                page.reload(wait_until="domcontentloaded", timeout=45_000)
                page.locator('input[placeholder="https://example.com"]').wait_for(state="visible", timeout=45_000)
                page.wait_for_function(
                    """(expected) => {
                      const input = document.querySelector('input[placeholder="https://example.com"]');
                      return input instanceof HTMLInputElement && input.value === expected;
                    }""",
                    arg=target_url,
                    timeout=30_000,
                )
                if draft_key not in urlparse(page.url).path:
                    raise AssertionError(f"Reload lost the tab's canonical session route: {page.url}")

            persisted = [get_viewer(context, identity) for identity in identities]
            if [viewer.get("currentUrl") for viewer in persisted] != targets:
                raise AssertionError(f"Reload crossed persisted viewer state: {persisted}")

            print(
                json.dumps(
                    {
                        "ok": True,
                        "profileId": profile_id,
                        "parallelRoutes": [urlparse(page.url).path for page in pages],
                        "sessionKeys": draft_keys,
                        "internalUrls": targets,
                        "separateProfileDirs": [viewer.get("profileDir") for viewer in persisted],
                        "reloadPreservedBindings": True,
                    },
                    ensure_ascii=False,
                )
            )
        finally:
            for page in pages:
                if not page.is_closed():
                    page.close()
            for identity in identities:
                context.request.delete(
                    f"{WORKBENCH_ORIGIN}/api/codex/session-browser-viewer",
                    params=identity,
                )
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
