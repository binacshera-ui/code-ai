import os, json
from playwright.sync_api import sync_playwright

origin=os.environ['CODE_AI_CHECK_ORIGIN']
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path='/root/projects/code-ai/.playwright-browsers/chromium-1234/chrome-linux64/chrome',args=['--no-sandbox','--disable-dev-shm-usage'])
    context=browser.new_context(viewport={'width':1440,'height':1000})
    context.add_cookies([{'name':key,'value':value,'url':origin,'httpOnly':True,'sameSite':'Lax'} for key,value in [cookie.split('=',1) for cookie in os.environ['CODE_AI_CHECK_COOKIE'].split('; ') if '=' in cookie]])
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    response=page.goto(origin+'/session/developer/01a158ef-b0b5-7f92-b4f7-6e522f79fa8e?server=local',wait_until='domcontentloaded',timeout=60000)
    assert response.status==200
    page.get_by_test_id('conversation-composer').wait_for(timeout=60000)
    page.locator('.code-ai-user-bubble').first.wait_for(timeout=60000)
    page.wait_for_timeout(1500)
    assets=page.evaluate("performance.getEntriesByType('resource').filter(x=>x.initiatorType==='script').map(x=>new URL(x.name).pathname)")
    assert not errors,errors
    print(json.dumps({'passed':True,'origin':origin,'composerVisible':True,'conversationVisible':True,'pageErrors':errors,'scriptPaths':assets,'messagesSubmitted':False,'browser':'isolated Chromium, not personal Chrome'}))
    context.close()
    browser.close()
