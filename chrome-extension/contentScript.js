(() => {
  if (globalThis.__codeAiPickerInstalled) return;
  globalThis.__codeAiPickerInstalled = true;

  const MAX_TEXT = 4_000;
  const MAX_HTML = 8_000;
  const SENSITIVE_PATTERN = /password|passwd|secret|token|authorization|cookie|api[-_]?key|credit|card|cvv|cvc|ssn|otp|one.?time/i;
  const VOLATILE_CLASS_PATTERN = /(?:^|[-_])(?:active|checked|disabled|focus|hover|open|selected)(?:$|[-_])|^[a-f0-9]{8,}$|\d{5,}/i;
  const STYLE_PROPERTIES = [
    'display', 'position', 'z-index', 'overflow', 'overflow-x', 'overflow-y',
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'margin', 'padding', 'gap', 'grid-template-columns', 'flex-direction',
    'align-items', 'justify-content', 'font-family', 'font-size', 'font-weight',
    'line-height', 'text-align', 'color', 'background-color', 'border',
    'border-radius', 'box-shadow', 'opacity', 'visibility', 'cursor', 'transform',
  ];
  const SOURCE_ATTRIBUTES = [
    'data-source-file', 'data-file', 'data-component', 'data-component-name',
    'data-react-component', 'data-vue-component', 'data-svelte-h',
  ];

  let cleanupCurrent = null;

  function reportPickerResult(message) {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  }

  function cleanText(value, maximum = MAX_TEXT) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maximum);
  }

  function viewport() {
    return {
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio: devicePixelRatio || 1,
      scrollX,
      scrollY,
    };
  }

  function rectDetails(rect) {
    return {
      x: rect.x,
      y: rect.y,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
  }

  function safeUrlValue(rawValue) {
    const raw = String(rawValue || '').slice(0, 2_000);
    if (!raw) return '';
    try {
      const parsed = new URL(raw, location.href);
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.href.slice(0, 2_000);
    } catch {
      return raw.replace(/[?#].*$/, '');
    }
  }

  function isSensitiveElement(element) {
    if (!(element instanceof Element)) return false;
    const names = [
      element.getAttribute('type'), element.getAttribute('name'), element.getAttribute('id'),
      element.getAttribute('autocomplete'), element.getAttribute('aria-label'),
      element.getAttribute('placeholder'), element.getAttribute('data-testid'),
    ].filter(Boolean).join(' ');
    return element instanceof HTMLInputElement && element.type === 'password'
      || SENSITIVE_PATTERN.test(names)
      || Boolean(element.closest('[data-private], [data-sensitive], [autocomplete="current-password"], [autocomplete="new-password"]'));
  }

  function quotedAttribute(value) {
    return `"${CSS.escape(String(value))}"`;
  }

  function uniqueSelector(selector) {
    if (!selector) return false;
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  }

  function selectorCandidates(element) {
    if (!(element instanceof Element)) return [];
    const candidates = [];
    const add = (kind, value, score) => {
      if (!value || candidates.some((candidate) => candidate.value === value)) return;
      try {
        document.querySelector(value);
        candidates.push({ kind, value, score: uniqueSelector(value) ? Math.min(100, score + 8) : score });
      } catch {
        // Ignore invalid selectors produced by unusual page markup.
      }
    };

    if (element.id) add('id', `#${CSS.escape(element.id)}`, 96);
    for (const attribute of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy']) {
      const value = element.getAttribute(attribute);
      if (value) add(attribute, `[${attribute}=${quotedAttribute(value)}]`, 92);
    }
    const role = element.getAttribute('role');
    const ariaLabel = element.getAttribute('aria-label');
    if (role && ariaLabel) add('role-and-name', `[role=${quotedAttribute(role)}][aria-label=${quotedAttribute(ariaLabel)}]`, 88);
    if (ariaLabel) add('aria-label', `${element.localName}[aria-label=${quotedAttribute(ariaLabel)}]`, 84);
    const name = element.getAttribute('name');
    if (name) add('name', `${element.localName}[name=${quotedAttribute(name)}]`, 78);

    const path = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && path.length < 8) {
      let part = current.localName;
      const stableClasses = [...current.classList]
        .filter((className) => className.length <= 80 && !VOLATILE_CLASS_PATTERN.test(className))
        .slice(0, 3);
      if (stableClasses.length) part += stableClasses.map((className) => `.${CSS.escape(className)}`).join('');
      const parent = current.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((sibling) => sibling.localName === current.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
      path.unshift(part);
      const pathSelector = path.join(' > ');
      add('css-path', pathSelector, Math.max(35, 74 - path.length * 4));
      if (uniqueSelector(pathSelector)) break;
      current = parent;
    }

    return candidates.sort((left, right) => right.score - left.score).slice(0, 12);
  }

  function implicitRole(element) {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.localName;
    if (tag === 'button') return 'button';
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'img') return 'img';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    if (element instanceof HTMLInputElement) {
      if (element.type === 'checkbox') return 'checkbox';
      if (element.type === 'radio') return 'radio';
      if (['button', 'submit', 'reset'].includes(element.type)) return 'button';
      return 'textbox';
    }
    return null;
  }

  function accessibleName(element, sensitive) {
    if (sensitive) return '[REDACTED SENSITIVE ELEMENT]';
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelledText = labelledBy.split(/\s+/).map((id) => cleanText(document.getElementById(id)?.textContent, 200)).filter(Boolean).join(' ');
      if (labelledText) return labelledText.slice(0, 500);
    }
    const explicit = element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('alt');
    if (explicit) return cleanText(explicit, 500);
    if (element instanceof HTMLInputElement && element.labels?.length) {
      const label = cleanText([...element.labels].map((entry) => entry.textContent).join(' '), 500);
      if (label) return label;
    }
    return cleanText(element.innerText || element.textContent, 500) || null;
  }

  function safeAttributes(element, sensitive) {
    const result = {};
    for (const attribute of [...element.attributes].slice(0, 40)) {
      const name = attribute.name.toLowerCase();
      if (name === 'style') continue;
      if (sensitive || SENSITIVE_PATTERN.test(name)) result[name] = '[REDACTED]';
      else if (name === 'href' || name === 'src' || name === 'action') result[name] = safeUrlValue(attribute.value);
      else if (name === 'value') result[name] = '[REDACTED]';
      else result[name] = String(attribute.value).slice(0, 800);
    }
    return result;
  }

  function safeHtmlSnippet(element, sensitive) {
    if (sensitive) return '<!-- sensitive element redacted -->';
    const clone = element.cloneNode(true);
    const nodes = [clone, ...clone.querySelectorAll('*')].slice(0, 500);
    for (const node of nodes) {
      const nodeSensitive = isSensitiveElement(node);
      for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase();
        if (nodeSensitive || name === 'value' || SENSITIVE_PATTERN.test(name)) node.setAttribute(attribute.name, '[REDACTED]');
        else if (name === 'href' || name === 'src' || name === 'action') node.setAttribute(attribute.name, safeUrlValue(attribute.value));
      }
      if (nodeSensitive) node.textContent = '[REDACTED SENSITIVE CONTENT]';
    }
    return String(clone.outerHTML || '').slice(0, MAX_HTML);
  }

  function computedStyleSubset(element) {
    const style = getComputedStyle(element);
    return Object.fromEntries(STYLE_PROPERTIES.map((property) => [property, style.getPropertyValue(property).slice(0, 500)]));
  }

  function matchedCssRules(element) {
    const matches = [];
    const visitRules = (rules, sourceUrl, media = null) => {
      for (const rule of [...rules]) {
        if (matches.length >= 20) return;
        if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
          visitRules(rule.cssRules, sourceUrl, rule instanceof CSSMediaRule ? rule.conditionText : media);
          continue;
        }
        if (!(rule instanceof CSSStyleRule)) continue;
        let matched = false;
        try { matched = element.matches(rule.selectorText); } catch { matched = false; }
        if (!matched) continue;
        const declarations = {};
        for (const property of [...rule.style].slice(0, 40)) declarations[property] = rule.style.getPropertyValue(property).slice(0, 500);
        matches.push({ selector: rule.selectorText.slice(0, 1_200), sourceUrl, media, declarations });
      }
    };
    for (const sheet of [...document.styleSheets]) {
      if (matches.length >= 20) break;
      try { visitRules(sheet.cssRules, sheet.href ? safeUrlValue(sheet.href) : null); } catch {
        // Cross-origin stylesheets cannot be inspected and are intentionally skipped.
      }
    }
    return matches;
  }

  function sourceHints(element) {
    const componentHints = [];
    let sourceHint = null;
    let current = element;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      for (const attribute of SOURCE_ATTRIBUTES) {
        const value = current.getAttribute(attribute);
        if (!value) continue;
        if (attribute.includes('file') || attribute === 'data-source-file') {
          if (!sourceHint) sourceHint = { file: value.slice(0, 2_000), line: null, column: null, component: null, confidence: 0.9, method: attribute };
        } else componentHints.push(value.slice(0, 500));
      }
      for (const key of Object.keys(current)) {
        if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactInternalInstance$')) continue;
        let fiber = current[key];
        let steps = 0;
        while (fiber && steps < 12) {
          const candidate = typeof fiber.type === 'function'
            ? fiber.type.displayName || fiber.type.name
            : typeof fiber.elementType === 'function'
              ? fiber.elementType.displayName || fiber.elementType.name
              : null;
          if (candidate && !componentHints.includes(candidate)) componentHints.push(candidate.slice(0, 500));
          fiber = fiber.return;
          steps += 1;
        }
        break;
      }
    }
    if (sourceHint && componentHints[0]) sourceHint.component = componentHints[0];
    if (!sourceHint && componentHints[0]) sourceHint = { file: '', line: null, column: null, component: componentHints[0], confidence: 0.55, method: 'framework-runtime' };
    return { sourceHint, componentHints: [...new Set(componentHints)].slice(0, 12) };
  }

  function ancestorDetails(element) {
    const ancestors = [];
    let current = element.parentElement;
    while (current && ancestors.length < 8) {
      const candidate = selectorCandidates(current)[0];
      ancestors.push({
        tag: current.localName,
        role: implicitRole(current) || '',
        selector: candidate?.value || current.localName,
        label: cleanText(current.getAttribute('aria-label') || current.getAttribute('title') || current.innerText, 300),
      });
      current = current.parentElement;
    }
    return ancestors;
  }

  function semanticPath(element) {
    const path = [];
    let current = element;
    while (current && path.length < 12) {
      const role = implicitRole(current);
      const name = accessibleName(current, isSensitiveElement(current));
      path.unshift(`${current.localName}${role ? `[role=${role}]` : ''}${name ? ` “${name.slice(0, 80)}”` : ''}`);
      current = current.parentElement;
    }
    return path;
  }

  function shadowPath(element) {
    const path = [];
    let current = element;
    while (current) {
      const root = current.getRootNode?.();
      if (!(root instanceof ShadowRoot)) break;
      const host = root.host;
      const candidate = selectorCandidates(host)[0];
      path.unshift(candidate?.value || host.localName);
      current = host;
    }
    return path.slice(-12);
  }

  function interactionDetails(element) {
    const role = implicitRole(element);
    const href = element instanceof HTMLAnchorElement ? safeUrlValue(element.href) : null;
    return {
      clickable: Boolean(href || element instanceof HTMLButtonElement || ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'option'].includes(role || '') || element.hasAttribute('onclick')),
      editable: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element.isContentEditable,
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
      checked: typeof element.checked === 'boolean' ? element.checked : element.getAttribute('aria-checked') === 'true' ? true : element.getAttribute('aria-checked') === 'false' ? false : null,
      expanded: element.getAttribute('aria-expanded') === 'true' ? true : element.getAttribute('aria-expanded') === 'false' ? false : null,
      selected: typeof element.selected === 'boolean' ? element.selected : element.getAttribute('aria-selected') === 'true' ? true : element.getAttribute('aria-selected') === 'false' ? false : null,
      required: Boolean(element.required || element.getAttribute('aria-required') === 'true'),
      href,
      inputType: element instanceof HTMLInputElement ? element.type : null,
    };
  }

  function fingerprint(element, primarySelector, textSnippet) {
    const source = [element.localName, implicitRole(element), primarySelector, textSnippet?.slice(0, 240), element.childElementCount].join('|');
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  }

  function elementDetails(element, point = null) {
    const sensitive = isSensitiveElement(element);
    const candidates = selectorCandidates(element);
    const primarySelector = candidates[0]?.value || element.localName;
    const textSnippet = sensitive ? '[REDACTED SENSITIVE CONTENT]' : cleanText(element.innerText || element.textContent, MAX_TEXT) || null;
    const parentContainsSensitive = Boolean(element.parentElement && [...element.parentElement.querySelectorAll('input,textarea,select,[data-private],[data-sensitive]')].some(isSensitiveElement));
    const parentText = sensitive || parentContainsSensitive ? null : cleanText(element.parentElement?.innerText || '', MAX_TEXT) || null;
    const rect = element.getBoundingClientRect();
    const { sourceHint, componentHints } = sourceHints(element);
    const htmlSnippet = safeHtmlSnippet(element, sensitive);
    return {
      tagName: element.localName,
      role: implicitRole(element),
      accessibleName: accessibleName(element, sensitive),
      textSnippet,
      attributes: safeAttributes(element, sensitive),
      rect: rectDetails(rect),
      primarySelector,
      selectorCandidates: candidates,
      framePath: [],
      shadowPath: shadowPath(element),
      ancestors: ancestorDetails(element),
      computedStyleSubset: computedStyleSubset(element),
      matchedCssRules: matchedCssRules(element),
      sourceHint,
      sensitive,
      domFingerprint: fingerprint(element, primarySelector, textSnippet),
      viewport: viewport(),
      htmlSnippet,
      nearbyText: parentText,
      semanticPath: semanticPath(element),
      componentHints,
      interaction: interactionDetails(element),
      point,
    };
  }

  function deepestElementAtPoint(x, y) {
    let element = document.elementFromPoint(x, y);
    let shadowDepth = 0;
    while (element?.shadowRoot && shadowDepth < 8) {
      const nested = element.shadowRoot.elementFromPoint(x, y);
      if (!nested || nested === element) break;
      element = nested;
      shadowDepth += 1;
    }
    return element;
  }

  function pickerPayload(kind, element, region = null) {
    return {
      kind,
      url: location.href,
      title: document.title,
      capturedAt: new Date().toISOString(),
      screenshotImageId: null,
      screenshotUrl: null,
      cropImageId: null,
      cropUrl: null,
      element: elementDetails(element),
      region,
    };
  }

  function regionDetails(bounds) {
    const intersects = (rect) => rect.width > 0 && rect.height > 0
      && rect.right >= bounds.x && rect.left <= bounds.x + bounds.width
      && rect.bottom >= bounds.y && rect.top <= bounds.y + bounds.height;
    const semanticSelector = 'a,button,input,textarea,select,label,h1,h2,h3,h4,h5,h6,img,svg,[role],[contenteditable="true"],[data-testid],[data-component]';
    const elements = [];
    for (const element of document.querySelectorAll(semanticSelector)) {
      if (elements.length >= 64) break;
      const rect = element.getBoundingClientRect();
      if (!intersects(rect) || getComputedStyle(element).visibility === 'hidden') continue;
      const sensitive = isSensitiveElement(element);
      const candidates = selectorCandidates(element);
      elements.push({
        tagName: element.localName,
        role: implicitRole(element),
        accessibleName: accessibleName(element, sensitive),
        textSnippet: sensitive ? '[REDACTED]' : cleanText(element.innerText || element.textContent, 1_000) || null,
        primarySelector: candidates[0]?.value || element.localName,
        rect: rectDetails(rect),
      });
    }
    const textSnippet = cleanText(elements.map((element) => element.textSnippet).filter(Boolean).join(' · '), 8_000) || null;
    return { bounds, viewport: viewport(), textSnippet, elementCount: elements.length, elements: elements.slice(0, 32) };
  }

  function createOverlay(color, background) {
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', zIndex: '2147483646', pointerEvents: 'none',
      border: `2px solid ${color}`, background, borderRadius: '5px', display: 'none',
      boxSizing: 'border-box', boxShadow: `0 0 0 1px rgba(255,255,255,.8), 0 8px 24px rgba(15,23,42,.2)`,
    });
    return overlay;
  }

  function createLabel(prompt) {
    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', insetInlineStart: '12px', top: '12px',
      maxWidth: 'calc(100vw - 24px)', padding: '9px 13px', borderRadius: '11px', background: '#111827',
      color: '#fff', font: '600 13px/1.5 system-ui', boxShadow: '0 10px 30px rgba(15,23,42,.3)',
      whiteSpace: 'pre-line', direction: 'rtl',
    });
    label.textContent = prompt;
    return label;
  }

  function startElementPicker(requestId, prompt) {
    cleanupCurrent?.();
    const outline = createOverlay('#6366f1', 'rgba(99,102,241,.12)');
    const label = createLabel(prompt || 'בחר רכיב · ↑ הורה · ↓ ילד · Enter לאישור · Esc לביטול');
    document.documentElement.append(outline, label);
    let hovered = null;
    let focused = null;
    let pointer = { x: innerWidth / 2, y: innerHeight / 2 };

    const render = (element) => {
      if (!(element instanceof Element) || element === outline || element === label) return;
      focused = element;
      const rect = element.getBoundingClientRect();
      Object.assign(outline.style, {
        display: 'block', left: `${rect.left}px`, top: `${rect.top}px`,
        width: `${Math.max(1, rect.width)}px`, height: `${Math.max(1, rect.height)}px`,
      });
      const details = elementDetails(element);
      const component = details.componentHints[0] ? ` · ${details.componentHints[0]}` : '';
      label.textContent = `${prompt || 'בחר רכיב'}\n${details.tagName}${details.role ? ` [${details.role}]` : ''}${component} · ${details.accessibleName || details.primarySelector}\n↑ הורה · ↓ ילד · Enter/לחיצה לאישור · Esc לביטול`;
    };
    const move = (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      hovered = deepestElementAtPoint(event.clientX, event.clientY);
      render(hovered);
    };
    const finish = (payload, error) => {
      cleanup();
      reportPickerResult({ type: 'CODE_AI_PICKER_RESULT', requestId, payload, error });
    };
    const click = (event) => {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      const element = focused || deepestElementAtPoint(event.clientX, event.clientY);
      if (!(element instanceof Element) || element === outline || element === label) return;
      finish(pickerPayload('element', element));
    };
    const key = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); finish(null, 'Selection cancelled'); return; }
      if (event.key === 'ArrowUp' && focused?.parentElement) { event.preventDefault(); render(focused.parentElement); return; }
      if (event.key === 'ArrowDown') {
        const next = hovered && focused?.contains(hovered) && hovered !== focused ? hovered : focused?.firstElementChild;
        if (next) { event.preventDefault(); render(next); }
        return;
      }
      if (event.key === 'Enter' && focused) { event.preventDefault(); finish(pickerPayload('element', focused)); }
    };
    const cleanup = () => {
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
      outline.remove(); label.remove(); cleanupCurrent = null;
    };
    cleanupCurrent = cleanup;
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
    const initial = deepestElementAtPoint(pointer.x, pointer.y) || document.body;
    render(initial);
  }

  function startRegionPicker(requestId, prompt) {
    cleanupCurrent?.();
    const shield = document.createElement('div');
    const box = createOverlay('#0ea5e9', 'rgba(14,165,233,.12)');
    const label = createLabel(prompt || 'גרור סביב האזור הרצוי · Esc לביטול');
    Object.assign(shield.style, { position: 'fixed', inset: '0', zIndex: '2147483645', cursor: 'crosshair', background: 'rgba(15,23,42,.06)' });
    document.documentElement.append(shield, box, label);
    let start = null;
    const boundsFor = (x, y) => ({ x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) });
    const render = (x, y) => {
      const bounds = boundsFor(x, y);
      Object.assign(box.style, { display: 'block', left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
      label.textContent = `${prompt || 'בחר אזור'}\n${Math.round(bounds.width)}×${Math.round(bounds.height)}px · שחרר לאישור · Esc לביטול`;
    };
    const down = (event) => { event.preventDefault(); start = { x: event.clientX, y: event.clientY }; render(event.clientX, event.clientY); };
    const move = (event) => { if (start) render(event.clientX, event.clientY); };
    const finish = (payload, error) => { cleanup(); reportPickerResult({ type: 'CODE_AI_PICKER_RESULT', requestId, payload, error }); };
    const up = (event) => {
      if (!start) return;
      const bounds = boundsFor(event.clientX, event.clientY);
      if (bounds.width < 5 || bounds.height < 5) { start = null; box.style.display = 'none'; return; }
      shield.style.pointerEvents = 'none';
      const centerX = bounds.x + bounds.width / 2;
      const centerY = bounds.y + bounds.height / 2;
      const anchor = deepestElementAtPoint(centerX, centerY)
        || deepestElementAtPoint(bounds.x + 1, bounds.y + 1)
        || document.body;
      finish(pickerPayload('region', anchor, regionDetails(bounds)));
    };
    const key = (event) => { if (event.key === 'Escape') { event.preventDefault(); finish(null, 'Selection cancelled'); } };
    const cleanup = () => {
      shield.removeEventListener('mousedown', down, true);
      shield.removeEventListener('mousemove', move, true);
      shield.removeEventListener('mouseup', up, true);
      document.removeEventListener('keydown', key, true);
      shield.remove(); box.remove(); label.remove(); cleanupCurrent = null;
    };
    cleanupCurrent = cleanup;
    shield.addEventListener('mousedown', down, true);
    shield.addEventListener('mousemove', move, true);
    shield.addEventListener('mouseup', up, true);
    document.addEventListener('keydown', key, true);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'CODE_AI_PICKER_PING') {
      sendResponse({ ready: true, version: 2 });
      return;
    }
    if (message?.type === 'CODE_AI_INSPECT_SELECTOR') {
      let element = null;
      try { element = document.querySelector(String(message.selector || '')); } catch { element = null; }
      sendResponse({ ok: Boolean(element), payload: element ? pickerPayload('element', element) : null });
      return;
    }
    if (message?.type !== 'CODE_AI_PICKER_START') return;
    if (message.mode === 'region_picker') startRegionPicker(message.requestId, message.prompt);
    else startElementPicker(message.requestId, message.prompt);
    sendResponse({ ok: true, version: 2 });
  });
})();
