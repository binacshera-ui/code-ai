#!/usr/bin/env python3
"""Actual Chromium UI read-only acceptance, with credentials supplied privately."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ops = Path('/root/projects/code-ai/ops/server-status-20261021')
origin = os.environ.get('CODE_AI_STATUS_TEST_ORIGIN', 'https://app-codex.bina-cshera.co.il')
cookie = os.environ['CODE_AI_STATUS_TEST_COOKIE']
checks = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True,
        executable_path='/root/projects/code-ai/.playwright-browsers/chromium-1234/chrome-linux64/chrome',
        args=['--no-sandbox', '--disable-dev-shm-usage'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
    context.add_cookies([{'name': name, 'value': value, 'url': origin, 'httpOnly': True, 'sameSite': 'Lax'}
        for name, value in [entry.split('=', 1) for entry in cookie.split('; ') if '=' in entry]])
    page = context.new_page()
    errors = []
    requests = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('request', lambda r: requests.append({'url': r.url.split('?')[0], 'method': r.method}) if '/api/codex/server-status' in r.url else None)
    page.goto(origin + '/?server=local', wait_until='domcontentloaded', timeout=45000)
    page.get_by_role('button', name='פעולות', exact=True).wait_for(timeout=30000)
    page.get_by_role('button', name='פעולות', exact=True).click()
    for text in ['משחקים', 'טרמינל בתיקייה הפעילה', 'מצב שרת']:
        assert page.get_by_test_id('header-actions-menu').get_by_text(text, exact=True).count() == 1, text
    page.get_by_test_id('server-status-button').click()
    dialog = page.get_by_test_id('server-status-dialog')
    dialog.wait_for()
    page.get_by_test_id('server-status-metrics').wait_for(timeout=20000)
    page.wait_for_function("!document.querySelector('[data-testid=server-status-metrics]').textContent.includes('ממתין לדגימה')", timeout=20000)
    for text in ['NVMe', 'HDD', 'RAM', 'CPU', 'enp9s0']:
        assert text in dialog.inner_text(), text
    assert dialog.get_attribute('data-server-id') == 'local'
    assert page.locator('[role=meter]').count() >= 4
    assert page.locator('svg[role=img]').count() >= 4
    page.get_by_text('הצג ניצול לפי ליבה', exact=False).click()
    assert page.get_by_role('meter', name='ניצול ליבה 1', exact=True).is_visible()
    page.screenshot(path=str(ops / 'desktop.png'))
    checks.append({'check': 'toolbar/open/live-values/cores/trends', 'passed': True})
    page.keyboard.press('Tab')
    assert dialog.evaluate('(d) => d.contains(document.activeElement)'), 'keyboard escaped dialog'
    page.keyboard.press('Escape')
    dialog.wait_for(state='hidden')
    count = len(requests)
    page.wait_for_timeout(4500)
    assert len(requests) == count, 'polling continued after close'
    checks.append({'check': 'keyboard/focus-trap/escape/stopped-polling', 'passed': True})
    page.get_by_role('button', name='פעולות', exact=True).click()
    page.get_by_test_id('server-status-button').click()
    page.get_by_test_id('server-status-metrics').wait_for(timeout=20000)
    # Change only DOM presentation of our isolated test tab; no user preference writes.
    page.locator('.code-ai-theme').evaluate("el => {el.classList.remove('code-ai-theme-light'); el.classList.add('code-ai-theme-dark');}")
    assert dialog.evaluate("el=>getComputedStyle(el).backgroundColor") == 'rgb(23, 23, 23)'
    page.screenshot(path=str(ops / 'desktop-dark.png'))
    page.set_viewport_size({'width': 390, 'height': 844})
    assert dialog.bounding_box()['width'] <= 390
    overflow = dialog.evaluate('(el)=>el.scrollWidth > el.clientWidth + 1')
    assert not overflow
    scroll_area = dialog.locator('.overflow-y-auto')
    scroll_area.evaluate('(el)=>el.scrollTop=el.scrollHeight')
    page.screenshot(path=str(ops / 'mobile-dark.png'))
    page.locator('.code-ai-theme').evaluate("el => {el.classList.remove('code-ai-theme-dark'); el.classList.add('code-ai-theme-light');}")
    scroll_area.evaluate('(el)=>el.scrollTop=0')
    page.screenshot(path=str(ops / 'mobile.png'))
    checks.append({'check': 'light/dark/RTL/mobile-scroll/no-overflow', 'passed': True})
    page.get_by_role('button', name='סגור מצב שרת', exact=True).click()
    # Force a main-endpoint outage in this test tab only; do not alter the API.
    page.route('**/api/codex/server-status', lambda route: route.fulfill(status=503, json={'error': 'unavailable'}))
    page.get_by_role('button', name='פעולות', exact=True).click()
    page.get_by_test_id('server-status-button').click()
    page.get_by_role('alert').wait_for(timeout=10000)
    assert page.get_by_test_id('server-status-metrics').count() == 0, 'stale values from closed instance leaked'
    page.unroute('**/api/codex/server-status')
    page.get_by_role('button', name='רענן מצב שרת', exact=True).click()
    page.get_by_test_id('server-status-metrics').wait_for(timeout=20000)
    page.get_by_role('button', name='סגור מצב שרת', exact=True).click()
    checks.append({'check': 'outage/clear-error/retry-real-data', 'passed': True})
    assert not errors, errors
    assert requests and all(r['method'] == 'GET' for r in requests)
    context.close()
    browser.close()
    print(json.dumps({'passed': True, 'browser': 'isolated Chromium on main server, not personal Chrome',
        'origin': origin, 'checks': checks, 'pageErrors': errors, 'metricsRequests': len(requests), 'metricsReadOnly': True,
        'screenshots': ['desktop.png', 'desktop-dark.png', 'mobile.png', 'mobile-dark.png']}, ensure_ascii=False))
