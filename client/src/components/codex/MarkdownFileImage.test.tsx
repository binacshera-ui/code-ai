import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { HtmlFilePreview } from './HtmlFilePreview';
import { MarkdownFileImage, MarkdownImageLinkContext } from './MarkdownFileImage';
import { markdownFileUrlTransform } from './markdownFiles';

function renderMarkdownImage(text: string, serverId = 'beam', cwd = '/root/design') {
  return renderToStaticMarkup(
    <ReactMarkdown
      urlTransform={markdownFileUrlTransform}
      components={{ img: ({ src, alt, title }) => (
        <MarkdownFileImage src={typeof src === 'string' ? src : undefined} alt={alt} title={title} serverId={serverId} cwd={cwd} onOpenFilePreview={() => undefined} />
      ) }}
    >{text}</ReactMarkdown>
  );
}

test('the real Markdown pipeline renders an absolute local screenshot inline through the authorized route', () => {
  const markup = renderMarkdownImage('![צילום מסך](/root/projects/business/projects/05/design-lab/dab-crm/screenshots/crm-exact-rtl.png)');
  assert.match(markup, /<img[^>]+src="\/api\/codex\/files\/content\?path=%2Froot%2Fprojects%2Fbusiness%2Fprojects%2F05%2Fdesign-lab%2Fdab-crm%2Fscreenshots%2Fcrm-exact-rtl.png&amp;server=beam"/);
  assert.match(markup, /alt="צילום מסך"/);
  assert.match(markup, /loading="lazy"/);
  assert.match(markup, /decoding="async"/);
  assert.match(markup, /dir="auto"/);
  assert.match(markup, /aria-label="פתח תצוגה מקדימה: צילום מסך"/);
});

test('file URIs, Windows drives and relative images survive ReactMarkdown transform safely', () => {
  assert.match(renderMarkdownImage('![URI](file:///root/design/crm.png)'), /path=%2Froot%2Fdesign%2Fcrm.png/);
  assert.match(renderMarkdownImage('![Windows](C:/Users/Dev/crm.png)'), /path=C%3A%2FUsers%2FDev%2Fcrm.png/);
  assert.match(renderMarkdownImage('![יחסי](screenshots/crm.png)'), /path=%2Froot%2Fdesign%2Fscreenshots%2Fcrm.png/);
});

test('identical Markdown on another server never reuses the original server content URL', () => {
  const local = renderMarkdownImage('![תמונה](/root/design/crm.png)', 'local');
  const remote = renderMarkdownImage('![תמונה](/root/design/crm.png)', 'beam');
  assert.match(local, /server=local/);
  assert.match(remote, /server=beam/);
  assert.notEqual(local, remote);
});

test('external images stay external and unsafe destinations produce an error placeholder, not a browser request', () => {
  const external = renderMarkdownImage('![חיצוני](https://example.com/crm.png)');
  assert.match(external, /src="https:\/\/example.com\/crm.png"/);
  assert.doesNotMatch(external, /server=beam/);
  assert.doesNotMatch(external, /<button/);
  for (const text of ['![bad](javascript:alert%281%29)', '![bad](data:image/png;base64,AAAA)']) {
    const unsafe = renderMarkdownImage(text);
    assert.doesNotMatch(unsafe, /<img/);
    assert.match(unsafe, /לא ניתן לטעון את התמונה/);
    assert.doesNotMatch(unsafe, /נסה שוב/);
  }
});

test('already-authorized Markdown media URLs are also scoped to the message source server', () => {
  const markup = renderMarkdownImage('![image](/api/codex/files/content?path=%2Froot%2Fcrm.png)');
  assert.match(markup, /path=%2Froot%2Fcrm.png&amp;server=beam/);
});

test('linked images do not create nested interactive buttons', () => {
  const markup = renderToStaticMarkup(
    <MarkdownImageLinkContext.Provider value={true}>
      <button type="button"><MarkdownFileImage src="/root/crm.png" alt="תמונה" serverId="beam" onOpenFilePreview={() => undefined} /></button>
    </MarkdownImageLinkContext.Provider>
  );
  assert.equal((markup.match(/<button/g) || []).length, 1);
  assert.match(markup, /<img/);
});

test('HTML waits for authenticated parent preparation and never navigates an opaque frame to protected assets', () => {
  const markup = renderToStaticMarkup(
    <HtmlFilePreview contentUrl="/api/codex/files/content?path=%2Froot%2Fdesign%2Fdemo.html" content="<button onclick='alert(1)'>Demo</button>" name="demo.html" serverId="beam" fetchFile={async () => new Response('')} />
  );
  assert.doesNotMatch(markup, /<iframe|allow-same-origin|onclick=/);
  assert.match(markup, /טוען קבצים ומכין תצוגה מבודדת/);
  assert.match(markup, /קוד מקור/);
  assert.match(markup, /טען מחדש/);
});

test('invalid HTML file content locations do not create arbitrary embedded web pages', () => {
  const markup = renderToStaticMarkup(
    <HtmlFilePreview contentUrl="https://example.com/demo.html" content="demo" name="demo.html" serverId="beam" fetchFile={async () => new Response('')} />
  );
  assert.doesNotMatch(markup, /<iframe/);
  assert.match(markup, /לא ניתן לפתוח תצוגה אינטראקטיבית/);
});
