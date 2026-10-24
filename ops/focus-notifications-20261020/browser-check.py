import json
import sys
from playwright.sync_api import sync_playwright

task = json.load(sys.stdin)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium-browser', headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    name, value = task['cookie'].split('=', 1)
    context.add_cookies([{'name': name, 'value': value, 'url': task['origin']}])
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda err: errors.append(str(err)))
    page.goto(task['origin'] + '/session/' + task['profileId'] + '/' + task['failedSessionId'])
    banner = page.get_by_test_id('incomplete-run-banner')
    try:
        banner.wait_for(timeout=20000)
    except Exception:
        page.screenshot(path=task['artifactRoot'] + '/browser-failure.png', full_page=True)
        print(json.dumps({'text': page.locator('body').inner_text()[-3500:], 'pageErrors': errors}), file=sys.stderr)
        raise
    assert 'המשימה לא הושלמה' in banner.inner_text()
    assert ('עמוס' if task.get('nativeOnly') else 'מכסת השימוש') in banner.inner_text()
    page.get_by_role('button', name='פעולות', exact=True).click()
    page.get_by_role('button', name='מצב הגיוני והכרעות', exact=True).click()
    dialog = page.get_by_role('dialog', name='מצב הגיוני והכרעות', exact=True)
    check = dialog.get_by_role('checkbox', name='הפעל שיקול דעת הנדסי', exact=True)
    check.wait_for()
    check.check(timeout=10000)
    dialog.get_by_role('checkbox', name='מצב הגיוני — תוכנית עם זמנים ועצירה').check()
    dialog.get_by_role('spinbutton', name='זמן לתכנון (דקות)').fill('2')
    dialog.get_by_role('spinbutton', name='תקרה לכל משימה (דקות)').fill('10')
    dialog.get_by_role('checkbox', name='מצב הכרעה — שמירת מקרים להחלטתי').check()
    dialog.get_by_role('textbox').fill('להשלים תוצר אחד ולבדוק אותו, בלי תיאום חוזר')
    dialog.get_by_role('button', name='שמור', exact=True).click()
    dialog.wait_for(state='hidden')
    page.get_by_role('button', name='פעולות', exact=True).click()
    page.get_by_role('button', name='מצב הגיוני והכרעות', exact=True).click()
    assert dialog.get_by_role('checkbox', name='הפעל שיקול דעת הנדסי', exact=True).is_checked()
    assert dialog.get_by_role('checkbox', name='מצב הגיוני — תוכנית עם זמנים ועצירה').is_checked()
    assert dialog.get_by_role('spinbutton', name='זמן לתכנון (דקות)').input_value() == '2'
    assert dialog.get_by_role('checkbox', name='מצב הכרעה — שמירת מקרים להחלטתי').is_checked()
    assert 'תוצר אחד' in dialog.get_by_role('textbox').input_value()
    dialog.get_by_role('button', name='סגור', exact=True).click()

    page.get_by_role('button', name='פעולות', exact=True).click()
    page.get_by_role('button', name='התראות סיום בטלפון').click()
    switch = page.get_by_role('switch', name='הפעל או כבה התראות סיום לשיחה')
    switch.wait_for()
    for enabled in [False, True]:
        switch.click(timeout=10000)
        page.wait_for_function("(expected) => {const e=document.querySelector('[role=switch][aria-label=\"הפעל או כבה התראות סיום לשיחה\"]'); return e && !e.disabled && e.getAttribute('aria-checked')===String(expected)}", arg=enabled)
    page.reload()
    page.get_by_role('button', name='פעולות', exact=True).click()
    page.get_by_role('button', name='התראות סיום בטלפון').click()
    assert page.get_by_role('switch', name='הפעל או כבה התראות סיום לשיחה').get_attribute('aria-checked') == 'true'
    assert not errors, 'Unexpected browser page errors'
    context.close()
    browser.close()
print(json.dumps({'browser': 'isolated local Chromium', 'incompleteBanner': True, 'focusSaveReopen': True, 'rationalDecisionSaveReopen': True, 'notificationOffOnReload': True, 'pageErrors': 0, 'personalChrome': False}))
