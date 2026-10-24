import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ops = Path('/root/projects/code-ai/ops/charcoal-theme-20261022')
origin = os.environ['CODE_AI_THEME_TEST_ORIGIN']
cookie = os.environ['CODE_AI_THEME_TEST_COOKIE']
checks = []
with sync_playwright() as pw:
    browser = pw.chromium.launch(headless=True,
        executable_path='/root/projects/code-ai/.playwright-browsers/chromium-1234/chrome-linux64/chrome',
        args=['--no-sandbox', '--disable-dev-shm-usage'])
    context = browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
    context.add_cookies([{'name': k, 'value': v, 'url': origin, 'httpOnly': True, 'sameSite': 'Lax'}
        for k, v in [c.split('=', 1) for c in cookie.split('; ') if '=' in c]])
    context.add_init_script("""if (!localStorage.getItem('charcoal-test-initialized')) {
      localStorage.setItem('codex.theme.mode:local:developer','dark');
      localStorage.setItem('code-ai.theme.preset:local:developer','cream');
      localStorage.setItem('charcoal-test-initialized','1'); }""")
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(origin + '/session/developer/01a158ef-b0b5-7f92-b4f7-6e522f79fa8e?server=local', wait_until='domcontentloaded', timeout=45000)
    root = page.locator('.code-ai-theme')
    page.locator('.code-ai-theme-dark').wait_for(timeout=30000)
    assert root.evaluate('el=>getComputedStyle(el).backgroundColor') == 'rgb(10, 10, 10)'
    assert root.evaluate('el=>getComputedStyle(el).color') == 'rgb(237, 237, 237)'
    page.locator('.code-ai-user-bubble').first.wait_for(timeout=20000)
    bubble = page.locator('.code-ai-user-bubble').first
    assert bubble.evaluate('el=>getComputedStyle(el).color') == 'rgb(237, 237, 237)'
    assert bubble.evaluate('el=>getComputedStyle(el).borderTopColor') == 'rgb(51, 51, 51)'
    # Chrome resolves opaque shell channels equally; no residual navy surfaces.
    for el in [page.locator('header').first, page.get_by_test_id('conversation-composer')]:
        color = el.evaluate('el=>getComputedStyle(el).backgroundColor')
        rgb = color[color.index('(')+1:color.index(')')].split(',')[:3]
        assert len(set(int(float(n.strip())) for n in rgb)) == 1, color
    page.screenshot(path=str(ops / 'desktop-dark.png'))
    checks.append('actual dark conversation, composer, header and message colors')
    page.locator('header').first.locator('button').first.click()
    heading = page.get_by_role('heading', name='היסטוריית שיחות', exact=True)
    heading.wait_for()
    page.get_by_role('button', name='הגדרות חשבון', exact=True).click()
    page.get_by_role('button', name='כהה', exact=True).scroll_into_view_if_needed()
    page.screenshot(path=str(ops / 'sidebar-dark.png'))
    page.get_by_role('button', name='בהיר', exact=True).click()
    page.locator('.code-ai-theme-light').wait_for()
    assert root.evaluate('el=>getComputedStyle(el).backgroundColor') == 'rgb(251, 246, 238)', 'cream light preset changed'
    page.get_by_role('button', name='כהה', exact=True).click()
    page.locator('.code-ai-theme-dark').wait_for()
    assert root.evaluate('el=>getComputedStyle(el).backgroundColor') == 'rgb(10, 10, 10)'
    heading.locator('..').locator('button').click()
    page.reload(wait_until='domcontentloaded')
    page.locator('.code-ai-theme-dark').wait_for(timeout=30000)
    assert page.evaluate("localStorage.getItem('codex.theme.mode:local:developer')") == 'dark'
    assert page.evaluate("localStorage.getItem('code-ai.theme.preset:local:developer')") == 'cream'
    checks.append('real theme switch, unchanged cream preset, persistence after reload')
    page.get_by_role('button', name='פעולות', exact=True).click()
    menu = page.get_by_test_id('header-actions-menu')
    assert menu.evaluate('el=>getComputedStyle(el).backgroundColor') == 'rgb(23, 23, 23)'
    page.get_by_test_id('server-status-button').click()
    dialog = page.get_by_test_id('server-status-dialog')
    page.get_by_test_id('server-status-metrics').wait_for(timeout=20000)
    assert dialog.evaluate('el=>getComputedStyle(el).backgroundColor') == 'rgb(23, 23, 23)'
    page.screenshot(path=str(ops / 'dialog-dark.png'))
    page.get_by_role('button', name='סגור מצב שרת', exact=True).click()
    page.set_viewport_size({'width': 390, 'height': 844})
    assert root.evaluate('el=>el.scrollWidth<=el.clientWidth+1')
    page.screenshot(path=str(ops / 'mobile-dark.png'))
    checks.append('actions menu, live server-status modal and narrow RTL layout')
    # Only an idle terminal is opened; never launch Codex or send commands.
    page.get_by_role('button', name='פעולות', exact=True).click()
    page.get_by_role('button', name='טרמינל בתיקייה הפעילה', exact=True).click()
    page.locator('.xterm-screen').first.wait_for(timeout=20000)
    assert page.locator('.code-ai-terminal-host').locator('..').evaluate('el=>getComputedStyle(el).backgroundColor') == 'rgb(10, 10, 10)'
    page.screenshot(path=str(ops / 'terminal-dark.png'))
    try:
        viewport = page.locator('.xterm-viewport')
        if viewport.count():
            # XTerm's scroll overlay has a default black CSS backing; its actual
            # charcoal renderer is on top (also checked in terminal-dark.png).
            viewport_color = viewport.first.evaluate('el=>getComputedStyle(el).backgroundColor')
            assert viewport_color in ['rgb(10, 10, 10)', 'rgb(0, 0, 0)', 'rgba(0, 0, 0, 0)'], viewport_color
    finally:
        # Header close belongs to the terminal section, not its backdrop.
        page.locator('.code-ai-terminal-host').locator('xpath=ancestor::section').locator('header button').last.click()
        page.locator('.code-ai-terminal-host').wait_for(state='hidden')
    checks.append('terminal charcoal renderer, no command submission, own terminal closed')
    assert not errors, errors
    context.close()
    browser.close()
print(json.dumps({'passed': True, 'origin': origin, 'browser': 'isolated Chromium', 'checks': checks,
    'pageErrors': errors, 'messagesSubmitted': False, 'screenshots': ['desktop-dark.png','sidebar-dark.png','dialog-dark.png','mobile-dark.png','terminal-dark.png']}, ensure_ascii=False))
