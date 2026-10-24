import os, json, time
from playwright.sync_api import sync_playwright
origin=os.environ['CODE_AI_PERF_ORIGIN']
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path='/root/projects/code-ai/.playwright-browsers/chromium-1234/chrome-linux64/chrome',args=['--no-sandbox','--disable-dev-shm-usage'])
    context=browser.new_context(viewport={'width':1440,'height':1000})
    context.add_cookies([{'name':k,'value':v,'url':origin,'httpOnly':True,'sameSite':'Lax'} for k,v in [c.split('=',1) for c in os.environ['CODE_AI_PERF_COOKIE'].split('; ') if '=' in c]])
    page=context.new_page()
    errors=[]
    requests=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    started=time.monotonic()
    page.on('request',lambda req:requests.append({'path':req.url.split(origin)[-1],'ms':round((time.monotonic()-started)*1000)}) if '/api/codex/profiles' in req.url or '/api/codex/servers' in req.url else None)
    page.goto(origin+'/session/developer/01a158ef-b0b5-7f92-b4f7-6e522f79fa8e?server=local',wait_until='domcontentloaded',timeout=60000)
    dom=round((time.monotonic()-started)*1000)
    page.get_by_test_id('conversation-composer').wait_for(timeout=60000)
    composer=round((time.monotonic()-started)*1000)
    page.locator('.code-ai-user-bubble').first.wait_for(timeout=60000)
    content=round((time.monotonic()-started)*1000)
    passed=not errors
    if os.environ.get('CODE_AI_PERF_REQUIRE_FAST')=='1':
        profiles=next(x['ms'] for x in requests if x['path']=='/api/codex/profiles')
        refresh=next(x['ms'] for x in requests if x['path']=='/api/codex/servers?refresh=1')
        passed=passed and content<10000 and profiles<refresh
    page.wait_for_timeout(1500)
    resources=page.evaluate("performance.getEntriesByType('resource').filter(x=>x.name.includes('/api/')||x.initiatorType==='script').map(x=>({path:new URL(x.name).pathname+new URL(x.name).search,start:Math.round(x.startTime),ms:Math.round(x.duration),bytes:x.transferSize}))")
    assert not errors,errors
    print(json.dumps({'domMs':dom,'composerMs':composer,'conversationMs':content,'startupRequests':requests,'resources':resources,'pageErrors':errors,'messagesSubmitted':False,'passed':passed}))
    context.close()
    browser.close()
