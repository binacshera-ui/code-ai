#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import urllib.request
import uuid
from datetime import UTC, datetime
from pathlib import Path

from playwright.sync_api import sync_playwright


SSO_PATH = "/api/runtime/internal/workbench-sso/session"
SSO_ORIGIN = "http://127.0.0.1:46120"
PUBLIC_ORIGIN = "https://app.bina-cshera.co.il"
SECRET_FILE = Path(
    os.environ.get(
        "BINA_WORKBENCH_SSO_SECRET_FILE",
        "/root/.bina-cshera-secrets/runtime/workbench-sso.secret",
    )
)


def base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def issue_runtime_session() -> str:
    secret = SECRET_FILE.read_text("utf-8").strip().encode("utf-8")
    if len(secret) < 32:
        raise RuntimeError("Workbench SSO secret is not configured")
    timestamp = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    nonce = base64url(secrets.token_bytes(24))
    body = json.dumps(
        {
            "audience": PUBLIC_ORIGIN,
            "requestId": str(uuid.uuid4()),
            "workbenchSessionHash": hashlib.sha256(b"live-e2e-workbench-session").hexdigest(),
        },
        separators=(",", ":"),
    ).encode("utf-8")
    body_hash = base64url(hashlib.sha256(body).digest())
    canonical = "\n".join(
        ["bina-workbench-sso-v1", "POST", SSO_PATH, timestamp, nonce, body_hash]
    ).encode("utf-8")
    signature = base64url(hmac.new(secret, canonical, hashlib.sha256).digest())
    request = urllib.request.Request(
        f"{SSO_ORIGIN}{SSO_PATH}",
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Bina-Workbench-Nonce": nonce,
            "X-Bina-Workbench-Signature": signature,
            "X-Bina-Workbench-Timestamp": timestamp,
        },
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        payload = json.load(response)
    runtime_session = str(payload.get("sessionId") or "")
    uuid.UUID(runtime_session)
    return runtime_session


def main() -> None:
    runtime_session = issue_runtime_session()
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
        context = browser.new_context(locale="he-IL")
        context.add_cookies(
            [
                {
                    "name": "bina_rt_sid",
                    "value": runtime_session,
                    "domain": "app.bina-cshera.co.il",
                    "path": "/",
                    "httpOnly": True,
                    "secure": True,
                    "sameSite": "Lax",
                }
            ]
        )
        page = context.new_page()
        page.goto(PUBLIC_ORIGIN, wait_until="domcontentloaded", timeout=45_000)
        page.wait_for_function(
            """() => {
              const text = document.body?.innerText || '';
              return text.includes('מנוע') || text.includes('מרחב') || text.includes('בית היוצר');
            }""",
            timeout=45_000,
        )
        body_text = page.locator("body").inner_text()
        if "התחבר למערכת" in body_text:
            raise AssertionError("Bina 3 displayed its login form after Workbench SSO")
        print(
            json.dumps(
                {
                    "ok": True,
                    "bina3Loaded": True,
                    "loginSkipped": True,
                    "bstSessionAccepted": True,
                },
                ensure_ascii=False,
            )
        )
        context.close()
        browser.close()


if __name__ == "__main__":
    main()
