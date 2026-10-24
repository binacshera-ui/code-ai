import json
import sys
from playwright.sync_api import sync_playwright

task = json.load(sys.stdin)
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium-browser', headless=True, args=['--no-sandbox'])
    context = browser.new_context(viewport={'width': 1100, 'height': 850})
    name, value = task['cookie'].split('=', 1)
    context.add_cookies([{'name': name, 'value': value, 'url': task['origin']}])
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(task['origin'] + '/api/codex/incident-center')
    page.locator('[data-case-id="' + task['caseId'] + '"]').click()
    note = page.locator('#operator-note')
    note.fill('הכרעה דרך הדפדפן: בדוק את המקרה הסינתטי בלבד.')
    page.reload()
    page.locator('[data-case-id="' + task['caseId'] + '"]').click()
    assert 'דרך הדפדפן' in page.locator('#operator-note').input_value()
    page.get_by_role('button', name='שמור הכרעה והמשך טיפול', exact=True).click()
    page.wait_for_function("document.querySelector('#decision-feedback')?.textContent.includes('נשמרה')")
    assert not errors, errors
    context.close()
    browser.close()
print(json.dumps({'browser': 'isolated local Chromium', 'savedDraftAcrossReload': True, 'verdictSubmitted': True, 'pageErrors': 0}))
