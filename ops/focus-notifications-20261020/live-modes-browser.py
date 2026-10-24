import json
import sys
from playwright.sync_api import sync_playwright

task = json.load(sys.stdin)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium-browser', headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 430, 'height': 932}, device_scale_factor=1)
    context.add_cookies([{'name': pair.split('=', 1)[0], 'value': pair.split('=', 1)[1], 'url': task['origin']} for pair in task['cookies']])
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(task['origin'] + '/session/developer/01a05cd0-8a16-7752-9558-1dbe4f9ebd3f', wait_until='domcontentloaded')
    try:
        page.get_by_role('button', name='פעולות', exact=True).wait_for(timeout=30000)
        page.get_by_role('button', name='פעולות', exact=True).click()
        page.get_by_role('button', name='מצב הגיוני והכרעות', exact=True).wait_for(timeout=10000)
        page.screenshot(path=task['artifactRoot']+'/actions-menu.png')
        page.get_by_role('button', name='מצב הגיוני והכרעות', exact=True).click()
        dialog = page.get_by_role('dialog', name='מצב הגיוני והכרעות', exact=True)
        rational = dialog.get_by_role('checkbox', name='מצב הגיוני — תוכנית עם זמנים ועצירה')
        decision = dialog.get_by_role('checkbox', name='מצב הכרעה — שמירת מקרים להחלטתי')
        rational.wait_for(timeout=15000)
        page.wait_for_function("() => {const b=[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='שמור');return b&&!b.disabled}")
        assert rational.is_visible() and decision.is_visible()
        assert not rational.is_disabled() and not decision.is_disabled()
        assert dialog.get_by_role('link', name='פתח מרכז הכרעה').is_visible()
        page.screenshot(path=task['artifactRoot']+'/work-modes-live.png')
        print(json.dumps({'ok':True,'origin':task['origin'],'browser':'isolated local Chromium, live production site','personalChrome':False,'mobile':True,'rationalVisible':True,'decisionVisible':True,'preferencesLoaded':True,'preferencesChanged':False,'decisionCenterLinkVisible':True,'pageErrors':errors}))
    except Exception:
        page.screenshot(path=task['artifactRoot']+'/work-modes-failure.png')
        print(json.dumps({'ok':False,'bodyTail':page.locator('body').inner_text()[-2000:],'pageErrors':errors}), file=sys.stderr)
        raise
    finally:
        context.close()
        browser.close()
