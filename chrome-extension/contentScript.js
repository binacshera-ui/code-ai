(() => {
  if (globalThis.__codeAiPickerInstalled) return;
  globalThis.__codeAiPickerInstalled = true;
  let cleanupCurrent = null;

  function selectorFor(element) {
    if (!(element instanceof Element)) return '';
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 7) {
      let part = current.localName;
      const stableClasses = [...current.classList].filter((name) => !/[0-9]{4,}|^(active|hover|focus|selected)$/i.test(name)).slice(0, 2);
      if (stableClasses.length) part += stableClasses.map((name) => `.${CSS.escape(name)}`).join('');
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((entry) => entry.localName === current.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(' > ');
  }

  function elementDetails(element, point) {
    const rect = element.getBoundingClientRect();
    const text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    return {
      kind: 'element', selector: selectorFor(element),
      role: element.getAttribute('role') || element.localName,
      name: element.getAttribute('aria-label') || element.getAttribute('title') || text.slice(0, 160),
      text, tagName: element.tagName.toLowerCase(),
      attributes: Object.fromEntries([...element.attributes].slice(0, 30).map((attribute) => [attribute.name, /value|token|secret|password/i.test(attribute.name) ? '[REDACTED]' : attribute.value.slice(0, 500)])),
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      point, outerHTML: element.outerHTML.slice(0, 3000),
      url: location.href, title: document.title,
    };
  }

  function startElementPicker(requestId, prompt) {
    cleanupCurrent?.();
    const outline = document.createElement('div');
    const label = document.createElement('div');
    Object.assign(outline.style, { position: 'fixed', zIndex: '2147483646', pointerEvents: 'none', border: '2px solid #6366f1', background: 'rgba(99,102,241,.12)', borderRadius: '4px', display: 'none' });
    Object.assign(label.style, { position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', insetInlineStart: '12px', top: '12px', maxWidth: 'calc(100vw - 24px)', padding: '8px 12px', borderRadius: '10px', background: '#111827', color: '#fff', font: '13px/1.4 system-ui', boxShadow: '0 10px 30px rgba(15,23,42,.3)' });
    label.textContent = prompt || 'לחץ על הרכיב הרצוי · Esc לביטול';
    document.documentElement.append(outline, label);
    const move = (event) => {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (!element || element === outline || element === label) return;
      const rect = element.getBoundingClientRect();
      Object.assign(outline.style, { display: 'block', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    };
    const finish = (payload, error) => {
      cleanup();
      chrome.runtime.sendMessage({ type: 'CODE_AI_PICKER_RESULT', requestId, payload, error });
    };
    const click = (event) => {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      const element = document.elementFromPoint(event.clientX, event.clientY);
      if (!element || element === outline || element === label) return;
      finish(elementDetails(element, { x: event.clientX, y: event.clientY }));
    };
    const key = (event) => { if (event.key === 'Escape') finish(null, 'Selection cancelled'); };
    const cleanup = () => {
      document.removeEventListener('mousemove', move, true); document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true);
      outline.remove(); label.remove(); cleanupCurrent = null;
    };
    cleanupCurrent = cleanup;
    document.addEventListener('mousemove', move, true); document.addEventListener('click', click, true); document.addEventListener('keydown', key, true);
  }

  function startRegionPicker(requestId, prompt) {
    cleanupCurrent?.();
    const shield = document.createElement('div');
    const box = document.createElement('div');
    const label = document.createElement('div');
    Object.assign(shield.style, { position: 'fixed', inset: '0', zIndex: '2147483645', cursor: 'crosshair', background: 'rgba(15,23,42,.08)' });
    Object.assign(box.style, { position: 'fixed', zIndex: '2147483646', pointerEvents: 'none', border: '2px solid #0ea5e9', background: 'rgba(14,165,233,.12)', display: 'none' });
    Object.assign(label.style, { position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', insetInlineStart: '12px', top: '12px', padding: '8px 12px', borderRadius: '10px', background: '#111827', color: '#fff', font: '13px/1.4 system-ui' });
    label.textContent = prompt || 'גרור מלבן סביב האזור הרצוי · Esc לביטול';
    document.documentElement.append(shield, box, label);
    let start = null;
    const render = (x, y) => {
      const left = Math.min(start.x, x); const top = Math.min(start.y, y);
      Object.assign(box.style, { display: 'block', left: `${left}px`, top: `${top}px`, width: `${Math.abs(x - start.x)}px`, height: `${Math.abs(y - start.y)}px` });
    };
    const down = (event) => { start = { x: event.clientX, y: event.clientY }; render(event.clientX, event.clientY); };
    const move = (event) => { if (start) render(event.clientX, event.clientY); };
    const finish = (payload, error) => {
      cleanup(); chrome.runtime.sendMessage({ type: 'CODE_AI_PICKER_RESULT', requestId, payload, error });
    };
    const up = (event) => {
      if (!start) return;
      const bounds = { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) };
      if (bounds.width < 5 || bounds.height < 5) { start = null; box.style.display = 'none'; return; }
      finish({ kind: 'region', bounds, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, url: location.href, title: document.title });
    };
    const key = (event) => { if (event.key === 'Escape') finish(null, 'Selection cancelled'); };
    const cleanup = () => {
      shield.removeEventListener('mousedown', down, true); shield.removeEventListener('mousemove', move, true); shield.removeEventListener('mouseup', up, true); document.removeEventListener('keydown', key, true);
      shield.remove(); box.remove(); label.remove(); cleanupCurrent = null;
    };
    cleanupCurrent = cleanup;
    shield.addEventListener('mousedown', down, true); shield.addEventListener('mousemove', move, true); shield.addEventListener('mouseup', up, true); document.addEventListener('keydown', key, true);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'CODE_AI_PICKER_START') return;
    if (message.mode === 'region_picker') startRegionPicker(message.requestId, message.prompt);
    else startElementPicker(message.requestId, message.prompt);
    sendResponse({ ok: true });
  });
})();
