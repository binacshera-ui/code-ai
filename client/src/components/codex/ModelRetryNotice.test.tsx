import assert from 'node:assert/strict';
import test from 'node:test';
import {renderToStaticMarkup} from 'react-dom/server';
import {ModelRetryNotice} from './ModelRetryNotice';
test('retry status renders accessible Hebrew countdown from a persisted timestamp', t=>{
 const now=Date.parse('2026-10-25T12:00:00Z');t.mock.timers.enable({apis:['Date'],now});
 const notice={itemId:'synthetic',retryAt:new Date(now+60000).toISOString(),confirmingStop:false,attempt:1};
 let html=renderToStaticMarkup(<ModelRetryNotice notice={notice}/>);
 assert.match(html,/מנסה שוב בעוד 60 שניות/);assert.match(html,/data-testid="model-retry-notice"/);assert.match(html,/dir="rtl"/);
 t.mock.timers.tick(13000);html=renderToStaticMarkup(<ModelRetryNotice notice={notice}/>);assert.match(html,/47 שניות/);
 t.mock.timers.tick(47000);html=renderToStaticMarkup(<ModelRetryNotice notice={notice}/>);assert.match(html,/ממתין להפעלת הניסיון הבא/);
});
