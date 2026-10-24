import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(path.resolve('payload/package.json'));
const {build}=require('esbuild');
const {chromium}=createRequire(path.resolve('.browser-tools/package.json'))('playwright');
await mkdir('payload/.qualification/terminal-browser',{recursive:true});
await build({absWorkingDir:path.resolve('payload'),entryPoints:['ops/terminal-ux/fixture.tsx'],bundle:true,outfile:'.qualification/terminal-browser/app.js',format:'esm',jsx:'automatic',loader:{'.css':'css'}});
// Use the real compiled product stylesheet (including Tailwind layout), not a mock renderer.
const html=await readFile('payload/dist/public/index.html','utf8');
const css=html.match(/href="(\/assets\/[^" ]+\.css)"/)?.[1];assert.ok(css);
const server=createServer(async(req,res)=>{
  try {
    if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><html dir="rtl"><head><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');return;}
    const files={'/app.js':'payload/.qualification/terminal-browser/app.js','/fixture.css':'payload/.qualification/terminal-browser/app.css','/style.css':'payload/dist/public'+css};
    if(!files[req.url]){res.statusCode=404;res.end();return;}
    res.setHeader('content-type',req.url.endsWith('.js')?'application/javascript':'text/css');res.end(await readFile(files[req.url]));
  }catch{res.statusCode=500;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.CODE_AI_TERMINAL_BROWSER_EXECUTABLE?{executablePath:process.env.CODE_AI_TERMINAL_BROWSER_EXECUTABLE}:{}),args:['--no-sandbox','--disable-dev-shm-usage']});
const checks=[];
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:'+server.address().port);await page.getByRole('button',{name:'הפעל Codex · 0.162.1'}).waitFor();
 await page.waitForTimeout(500);
 const position=()=>page.locator('.xterm-rows > div').first().innerText();
 const before=await position();
 await page.getByRole('button',{name:'תחילת ההיסטוריה'}).click();await page.waitForTimeout(200);
 assert.match(await position(),/line 0 /);checks.push('history-top');
 await page.locator('.xterm-screen').hover();await page.mouse.wheel(0,180);await page.waitForTimeout(200);
 assert.doesNotMatch(await position(),/line 0 /);checks.push('wheel-history');
 assert.deepEqual(await page.evaluate(()=>window.terminalFixture.writes),[]);checks.push('history-wheel-does-not-send-input');
 await page.getByRole('button',{name:'סוף ההיסטוריה'}).click();await page.waitForTimeout(200);
 assert.equal(await position(),before);checks.push('history-bottom');
 await page.locator('.xterm-helper-textarea').focus();await page.keyboard.press('Shift+PageUp');await page.waitForTimeout(200);
 assert.notEqual(await position(),before);checks.push('keyboard-page-up');
 const scrolled=await position();
 await page.evaluate(()=>window.terminalFixture.chunks.push('new output while reading\r\n'));await page.waitForTimeout(400);
 assert.equal(await position(),scrolled);checks.push('new-output-preserves-reading-position');
 await page.getByRole('button',{name:'קריאה בעברית',exact:true}).click();
 const reader=page.getByLabel('פלט לקריאה בעברית');assert.ok((await reader.innerText()).includes('שלום עולם GPU 123'));
 assert.equal(await reader.evaluate(e=>getComputedStyle(e).unicodeBidi),'plaintext');checks.push('logical-hebrew-reader');
 const input=page.getByLabel('קלט לטרמינל בעברית ובאנגלית');await input.fill('שלום עולם\nGPU 123');
 assert.equal(await input.evaluate(e=>getComputedStyle(e).direction),'rtl');checks.push('hebrew-input-direction');
 await page.getByRole('button',{name:'הדבק קלט',exact:true}).click();await page.waitForTimeout(100);
 const pasted=await page.evaluate(()=>window.terminalFixture.writes.join(''));assert.ok(pasted.includes('שלום עולם\rGPU 123'));assert.ok(!pasted.endsWith('\r'));checks.push('paste-does-not-submit');
 await page.getByRole('button',{name:'שלח Enter',exact:true}).click();await page.waitForTimeout(100);
 assert.ok((await page.evaluate(()=>window.terminalFixture.writes.join(''))).endsWith('\r'));checks.push('explicit-enter');
 await input.fill('שורה אחת\nשורה שנייה');
 await page.evaluate(()=>{window.terminalFixture.writes.length=0;window.terminalFixture.chunks.push('\x1b[?2004l');});await page.waitForTimeout(400);
 await page.getByRole('button',{name:'הדבק קלט',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.terminalFixture.writes),[]);
 assert.equal(await input.inputValue(),'שורה אחת\nשורה שנייה');checks.push('unsupported-multiline-preserves-input-without-execution');
 await page.getByRole('button',{name:'קריאה בעברית',exact:true}).click();
 await page.evaluate(()=>window.terminalFixture.writes.length=0);
 await page.evaluate(()=>window.terminalFixture.chunks.push('\x1b[?1049h\x1b[?1000h\x1b[?1006hTUI'));await page.waitForTimeout(400);
 await page.locator('.xterm-screen').hover();await page.mouse.wheel(0,100);await page.waitForTimeout(100);
 assert.ok((await page.evaluate(()=>window.terminalFixture.writes.join(''))).includes('\x1b[<'));checks.push('interactive-mouse-forwarding');
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);checks.push('mobile-no-horizontal-overflow');
 assert.deepEqual(errors,[]);checks.push('no-browser-errors');
 await mkdir('dist/qualification',{recursive:true});await writeFile('dist/qualification/terminal-browser.json',JSON.stringify({passed:true,checks,realChromium:true,syntheticTerminalApi:true,liveModelTurn:false},null,2));
 console.log(JSON.stringify({terminalBrowserPassed:true,checks:checks.length}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
