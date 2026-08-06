from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import queue
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from browser_mode_extractor import extract_page_content, extract_page_text, looks_like_blocked_page

try:
    from PIL import Image
except ImportError:  # pragma: no cover - depends on runtime environment setup.
    Image = None  # type: ignore[assignment]

try:
    from playwright.sync_api import BrowserContext, Page, sync_playwright
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
except ImportError:  # pragma: no cover - exercised in runtime environments without Playwright.
    BrowserContext = None  # type: ignore[assignment]
    Page = None  # type: ignore[assignment]
    PlaywrightError = Exception  # type: ignore[assignment]
    PlaywrightTimeoutError = TimeoutError  # type: ignore[assignment]
    sync_playwright = None  # type: ignore[assignment]


COMMON_BROWSER_PATHS = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
]
DEFAULT_ACCESSIBILITY_DEPTH = 15
DEFAULT_BATCH_ACTION_LIMIT = 25
DEFAULT_ELEMENT_LIMIT = 5
DEFAULT_FIND_LIMIT = 20
DEFAULT_MAX_CAPTURED_EVENTS = 500
DEFAULT_MAX_PAGE_CHARS = 50_000
DEFAULT_BRIDGE_PORT_BASE = 39000
DEFAULT_BRIDGE_PORT_SPAN = 2000
LIVE_FRAME_MAX_HEIGHT = 2160
LIVE_FRAME_MAX_WIDTH = 2560
LIVE_FRAME_QUALITY = 85
INTERACTION_SELECTOR = ", ".join(
    [
        "a[href]",
        "button",
        "input",
        "textarea",
        "select",
        "[role='button']",
        "[role='link']",
        "[role='textbox']",
        "[contenteditable='true']",
        "[tabindex]",
    ]
)
KEY_MODIFIER_MAP = {
    "alt": "Alt",
    "cmd": "Meta",
    "command": "Meta",
    "control": "Control",
    "ctrl": "Control",
    "meta": "Meta",
    "shift": "Shift",
    "win": "Meta",
}

PAGE_HELPERS_SCRIPT = r"""
function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeDescription(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ');
}

function tokenize(value) {
  return normalizeDescription(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function extractRoleHints(value) {
  const normalized = normalizeDescription(value);
  const hints = [];
  if (/button|btn|כפתור/.test(normalized)) hints.push('button');
  if (/link|קישור/.test(normalized)) hints.push('link');
  if (/input|field|textbox|search|שדה|תיבת|חיפוש/.test(normalized)) hints.push('textbox');
  return hints;
}

function visible(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}

function inferRole(el) {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return 'textbox';
  return tag;
}

function isInteractive(el) {
  const role = inferRole(el);
  const tag = el.tagName.toLowerCase();
  return (
    ['button', 'link', 'textbox', 'checkbox', 'radio', 'switch', 'menuitem', 'option'].includes(role) ||
    ['a', 'button', 'input', 'textarea', 'select'].includes(tag) ||
    el.hasAttribute('onclick') ||
    el.getAttribute('contenteditable') === 'true' ||
    el.tabIndex >= 0
  );
}

function buildUniqueSelector(el) {
  if (el.id) {
    const idSelector = '#' + CSS.escape(el.id);
    if (document.querySelectorAll(idSelector).length === 1) return idSelector;
  }

  const tag = el.tagName.toLowerCase();
  const attrs = ['data-testid', 'data-test', 'data-cy', 'aria-label', 'name', 'placeholder', 'href', 'title', 'type'];
  for (const attr of attrs) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    const candidate = tag + '[' + attr + '=' + JSON.stringify(value) + ']';
    if (document.querySelectorAll(candidate).length === 1) return candidate;
  }

  const classList = Array.from(el.classList).filter(Boolean).slice(0, 3);
  if (classList.length > 0) {
    const classSelector = tag + '.' + classList.map((entry) => CSS.escape(entry)).join('.');
    if (document.querySelectorAll(classSelector).length === 1) return classSelector;
  }

  const path = [];
  let current = el;
  while (current && current !== document.documentElement) {
    const currentTag = current.tagName.toLowerCase();
    if (current.id) {
      path.unshift('#' + CSS.escape(current.id));
      break;
    }
    const parent = current.parentElement;
    if (!parent) {
      path.unshift(currentTag);
      break;
    }
    const siblings = Array.from(parent.children).filter((candidate) => candidate.tagName.toLowerCase() === currentTag);
    if (siblings.length > 1) {
      const index = siblings.indexOf(current) + 1;
      path.unshift(currentTag + ':nth-of-type(' + index + ')');
    } else {
      path.unshift(currentTag);
    }
    current = parent;
  }

  return path.join(' > ');
}

function buildLabel(el) {
  const htmlElement = el;
  const textParts = [
    el.getAttribute('aria-label'),
    el.getAttribute('title'),
    el.getAttribute('placeholder'),
    htmlElement.value,
    htmlElement.innerText,
    htmlElement.textContent
  ]
    .map((part) => collapseWhitespace(part))
    .filter((part) => part.length > 0);

  if (htmlElement.id) {
    const associated = document.querySelector('label[for=' + JSON.stringify(htmlElement.id) + ']');
    if (associated) {
      const associatedText = collapseWhitespace(associated.textContent);
      if (associatedText) textParts.unshift(associatedText);
    }
  }

  return textParts[0] || '';
}

function serializeRect(el) {
  const rect = el.getBoundingClientRect();
  return {
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width,
    x: rect.x,
    y: rect.y
  };
}
"""

FIND_ELEMENT_SCRIPT = PAGE_HELPERS_SCRIPT + r"""
function scoreElement(el, label, tokens, roleHints) {
  const haystacks = [
    label,
    collapseWhitespace(el.innerText || ''),
    collapseWhitespace(el.getAttribute('aria-label') || ''),
    collapseWhitespace(el.getAttribute('placeholder') || '')
  ].join(' ').toLowerCase();

  let score = 0;
  const normalizedDescription = tokens.join(' ').toLowerCase();
  const normalizedLabel = label.toLowerCase();

  if (normalizedLabel === normalizedDescription) score += 120;
  else if (normalizedDescription.length > 0 && normalizedLabel.includes(normalizedDescription)) score += 85;

  for (const token of tokens) {
    if (token.length < 2) continue;
    if (normalizedLabel === token) score += 40;
    else if (normalizedLabel.includes(token)) score += 22;
    else if (haystacks.includes(token)) score += 12;
  }

  const role = inferRole(el);
  if (role && roleHints.includes(role)) score += 35;
  if (visible(el)) score += 10;
  if (!el.disabled && el.getAttribute('aria-disabled') !== 'true') score += 5;
  if (el.tagName.toLowerCase() === 'button') score += 4;

  return score;
}

return (() => {
  const tokens = tokenize(description);
  const roleHints = extractRoleHints(description);
  const pool = Array.from(document.querySelectorAll(selector));
  const scored = [];

  for (const el of pool) {
    const label = buildLabel(el);
    const score = scoreElement(el, label, tokens, roleHints);
    if (score <= 0) continue;
    scored.push({
      ariaLabel: el.getAttribute('aria-label'),
      enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
      label,
      rect: serializeRect(el),
      ref: buildUniqueSelector(el),
      role: inferRole(el),
      score,
      selector: buildUniqueSelector(el),
      tag: el.tagName.toLowerCase(),
      text: collapseWhitespace(el.innerText || el.textContent || ''),
      visible: visible(el)
    });
  }

  return scored.sort((left, right) => right.score - left.score).slice(0, limit);
})();
"""

ACCESSIBILITY_TREE_SCRIPT = PAGE_HELPERS_SCRIPT + r"""
return (() => {
  const root = refId ? document.querySelector(refId) : document.body;
  if (!root) return null;

  function buildNode(el, depth, path) {
    if (!el || depth > maxDepth) return null;
    const selector = buildUniqueSelector(el);
    const node = {
      ref_id: selector,
      role: inferRole(el),
      label: buildLabel(el),
      text: collapseWhitespace(el.innerText || el.textContent || ''),
      tag: el.tagName.toLowerCase(),
      visible: visible(el),
      interactive: isInteractive(el),
      rect: serializeRect(el),
      depth,
      child_count: el.children.length
    };

    if (filterMode === 'interactive' && !node.interactive) {
      const childNodes = [];
      for (const child of Array.from(el.children)) {
        const built = buildNode(child, depth + 1, path + 1);
        if (built) childNodes.push(built);
      }
      if (childNodes.length === 0) return null;
      return {
        ref_id: selector,
        role: node.role,
        label: node.label,
        text: node.text,
        tag: node.tag,
        visible: node.visible,
        interactive: node.interactive,
        rect: node.rect,
        depth,
        child_count: node.child_count,
        children: childNodes
      };
    }

    const children = [];
    for (const child of Array.from(el.children)) {
      const built = buildNode(child, depth + 1, path + 1);
      if (built) children.push(built);
    }
    if (children.length > 0) node.children = children;
    return node;
  }

  return buildNode(root, 0, 0);
})();
"""

INSPECT_AT_POINT_SCRIPT = PAGE_HELPERS_SCRIPT + r"""
return (() => {
  const pointX = Number(params.x);
  const pointY = Number(params.y);
  if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) {
    throw new Error('inspect_at_point requires numeric x and y coordinates');
  }

  const framePath = [];
  const shadowPath = [];
  let targetDocument = document;
  let localX = pointX;
  let localY = pointY;
  let element = targetDocument.elementFromPoint(localX, localY);

  for (let depth = 0; depth < 12 && element; depth += 1) {
    let advanced = false;

    if (element.shadowRoot && typeof element.shadowRoot.elementFromPoint === 'function') {
      const shadowElement = element.shadowRoot.elementFromPoint(localX, localY);
      if (shadowElement && shadowElement !== element) {
        shadowPath.push(buildUniqueSelector(element));
        element = shadowElement;
        advanced = true;
      }
    }

    if (advanced) continue;

    if (element.tagName && element.tagName.toLowerCase() === 'iframe') {
      try {
        const frameRect = element.getBoundingClientRect();
        const childDocument = element.contentDocument;
        if (childDocument) {
          const childX = localX - frameRect.left;
          const childY = localY - frameRect.top;
          const childElement = childDocument.elementFromPoint(childX, childY);
          if (childElement) {
            framePath.push({
              selector: buildUniqueSelector(element),
              src: element.getAttribute('src') || null,
              title: element.getAttribute('title') || null
            });
            targetDocument = childDocument;
            localX = childX;
            localY = childY;
            element = childElement;
            advanced = true;
          }
        }
      } catch (_error) {
        // Cross-origin frames remain selectable as the iframe element itself.
      }
    }

    if (!advanced) break;
  }

  if (!element) return null;

  const tagName = element.tagName.toLowerCase();
  const inputType = collapseWhitespace(element.getAttribute('type')).toLowerCase();
  const fieldName = collapseWhitespace(element.getAttribute('name')).toLowerCase();
  const autocomplete = collapseWhitespace(element.getAttribute('autocomplete')).toLowerCase();
  const isSensitive = inputType === 'password'
    || autocomplete.includes('password')
    || autocomplete.includes('cc-')
    || /password|passwd|token|secret|authorization|credit|card|cvv|cvc/.test(fieldName);

  const textValue = isSensitive
    ? '[redacted]'
    : collapseWhitespace(element.innerText || element.textContent || '').slice(0, 500);
  const accessibleName = isSensitive
    ? collapseWhitespace(element.getAttribute('aria-label') || element.getAttribute('title') || '')
    : collapseWhitespace(
      element.getAttribute('aria-label')
      || element.getAttribute('title')
      || element.getAttribute('placeholder')
      || textValue
    ).slice(0, 300);

  const allowedAttributes = [
    'id', 'class', 'role', 'name', 'type', 'href', 'src', 'alt', 'title',
    'placeholder', 'aria-label', 'aria-labelledby', 'aria-describedby',
    'data-testid', 'data-test', 'data-cy', 'data-component',
    'data-code-ai-source', 'data-source'
  ];
  const attributes = {};
  for (const attributeName of allowedAttributes) {
    const value = element.getAttribute(attributeName);
    if (value === null) continue;
    attributes[attributeName] = isSensitive && ['placeholder', 'title'].includes(attributeName)
      ? '[redacted]'
      : collapseWhitespace(value).slice(0, 500);
  }

  const selectorCandidates = [];
  const primarySelector = buildUniqueSelector(element);
  if (element.id) selectorCandidates.push({ kind: 'id', value: '#' + CSS.escape(element.id), score: 100 });
  for (const attributeName of ['data-testid', 'data-test', 'data-cy']) {
    const value = element.getAttribute(attributeName);
    if (value) {
      selectorCandidates.push({
        kind: 'test-id',
        value: tagName + '[' + attributeName + '=' + JSON.stringify(value) + ']',
        score: 96
      });
    }
  }
  if (accessibleName) {
    selectorCandidates.push({
      kind: 'role',
      value: inferRole(element) + ':' + accessibleName,
      score: 88
    });
  }
  selectorCandidates.push({ kind: 'css', value: primarySelector, score: 80 });

  const computedStyle = window.getComputedStyle(element);
  const styleKeys = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index',
    'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
    'margin', 'padding', 'gap', 'align-items', 'justify-content',
    'grid-template-columns', 'flex-direction', 'flex-wrap',
    'font-family', 'font-size', 'font-weight', 'line-height', 'text-align',
    'color', 'background-color', 'border', 'border-radius', 'box-shadow',
    'opacity', 'overflow', 'transform', 'visibility', 'cursor'
  ];
  const computedStyleSubset = {};
  for (const key of styleKeys) {
    computedStyleSubset[key] = computedStyle.getPropertyValue(key);
  }

  const matchedCssRules = [];
  function collectRules(ruleList, sourceUrl, mediaText) {
    for (const rule of Array.from(ruleList || [])) {
      if (matchedCssRules.length >= 60) return;
      if (rule.cssRules) {
        collectRules(rule.cssRules, sourceUrl, rule.conditionText || mediaText || null);
        continue;
      }
      if (!rule.selectorText) continue;
      let matches = false;
      try { matches = element.matches(rule.selectorText); } catch (_error) { matches = false; }
      if (!matches) continue;
      const declarations = {};
      for (const propertyName of Array.from(rule.style || [])) {
        declarations[propertyName] = rule.style.getPropertyValue(propertyName);
      }
      matchedCssRules.push({
        selector: rule.selectorText,
        sourceUrl: sourceUrl || null,
        media: mediaText || null,
        declarations
      });
    }
  }
  for (const sheet of Array.from(targetDocument.styleSheets || [])) {
    try { collectRules(sheet.cssRules, sheet.href, null); } catch (_error) { /* cross-origin stylesheet */ }
  }

  const ancestors = [];
  let ancestor = element.parentElement;
  while (ancestor && ancestors.length < 6) {
    ancestors.push({
      tag: ancestor.tagName.toLowerCase(),
      role: inferRole(ancestor),
      selector: buildUniqueSelector(ancestor),
      label: collapseWhitespace(ancestor.getAttribute('aria-label') || ancestor.getAttribute('title') || '').slice(0, 160)
    });
    ancestor = ancestor.parentElement;
  }

  const sourceToken = element.getAttribute('data-code-ai-source')
    || element.getAttribute('data-source')
    || null;
  let sourceHint = null;
  if (sourceToken) {
    const sourceMatch = sourceToken.match(/^(.*?):(\d+)(?::(\d+))?$/);
    sourceHint = sourceMatch
      ? {
          file: sourceMatch[1],
          line: Number(sourceMatch[2]),
          column: sourceMatch[3] ? Number(sourceMatch[3]) : null,
          component: element.getAttribute('data-component') || null,
          confidence: 1,
          method: 'bridge'
        }
      : {
          file: sourceToken,
          line: null,
          column: null,
          component: element.getAttribute('data-component') || null,
          confidence: 0.9,
          method: 'bridge'
        };
  }

  const rect = serializeRect(element);
  const fingerprintSource = [
    location.href,
    primarySelector,
    tagName,
    inferRole(element),
    accessibleName,
    Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)
  ].join('|');
  let fingerprintHash = 2166136261;
  for (let index = 0; index < fingerprintSource.length; index += 1) {
    fingerprintHash ^= fingerprintSource.charCodeAt(index);
    fingerprintHash = Math.imul(fingerprintHash, 16777619);
  }

  return {
    tagName,
    role: inferRole(element),
    accessibleName: accessibleName || null,
    textSnippet: textValue || null,
    attributes,
    rect,
    primarySelector,
    selectorCandidates,
    framePath,
    shadowPath,
    ancestors,
    computedStyleSubset,
    matchedCssRules,
    sourceHint,
    sensitive: isSensitive,
    domFingerprint: 'fnv1a-' + (fingerprintHash >>> 0).toString(16),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      scrollX: window.scrollX,
      scrollY: window.scrollY
    }
  };
})();
"""


class BrowserRuntimeError(Exception):
    def __init__(self, error_code: str, is_retryable: bool, status_code: int, message: str, suggested_remediation: str) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.is_retryable = is_retryable
        self.status_code = status_code
        self.suggested_remediation = suggested_remediation


@dataclass(slots=True)
class BrowserTab:
    tab_id: int
    page: Page
    console_messages: list[dict[str, Any]] = field(default_factory=list)
    gif_frames: list[str] = field(default_factory=list)
    gif_options: dict[str, Any] = field(default_factory=dict)
    gif_recording: bool = False
    network_requests: list[dict[str, Any]] = field(default_factory=list)
    pending_request_indexes: dict[int, int] = field(default_factory=dict)
    created_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    live_cdp_session: Any | None = None
    live_stream_started: bool = False


@dataclass(frozen=True, slots=True)
class BrowserLiveFrame:
    captured_at: str
    data: bytes
    height: int
    sequence: int
    tab_id: int
    width: int


@dataclass(slots=True)
class BrowserSession:
    context: BrowserContext
    playwright: object
    tabs: dict[int, BrowserTab] = field(default_factory=dict)
    page_ids: dict[int, int] = field(default_factory=dict)
    current_tab_id: int | None = None
    next_tab_id: int = 1
    artifacts: dict[str, str] = field(default_factory=dict)


@dataclass(slots=True)
class BridgeDispatchRequest:
    name: str
    payload: dict[str, Any]
    is_control: bool = False
    done: threading.Event = field(default_factory=threading.Event)
    error: Exception | None = None
    result: dict[str, Any] | None = None


def maybe_truncate_value(value: object, max_chars: int) -> tuple[object, int, bool]:
    serialized = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2, default=str)
    if len(serialized) <= max_chars:
        return value, len(serialized), False
    return {
        "preview": f"{serialized[:max_chars].rstrip()}\n...[truncated]",
        "truncated": True,
    }, len(serialized), True


def to_title_or_none(value: str) -> str | None:
    normalized = value.strip()
    return normalized if normalized else None


def normalize_runtime_url(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if re.match(r"^[a-zA-Z][a-zA-Z\d+\-.]*:", normalized):
        return normalized
    if normalized.startswith("//"):
        return f"https:{normalized}"
    if re.match(r"^(localhost|127\.0\.0\.1|0\.0\.0\.0)([:/]|$)", normalized):
        return f"http://{normalized}"
    return f"https://{normalized}"


def _mime_type_for_path(path: Path) -> str:
    extension = path.suffix.lower()
    if extension in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if extension == ".gif":
        return "image/gif"
    if extension == ".webp":
        return "image/webp"
    return "image/png"


class BrowserRuntime:
    def __init__(self, settings) -> None:
        self._settings = settings
        self._session: BrowserSession | None = None
        self._owner_thread_id = threading.get_ident()
        self._profile_dir = Path(settings.web_browser_profile_dir)
        self._screenshot_dir = Path(settings.web_browser_screenshot_dir)
        self._bridge_file = self._profile_dir.parent / "browser-http-bridge.json"
        self._tab_state_file = self._profile_dir.parent / "browser-tab-state.json"
        self._bridge_token = secrets.token_urlsafe(32)
        self._bridge_port: int | None = None
        self._bridge_requests: queue.Queue[BridgeDispatchRequest] = queue.Queue()
        self._bridge_server: ThreadingHTTPServer | None = None
        self._bridge_thread: threading.Thread | None = None
        self._dispatch_lock = threading.RLock()
        self._live_frame_condition = threading.Condition()
        self._live_frame_sequence = 0
        self._live_frames: dict[int, BrowserLiveFrame] = {}
        self._profile_dir.mkdir(parents=True, exist_ok=True)
        self._screenshot_dir.mkdir(parents=True, exist_ok=True)
        self._start_bridge_server()

    def close(self) -> None:
        try:
            self._persist_tab_state()
        except Exception:
            pass
        self._stop_bridge_server()
        if self._session is None:
            return
        try:
            self._session.context.close()
        finally:
            try:
                self._session.playwright.stop()  # type: ignore[call-arg]
            finally:
                self._session = None

    def health_check(self) -> dict:
        return {
            "dependency_installed": sync_playwright is not None,
            "executable_path": self._resolve_executable_path(),
            "headless": self._settings.web_browser_headless,
            "profile_dir": str(self._profile_dir),
            "screenshot_dir": str(self._screenshot_dir),
            "bridge_url": self._bridge_url(),
            "live_stream_tabs": len(self._live_frames),
        }

    def dispatch_action(self, name: str, arguments: dict | None = None) -> dict:
        payload = dict(arguments or {})
        if threading.get_ident() != self._owner_thread_id:
            request = BridgeDispatchRequest(name=name, payload=payload)
            self._bridge_requests.put(request)
            if not request.done.wait(timeout=120):
                raise BrowserRuntimeError(
                    "BROWSER_MODE_RUNTIME_TIMEOUT",
                    False,
                    504,
                    f"Timed out waiting for browser action: {name}",
                    "Retry the browser action. If the runtime is hung, restart the browser-mode session.",
                )
            if request.error is not None:
                raise request.error
            return request.result or {}

        return self._dispatch_action_internal(name, payload)


    def _dispatch_action_internal(self, name: str, payload: dict[str, Any]) -> dict:
        with self._dispatch_lock:
            if name.startswith("_"):
                raise BrowserRuntimeError(
                    "WEB_TOOL_VALIDATION_FAILED",
                    False,
                    400,
                    f"Unsupported browser tool: {name}",
                    "Use a registered browser tool name.",
                )
            if name == "browser_health":
                return self.health_check()
            if name == "screenshot":
                return self.save_screenshot(payload)
            handler = getattr(self, name, None)
            if handler is None:
                raise BrowserRuntimeError(
                    "WEB_TOOL_VALIDATION_FAILED",
                    False,
                    400,
                    f"Unsupported browser tool: {name}",
                    "Use a registered browser tool name.",
                )
            result = handler(payload)
            computer_action = str(payload.get("action") or "").strip().lower() if name == "computer" else ""
            if (
                name in {"tabs_create", "navigate", "click", "type", "form_input", "press_key"}
                or (name == "computer" and computer_action not in {"hover", "wheel", "wait", "screenshot"})
            ):
                try:
                    self._persist_tab_state()
                except Exception:
                    pass
            return result


    def process_bridge_requests(self, max_requests: int = 8) -> int:
        processed = 0
        while processed < max_requests:
          try:
              request = self._bridge_requests.get_nowait()
          except queue.Empty:
              break

          try:
              request.result = (
                  self._dispatch_control_action_internal(request.name, request.payload)
                  if request.is_control
                  else self._dispatch_action_internal(request.name, request.payload)
              )
          except Exception as exc:
              request.error = exc
          finally:
              request.done.set()
          processed += 1
        return processed

    def pump_browser_events(self) -> None:
        """Give Playwright's sync dispatcher a short turn so CDP frames keep flowing."""
        session = self._session
        if session is None or not session.tabs:
            return
        tab = session.tabs.get(session.current_tab_id or -1) or next(iter(session.tabs.values()), None)
        if tab is None or tab.page.is_closed():
            return
        try:
            tab.page.wait_for_timeout(1)
        except Exception:
            # A navigation or tab close can invalidate the page between the checks.
            return

    def read_live_frame(self, tab_id: int, after_sequence: int = 0, wait_ms: int = 0) -> BrowserLiveFrame | None:
        deadline = time.monotonic() + max(0, min(wait_ms, 5_000)) / 1_000
        with self._live_frame_condition:
            while True:
                frame = self._live_frames.get(tab_id)
                if frame is not None and frame.sequence > after_sequence:
                    return frame
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._live_frame_condition.wait(timeout=remaining)

    def tabs_create(self, input_data: dict | None = None) -> dict:
        del input_data
        try:
            session = self._ensure_session()
            page = session.context.new_page()
            tab = self._register_page(session, page, set_current=True)
            return {
                "currentUrl": page.url,
                "tabId": tab.tab_id,
                "title": to_title_or_none(page.title()),
            }
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def tabs_context(self, input_data: dict | None = None) -> dict:
        del input_data
        session = self._ensure_session()
        tabs = [
            {
                "isCurrent": tab.tab_id == session.current_tab_id,
                "tabId": tab.tab_id,
                "title": to_title_or_none(tab.page.title()),
                "url": tab.page.url,
            }
            for tab in sorted(session.tabs.values(), key=lambda item: item.tab_id)
        ]
        return {"currentTabId": session.current_tab_id, "tabs": tabs}

    def turn_answer_start(self, input_data: dict | None = None) -> dict:
        del input_data
        return {"startedAt": datetime.now(UTC).isoformat(), "status": "answer_turn_started"}

    def update_plan(self, input_data: dict) -> dict:
        domains = input_data.get("domains")
        approach = input_data.get("approach")
        if not isinstance(domains, list) or not domains or not all(isinstance(item, str) and item.strip() for item in domains):
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                "update_plan requires a non-empty domains list.",
                "Provide domains as a list of domain strings.",
            )
        if not isinstance(approach, list) or not 3 <= len(approach) <= 7 or not all(isinstance(item, str) and item.strip() for item in approach):
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                "update_plan requires an approach list with 3 to 7 non-empty steps.",
                "Provide 3 to 7 ordered steps.",
            )
        return {
            "approved": True,
            "approach": approach,
            "domains": domains,
            "updatedAt": datetime.now(UTC).isoformat(),
        }

    def navigate(self, input_data: dict) -> dict:
        started_at = datetime.now(UTC).isoformat()
        try:
            tab = self._get_tab_from_input(input_data)
            page = tab.page
            timeout_ms = input_data.get("timeout_ms") or self._settings.web_browser_navigation_timeout_ms
            wait_until = input_data.get("wait_until") or input_data.get("waitUntil") or "domcontentloaded"
            raw_target = input_data.get("url")
            target = raw_target if raw_target in {"back", "forward"} else normalize_runtime_url(raw_target)
            if target and target not in {"back", "forward"}:
                page.goto(target, timeout=timeout_ms, wait_until=wait_until)
                self._maybe_capture_gif_frame(tab, label="navigate")
                return {
                    "finalUrl": page.url,
                    "loadedAt": started_at,
                    "navigationMode": "url",
                    "tabId": tab.tab_id,
                    "title": to_title_or_none(page.title()),
                }
            direction = target or input_data.get("direction")
            if direction == "back":
                page.go_back(timeout=timeout_ms, wait_until=wait_until)
            elif direction == "forward":
                page.go_forward(timeout=timeout_ms, wait_until=wait_until)
            else:
                page.reload(timeout=timeout_ms, wait_until=wait_until)
            self._maybe_capture_gif_frame(tab, label="navigate")
            return {
                "finalUrl": page.url,
                "loadedAt": started_at,
                "navigationMode": direction or "reload",
                "tabId": tab.tab_id,
                "title": to_title_or_none(page.title()),
            }
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def read_page(self, input_data: dict) -> dict:
        if self._use_accessibility_mode(input_data):
            return self.read_accessibility_tree(input_data)
        try:
            if input_data.get("url"):
                self.navigate(input_data)
            tab = self._get_tab_from_input(input_data)
            page = tab.page
            self._guard_against_blocked_page(page)
            content = extract_page_content(
                html=page.content(),
                include_links=bool(input_data.get("include_links", False)),
                max_chars=input_data.get("max_chars") or self._settings.web_page_max_chars,
                selector=input_data.get("selector"),
                url=page.url,
            )
            content["tabId"] = tab.tab_id
            return content
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def read_accessibility_tree(self, input_data: dict) -> dict:
        try:
            tab = self._get_tab_from_input(input_data)
            page = tab.page
            self._guard_against_blocked_page(page)
            tree = page.evaluate(
                "(params) => { const maxDepth = params.maxDepth; const filterMode = params.filterMode; const refId = params.refId; "
                + ACCESSIBILITY_TREE_SCRIPT
                + "}",
                {
                    "filterMode": input_data.get("filter") or "all",
                    "maxDepth": input_data.get("depth") or DEFAULT_ACCESSIBILITY_DEPTH,
                    "refId": input_data.get("ref_id") or input_data.get("refId"),
                },
            )
            shaped_tree, serialized_chars, truncated = maybe_truncate_value(
                tree,
                input_data.get("max_chars") or DEFAULT_MAX_PAGE_CHARS,
            )
            return {
                "currentUrl": page.url,
                "serializedChars": serialized_chars,
                "tabId": tab.tab_id,
                "tree": shaped_tree,
                "truncated": truncated,
            }
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def get_page_text(self, input_data: dict) -> dict:
        try:
            tab = self._get_tab_from_input(input_data)
            page = tab.page
            self._guard_against_blocked_page(page)
            payload = extract_page_text(
                html=page.content(),
                max_chars=input_data.get("max_chars") or DEFAULT_MAX_PAGE_CHARS,
                selector=input_data.get("selector"),
            )
            payload["currentUrl"] = page.url
            payload["tabId"] = tab.tab_id
            return payload
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def find(self, input_data: dict) -> dict:
        parameters = dict(input_data)
        parameters["limit"] = parameters.get("limit") or DEFAULT_FIND_LIMIT
        parameters["description"] = parameters.get("description") or parameters.get("query")
        result = self.find_element(parameters)
        return {
            "currentUrl": result["currentUrl"],
            "matches": result["candidates"][: DEFAULT_FIND_LIMIT],
            "tabId": result["tabId"],
        }

    def find_element(self, input_data: dict) -> dict:
        description = input_data.get("description") or input_data.get("query")
        if not description:
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                "A natural-language description or query is required.",
                "Provide description or query.",
            )
        limit = input_data.get("limit") or DEFAULT_ELEMENT_LIMIT
        try:
            tab = self._get_tab_from_input(input_data)
            page = tab.page
            self._guard_against_blocked_page(page)
            candidates = page.evaluate(
                "(params) => { const description = params.description; const limit = params.limit; const selector = params.selector; "
                + FIND_ELEMENT_SCRIPT
                + "}",
                {"description": description, "limit": limit, "selector": INTERACTION_SELECTOR},
            )
            if not candidates:
                raise BrowserRuntimeError(
                    "WEB_ELEMENT_NOT_FOUND",
                    False,
                    404,
                    f'No element matched the description "{description}".',
                    "Try a more specific element description or inspect the page with read_page or screenshot first.",
                )
            return {
                "candidates": candidates,
                "currentUrl": page.url,
                "matchedElement": candidates[0],
                "tabId": tab.tab_id,
            }
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def inspect_at_point(self, input_data: dict) -> dict:
        try:
            tab = self._get_tab_from_input(input_data)
            page = tab.page
            self._guard_against_blocked_page(page)
            x = input_data.get("x")
            y = input_data.get("y")
            if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                raise BrowserRuntimeError(
                    "WEB_TOOL_VALIDATION_FAILED",
                    False,
                    400,
                    "inspect_at_point requires numeric x and y coordinates.",
                    "Provide viewport coordinates from the current browser frame.",
                )
            element = page.evaluate(
                "(params) => { " + INSPECT_AT_POINT_SCRIPT + "}",
                {"x": x, "y": y},
            )
            if not element:
                raise BrowserRuntimeError(
                    "WEB_ELEMENT_NOT_FOUND",
                    False,
                    404,
                    "No element was found at the requested viewport coordinate.",
                    "Refresh the frame and select a visible point inside the page.",
                )
            return {
                "currentUrl": page.url,
                "element": element,
                "inspectedAt": datetime.now(UTC).isoformat(),
                "tabId": tab.tab_id,
                "title": to_title_or_none(page.title()),
            }
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def click(self, input_data: dict) -> dict:
        try:
            tab = self._get_tab_from_input(input_data)
            page = tab.page
            self._guard_against_blocked_page(page)
            selector = self._resolve_selector(input_data.get("selector"), input_data.get("description"), input_data.get("ref"), tab.tab_id)
            locator = page.locator(selector).first
            timeout_ms = input_data.get("timeout_ms") or self._settings.web_browser_navigation_timeout_ms
            locator.wait_for(state="visible", timeout=timeout_ms)
            locator.scroll_into_view_if_needed()
            locator.click(
                button=input_data.get("button") or "left",
                click_count=input_data.get("click_count") or input_data.get("clickCount") or 1,
                timeout=timeout_ms,
                modifiers=self._normalize_modifiers(input_data.get("modifiers")),
            )
            self._maybe_capture_gif_frame(tab, label="click")
            return {"clickedSelector": selector, "currentUrl": page.url, "tabId": tab.tab_id}
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def type(self, input_data: dict) -> dict:
        try:
            tab = self._get_tab_from_input(input_data)
            page = tab.page
            self._guard_against_blocked_page(page)
            selector = self._resolve_selector(input_data.get("selector"), input_data.get("description"), input_data.get("ref"), tab.tab_id)
            locator = page.locator(selector).first
            timeout_ms = input_data.get("timeout_ms") or self._settings.web_browser_navigation_timeout_ms
            locator.wait_for(state="visible", timeout=timeout_ms)
            locator.scroll_into_view_if_needed()
            locator.focus()
            if input_data.get("clear_first", True):
                locator.fill("", timeout=timeout_ms)
            delay_ms = input_data.get("delay_ms") or 0
            text = input_data["text"]
            if delay_ms > 0:
                locator.type(text, delay=delay_ms, timeout=timeout_ms)
            else:
                locator.fill(text, timeout=timeout_ms)
            if input_data.get("press_enter"):
                page.keyboard.press("Enter")
            self._maybe_capture_gif_frame(tab, label="type")
            return {"currentUrl": page.url, "tabId": tab.tab_id, "typedLength": len(text), "usedSelector": selector}
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def form_input(self, input_data: dict) -> dict:
        try:
            tab = self._get_tab_from_input(input_data)
            page = tab.page
            selector = self._resolve_selector(input_data.get("selector"), input_data.get("description"), input_data.get("ref"), tab.tab_id)
            locator = page.locator(selector).first
            timeout_ms = input_data.get("timeout_ms") or self._settings.web_browser_navigation_timeout_ms
            locator.wait_for(state="attached", timeout=timeout_ms)
            locator.scroll_into_view_if_needed()
            descriptor = locator.evaluate(
                """(element) => ({
                    inputType: element.type || null,
                    multiple: !!element.multiple,
                    tag: element.tagName.toLowerCase()
                })"""
            )
            value = input_data["value"]
            if descriptor["tag"] == "select":
                locator.select_option(str(value), timeout=timeout_ms)
            elif descriptor["inputType"] in {"checkbox", "radio"}:
                if not isinstance(value, bool):
                    raise BrowserRuntimeError(
                        "WEB_TOOL_VALIDATION_FAILED",
                        False,
                        400,
                        "Checkbox and radio inputs require a boolean value.",
                        "Provide true or false.",
                    )
                locator.set_checked(value, timeout=timeout_ms)
            else:
                locator.fill(str(value), timeout=timeout_ms)
            self._maybe_capture_gif_frame(tab, label="form-input")
            return {
                "currentUrl": page.url,
                "tabId": tab.tab_id,
                "usedSelector": selector,
                "valueType": type(value).__name__,
            }
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def press_key(self, input_data: dict) -> dict:
        try:
            tab = self._get_tab_from_input(input_data)
            page = tab.page
            timeout_ms = input_data.get("timeout_ms") or self._settings.web_browser_navigation_timeout_ms
            resolved_selector: str | None = None
            if input_data.get("selector") or input_data.get("description") or input_data.get("ref"):
                resolved_selector = self._resolve_selector(input_data.get("selector"), input_data.get("description"), input_data.get("ref"), tab.tab_id)
                locator = page.locator(resolved_selector).first
                locator.wait_for(state="visible", timeout=timeout_ms)
                locator.focus()
            page.keyboard.press(input_data["key"])
            self._maybe_capture_gif_frame(tab, label="press-key")
            return {"currentUrl": page.url, "key": input_data["key"], "tabId": tab.tab_id, "usedSelector": resolved_selector}
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def scroll(self, input_data: dict) -> dict:
        try:
            tab = self._get_tab_from_input(input_data)
            page = tab.page
            self._guard_against_blocked_page(page)
            direction = input_data.get("direction") or "down"
            amount = input_data.get("amount") or 900
            selector = input_data.get("selector") or input_data.get("ref")
            if selector:
                result = page.locator(selector).first.evaluate(
                    """(element, params) => {
                        const target = element;
                        if (params.direction === 'top') {
                          target.scrollTo({ left: target.scrollLeft, top: 0 });
                        } else if (params.direction === 'bottom') {
                          target.scrollTo({ left: target.scrollLeft, top: target.scrollHeight });
                        } else if (params.direction === 'left') {
                          target.scrollBy({ left: -params.amount, top: 0 });
                        } else if (params.direction === 'right') {
                          target.scrollBy({ left: params.amount, top: 0 });
                        } else if (params.direction === 'up') {
                          target.scrollBy({ left: 0, top: -params.amount });
                        } else {
                          target.scrollBy({ left: 0, top: params.amount });
                        }
                        return { scrollLeft: target.scrollLeft, scrollTop: target.scrollTop };
                    }""",
                    {"amount": amount, "direction": direction},
                )
            else:
                result = page.evaluate(
                    """(params) => {
                        if (params.direction === 'top') {
                          window.scrollTo({ left: window.scrollX, top: 0 });
                        } else if (params.direction === 'bottom') {
                          window.scrollTo({ left: window.scrollX, top: document.documentElement.scrollHeight });
                        } else if (params.direction === 'left') {
                          window.scrollBy({ left: -params.amount, top: 0 });
                        } else if (params.direction === 'right') {
                          window.scrollBy({ left: params.amount, top: 0 });
                        } else if (params.direction === 'up') {
                          window.scrollBy({ left: 0, top: -params.amount });
                        } else {
                          window.scrollBy({ left: 0, top: params.amount });
                        }
                        return { scrollLeft: window.scrollX, scrollTop: window.scrollY };
                    }""",
                    {"amount": amount, "direction": direction},
                )
            self._maybe_capture_gif_frame(tab, label="scroll")
            return {
                "currentUrl": page.url,
                "direction": direction,
                "scrollLeft": result["scrollLeft"],
                "scrollTop": result["scrollTop"],
                "tabId": tab.tab_id,
            }
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def run_js(self, input_data: dict) -> dict:
        try:
            tab = self._get_tab_from_input(input_data)
            page = tab.page
            self._guard_against_blocked_page(page)
            result = page.evaluate(
                """(payload) => {
                    const runner = new Function('args', payload.code);
                    return runner(payload.args);
                }""",
                {"args": input_data.get("args"), "code": input_data["code"]},
            )
            shaped_result, serialized_chars, truncated = maybe_truncate_value(
                result,
                input_data.get("max_chars") or self._settings.web_run_js_max_chars,
            )
            return {
                "currentUrl": page.url,
                "result": shaped_result,
                "serializedChars": serialized_chars,
                "tabId": tab.tab_id,
                "truncated": truncated,
            }
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def read_console_messages(self, input_data: dict) -> dict:
        tab = self._get_tab_from_input(input_data)
        pattern = input_data.get("pattern")
        regex = re.compile(pattern) if pattern else None
        only_errors = bool(input_data.get("onlyErrors"))
        limit = int(input_data.get("limit") or 100)
        messages = []
        for message in tab.console_messages:
            if only_errors and message["type"] not in {"error", "pageerror"}:
                continue
            if regex and not regex.search(message["text"]):
                continue
            messages.append(message)
        if input_data.get("clear"):
            tab.console_messages.clear()
        return {"messages": messages[:limit], "tabId": tab.tab_id}

    def read_network_requests(self, input_data: dict) -> dict:
        tab = self._get_tab_from_input(input_data)
        pattern = input_data.get("urlPattern")
        regex = re.compile(pattern) if pattern else None
        limit = int(input_data.get("limit") or 100)
        requests = []
        for entry in tab.network_requests:
            if regex and not regex.search(entry["url"]):
                continue
            requests.append(entry)
        if input_data.get("clear"):
            tab.network_requests.clear()
            tab.pending_request_indexes.clear()
        return {"requests": requests[:limit], "tabId": tab.tab_id}

    def resize_window(self, input_data: dict) -> dict:
        try:
            tab = self._get_tab_from_input(input_data)
            width = int(input_data["width"])
            height = int(input_data["height"])
            tab.page.set_viewport_size({"width": width, "height": height})
            self._maybe_capture_gif_frame(tab, label="resize")
            return {
                "currentUrl": tab.page.url,
                "height": height,
                "tabId": tab.tab_id,
                "width": width,
            }
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def upload_image(self, input_data: dict) -> dict:
        try:
            tab = self._get_tab_from_input(input_data)
            page = tab.page
            image_id = input_data.get("imageId")
            if not isinstance(image_id, str) or not image_id.strip():
                raise BrowserRuntimeError(
                    "WEB_TOOL_VALIDATION_FAILED",
                    False,
                    400,
                    "upload_image requires imageId.",
                    "Provide the imageId from a previous screenshot or a valid local image path.",
                )
            file_path = self._resolve_artifact_path(image_id)
            upload_name = input_data.get("filename") or file_path.name
            selector = self._resolve_optional_target_selector(input_data, tab.tab_id)
            if selector:
                locator = page.locator(selector).first
                locator.wait_for(state="attached", timeout=self._settings.web_browser_navigation_timeout_ms)
                locator.set_input_files(str(file_path))
                self._maybe_capture_gif_frame(tab, label="upload-image")
                return {"currentUrl": page.url, "filename": upload_name, "tabId": tab.tab_id, "usedSelector": selector}
            coordinate = self._require_coordinate(input_data.get("coordinate"))
            payload = {
                "base64": base64.b64encode(file_path.read_bytes()).decode("ascii"),
                "filename": upload_name,
                "mimeType": _mime_type_for_path(file_path),
                "x": coordinate[0],
                "y": coordinate[1],
            }
            page.evaluate(
                """async (payload) => {
                    const target = document.elementFromPoint(payload.x, payload.y);
                    if (!target) {
                      throw new Error('No element found at the target coordinate.');
                    }
                    const binary = atob(payload.base64);
                    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
                    const file = new File([bytes], payload.filename, { type: payload.mimeType });
                    const transfer = new DataTransfer();
                    transfer.items.add(file);
                    for (const eventName of ['dragenter', 'dragover', 'drop']) {
                      const event = new DragEvent(eventName, { bubbles: true, cancelable: true, dataTransfer: transfer });
                      target.dispatchEvent(event);
                    }
                }""",
                payload,
            )
            self._maybe_capture_gif_frame(tab, label="upload-image")
            return {"coordinate": [coordinate[0], coordinate[1]], "currentUrl": page.url, "filename": upload_name, "tabId": tab.tab_id}
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def gif_creator(self, input_data: dict) -> dict:
        try:
            tab = self._get_tab_from_input(input_data)
            action = input_data.get("action")
            if action == "start_recording":
                tab.gif_frames.clear()
                tab.gif_options = dict(input_data.get("options") or {})
                tab.gif_recording = True
                self._maybe_capture_gif_frame(tab, label="gif-start")
                return {"frameCount": len(tab.gif_frames), "status": "recording", "tabId": tab.tab_id}
            if action == "stop_recording":
                tab.gif_recording = False
                return {"frameCount": len(tab.gif_frames), "status": "stopped", "tabId": tab.tab_id}
            if action == "clear":
                for frame_path in tab.gif_frames:
                    Path(frame_path).unlink(missing_ok=True)
                tab.gif_frames.clear()
                tab.gif_options = {}
                tab.gif_recording = False
                return {"frameCount": 0, "status": "cleared", "tabId": tab.tab_id}
            if action == "export":
                if Image is None:
                    raise BrowserRuntimeError(
                        "WEB_RUNTIME_MISSING_DEPENDENCY",
                        False,
                        500,
                        "Pillow is not installed, so GIF export is unavailable.",
                        "Install project dependencies again to include Pillow.",
                    )
                if not tab.gif_frames:
                    raise BrowserRuntimeError(
                        "WEB_RUNTIME_FAILURE",
                        False,
                        409,
                        "No recorded frames are available for GIF export.",
                        "Start recording, perform actions, then export the GIF.",
                    )
                output_name = input_data.get("filename") or f"browser-session-{tab.tab_id}.gif"
                output_path = self._screenshot_dir / output_name
                frame_duration_ms = 250
                frames = [Image.open(frame_path).convert("P", palette=Image.ADAPTIVE) for frame_path in tab.gif_frames]
                try:
                    frames[0].save(
                        output_path,
                        save_all=True,
                        append_images=frames[1:],
                        duration=frame_duration_ms,
                        loop=0,
                        optimize=True,
                    )
                finally:
                    for frame in frames:
                        frame.close()
                self._ensure_session().artifacts[output_path.stem] = str(output_path)
                return {
                    "currentUrl": tab.page.url,
                    "frameCount": len(tab.gif_frames),
                    "imageId": output_path.stem,
                    "outputPath": str(output_path),
                    "status": "exported",
                    "tabId": tab.tab_id,
                }
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                "gif_creator action must be one of start_recording, stop_recording, export, clear.",
                "Provide a supported gif_creator action.",
            )
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def save_screenshot(self, input_data: dict | None = None) -> dict:
        params = input_data or {}
        try:
            tab = self._get_tab_from_input(params)
            page = tab.page
            self._guard_against_blocked_page(page)
            fmt = params.get("format") or "png"
            output_path = self._screenshot_dir / f"page-{datetime.now(UTC).strftime('%Y%m%d%H%M%S%f')}.{fmt}"
            timeout_ms = params.get("timeout_ms") or self._settings.web_browser_navigation_timeout_ms
            if selector := (params.get("selector") or params.get("ref")):
                locator = page.locator(selector).first
                locator.wait_for(state="visible", timeout=timeout_ms)
                locator.scroll_into_view_if_needed()
                screenshot_args: dict[str, object] = {"path": str(output_path), "type": fmt}
                if fmt == "jpeg" and params.get("quality"):
                    screenshot_args["quality"] = params["quality"]
                locator.screenshot(**screenshot_args)
            elif region := params.get("region"):
                screenshot_args = {"path": str(output_path), "type": fmt, "clip": self._clip_from_region(region)}
                page.screenshot(**screenshot_args)
            else:
                screenshot_args = {
                    "path": str(output_path),
                    "type": fmt,
                    "full_page": params.get("full_page", True),
                }
                if fmt == "jpeg" and params.get("quality"):
                    screenshot_args["quality"] = params["quality"]
                page.screenshot(**screenshot_args)
            image_id = output_path.stem
            self._ensure_session().artifacts[image_id] = str(output_path)
            self._maybe_capture_gif_frame(tab, label="screenshot")
            return {
                "currentUrl": page.url,
                "imageId": image_id,
                "liveStreamAvailable": tab.live_stream_started,
                "outputPath": str(output_path),
                "selector": selector if (params.get("selector") or params.get("ref")) else None,
                "tabId": tab.tab_id,
            }
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def computer(self, input_data: dict) -> dict:
        action = input_data.get("action")
        if not action:
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                "computer action is required.",
                "Provide the action parameter.",
            )
        try:
            tab = self._get_tab_from_input(input_data)
            page = tab.page
            self._guard_against_blocked_page(page)
            if action == "screenshot":
                return self.save_screenshot(input_data)
            if action == "wait":
                duration_seconds = min(float(input_data.get("duration") or 1), 10.0)
                page.wait_for_timeout(duration_seconds * 1000)
                return {"duration": duration_seconds, "status": "waited", "tabId": tab.tab_id}
            if action == "scroll":
                direction = input_data.get("scroll_direction") or input_data.get("direction") or "down"
                amount = int(input_data.get("scroll_amount") or 3) * 300
                return self.scroll({"tabId": tab.tab_id, "direction": direction, "amount": amount})
            if action == "wheel":
                delta_x = float(input_data.get("delta_x") or 0)
                delta_y = float(input_data.get("delta_y") or 0)
                page.mouse.wheel(delta_x, delta_y)
                self._maybe_capture_gif_frame(tab, label="computer-wheel")
                return {
                    "action": action,
                    "deltaX": delta_x,
                    "deltaY": delta_y,
                    "tabId": tab.tab_id,
                }
            if action == "scroll_to":
                if input_data.get("ref"):
                    selector = self._resolve_selector(None, None, input_data.get("ref"), tab.tab_id)
                    locator = page.locator(selector).first
                    locator.scroll_into_view_if_needed()
                    return {"status": "scrolled_into_view", "tabId": tab.tab_id, "usedSelector": selector}
                coordinate = self._require_coordinate(input_data.get("coordinate"))
                page.evaluate("([x, y]) => window.scrollTo({ left: x, top: y, behavior: 'instant' })", coordinate)
                return {"scrollLeft": coordinate[0], "scrollTop": coordinate[1], "tabId": tab.tab_id}
            if action == "key":
                return self._computer_key(page, tab.tab_id, input_data)
            if action == "type":
                return self._computer_type(page, tab.tab_id, input_data)
            if action == "left_click_drag":
                return self._computer_drag(page, tab.tab_id, input_data)
            if action == "zoom":
                screenshot = self.save_screenshot({"tabId": tab.tab_id, "region": input_data.get("region")})
                screenshot["status"] = "captured_region"
                return screenshot
            if action in {"left_click", "right_click", "double_click", "triple_click", "hover"}:
                return self._computer_pointing(page, tab.tab_id, input_data)
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                f"Unsupported computer action: {action}",
                "Use one of the documented computer actions.",
            )
        except Exception as exc:
            raise self._as_runtime_error(exc) from exc

    def browser_batch(self, input_data: dict) -> dict:
        actions = input_data.get("actions")
        if not isinstance(actions, list) or not actions:
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                "browser_batch requires a non-empty actions list.",
                "Provide actions as [{name, input}].",
            )
        if len(actions) > DEFAULT_BATCH_ACTION_LIMIT:
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                f"browser_batch supports at most {DEFAULT_BATCH_ACTION_LIMIT} actions per batch.",
                "Split the workflow into multiple smaller batches.",
            )
        results: list[dict[str, Any]] = []
        for index, action in enumerate(actions):
            if not isinstance(action, dict):
                raise BrowserRuntimeError(
                    "WEB_TOOL_VALIDATION_FAILED",
                    False,
                    400,
                    f"Batch action at index {index} must be an object.",
                    "Provide each action as {name, input}.",
                )
            name = action.get("name")
            payload = dict(action.get("input") or {})
            if not isinstance(name, str) or not name.strip():
                raise BrowserRuntimeError(
                    "WEB_TOOL_VALIDATION_FAILED",
                    False,
                    400,
                    f"Batch action at index {index} is missing a valid name.",
                    "Provide a non-empty action name.",
                )
            results.append(
                {
                    "index": index,
                    "name": name,
                    "result": self._dispatch_action(name, payload),
                }
            )
        return {"count": len(results), "results": results}

    def _dispatch_action(self, name: str, payload: dict[str, Any]) -> dict:
        handlers = {
            "browser_batch": self.browser_batch,
            "click": self.click,
            "computer": self.computer,
            "find": self.find,
            "find_element": self.find_element,
            "form_input": self.form_input,
            "gif_creator": self.gif_creator,
            "get_page_text": self.get_page_text,
            "inspect_at_point": self.inspect_at_point,
            "javascript_tool": lambda data: self.run_js({"tabId": data.get("tabId"), "args": data.get("args"), "code": data["text"]}),
            "navigate": self.navigate,
            "press_key": self.press_key,
            "read_console_messages": self.read_console_messages,
            "read_network_requests": self.read_network_requests,
            "read_page": self.read_page,
            "resize_window": self.resize_window,
            "run_js": self.run_js,
            "screenshot": self.save_screenshot,
            "scroll": self.scroll,
            "tabs_context": self.tabs_context,
            "tabs_create": self.tabs_create,
            "turn_answer_start": self.turn_answer_start,
            "type": self.type,
            "update_plan": self.update_plan,
            "upload_image": self.upload_image,
        }
        handler = handlers.get(name)
        if handler is None:
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                f"Unsupported browser_batch action: {name}",
                "Use a registered browser action.",
            )
        return handler(payload)

    def _computer_pointing(self, page: Page, tab_id: int, input_data: dict) -> dict:
        tab = self._get_tab(tab_id)
        action = input_data["action"]
        click_map = {
            "double_click": ("left", 2),
            "left_click": ("left", 1),
            "right_click": ("right", 1),
            "triple_click": ("left", 3),
        }
        selector = self._resolve_optional_target_selector(input_data, tab_id)
        modifiers = self._normalize_modifiers(input_data.get("modifiers"))
        if selector:
            locator = page.locator(selector).first
            locator.wait_for(state="visible", timeout=self._settings.web_browser_navigation_timeout_ms)
            locator.scroll_into_view_if_needed()
            if action == "hover":
                locator.hover(timeout=self._settings.web_browser_navigation_timeout_ms, modifiers=modifiers)
            else:
                button, click_count = click_map[action]
                locator.click(
                    button=button,
                    click_count=click_count,
                    modifiers=modifiers,
                    timeout=self._settings.web_browser_navigation_timeout_ms,
                )
            self._maybe_capture_gif_frame(tab, label=f"computer-{action}")
            return {"action": action, "tabId": tab_id, "usedSelector": selector}

        coordinate = self._require_coordinate(input_data.get("coordinate"))
        with self._pressed_modifiers(page, modifiers):
            if action == "hover":
                page.mouse.move(coordinate[0], coordinate[1])
            else:
                button, click_count = click_map[action]
                page.mouse.click(coordinate[0], coordinate[1], button=button, click_count=click_count)
        self._maybe_capture_gif_frame(tab, label=f"computer-{action}")
        return {"action": action, "coordinate": coordinate, "tabId": tab_id}

    def _computer_key(self, page: Page, tab_id: int, input_data: dict) -> dict:
        tab = self._get_tab(tab_id)
        key = input_data.get("text")
        if not key:
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                "computer key action requires text with the key or chord to press.",
                "Provide text such as Enter or Control+A.",
            )
        repeat = int(input_data.get("repeat") or 1)
        if repeat < 1 or repeat > 100:
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                "repeat must be between 1 and 100.",
                "Adjust the repeat value.",
            )
        with self._pressed_modifiers(page, self._normalize_modifiers(input_data.get("modifiers"))):
            for _ in range(repeat):
                page.keyboard.press(key)
        self._maybe_capture_gif_frame(tab, label="computer-key")
        return {"key": key, "repeat": repeat, "tabId": tab_id}

    def _computer_type(self, page: Page, tab_id: int, input_data: dict) -> dict:
        tab = self._get_tab(tab_id)
        text = input_data.get("text")
        if not isinstance(text, str):
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                "computer type action requires text.",
                "Provide the text to type.",
            )
        selector = self._resolve_optional_target_selector(input_data, tab_id)
        if selector:
            locator = page.locator(selector).first
            locator.wait_for(state="visible", timeout=self._settings.web_browser_navigation_timeout_ms)
            locator.scroll_into_view_if_needed()
            locator.focus()
            if input_data.get("clear_first"):
                locator.fill("", timeout=self._settings.web_browser_navigation_timeout_ms)
        elif coordinate := input_data.get("coordinate"):
            x, y = self._require_coordinate(coordinate)
            page.mouse.click(x, y)
        modifiers = self._normalize_modifiers(input_data.get("modifiers"))
        if modifiers:
            with self._pressed_modifiers(page, modifiers):
                page.keyboard.type(text)
        else:
            # insert_text preserves Hebrew and other Unicode input exactly.
            page.keyboard.insert_text(text)
        self._maybe_capture_gif_frame(tab, label="computer-type")
        return {"tabId": tab_id, "textLength": len(text), "usedSelector": selector}

    def _computer_drag(self, page: Page, tab_id: int, input_data: dict) -> dict:
        tab = self._get_tab(tab_id)
        start = self._require_coordinate(input_data.get("start_coordinate"))
        end = self._require_coordinate(input_data.get("coordinate"))
        page.mouse.move(start[0], start[1])
        page.mouse.down()
        page.mouse.move(end[0], end[1])
        page.mouse.up()
        self._maybe_capture_gif_frame(tab, label="computer-drag")
        return {"endCoordinate": end, "startCoordinate": start, "tabId": tab_id}

    def _ensure_session(self) -> BrowserSession:
        if self._session is not None:
            return self._session
        if sync_playwright is None:
            raise BrowserRuntimeError(
                "WEB_RUNTIME_MISSING_DEPENDENCY",
                False,
                500,
                "The Python Playwright package is not installed.",
                "Install dependencies with `pip install -e .[dev]` and run `python -m playwright install chromium`.",
            )
        playwright = sync_playwright().start()
        chromium = playwright.chromium
        executable_path = self._resolve_executable_path()
        launch_args = {
            "user_data_dir": str(self._profile_dir),
            "headless": self._settings.web_browser_headless,
            "accept_downloads": False,
            "viewport": {"width": 1440, "height": 1200},
        }
        if executable_path is not None:
            launch_args["executable_path"] = executable_path
        try:
            context = chromium.launch_persistent_context(**launch_args)
        except Exception as exc:
            playwright.stop()
            raise BrowserRuntimeError(
                "WEB_RUNTIME_BROWSER_UNAVAILABLE",
                False,
                500,
                str(exc),
                "Install a Chromium browser for Playwright with `python -m playwright install chromium` or set WEB_BROWSER_EXECUTABLE_PATH.",
            ) from exc

        session = BrowserSession(context=context, playwright=playwright)
        self._session = session
        pages = list(context.pages) or [context.new_page()]
        restored_state = self._read_tab_state()
        restored_tabs = restored_state.get("tabs") if restored_state else None
        restored_current_index = restored_state.get("currentIndex") if restored_state else 0
        if isinstance(restored_tabs, list) and restored_tabs:
            while len(pages) < len(restored_tabs):
                pages.append(context.new_page())
            for extra_page in pages[len(restored_tabs):]:
                try:
                    extra_page.close()
                except Exception:
                    pass
            pages = pages[:len(restored_tabs)]

        for index, page in enumerate(pages):
            page.set_default_timeout(self._settings.web_browser_navigation_timeout_ms)
            if isinstance(restored_tabs, list) and index < len(restored_tabs):
                restored_url = restored_tabs[index].get("url") if isinstance(restored_tabs[index], dict) else None
                if isinstance(restored_url, str) and restored_url and restored_url != page.url:
                    try:
                        page.goto(
                            restored_url,
                            timeout=self._settings.web_browser_navigation_timeout_ms,
                            wait_until="domcontentloaded",
                        )
                    except Exception:
                        # The profile is still usable if a previously open site is
                        # temporarily unavailable. The viewer can navigate again.
                        pass
            self._register_page(
                session,
                page,
                set_current=index == restored_current_index if isinstance(restored_current_index, int) else index == 0,
            )
        context.on("page", lambda page: self._register_page(session, page, set_current=True))
        return session

    def _read_tab_state(self) -> dict[str, Any] | None:
        try:
            stat = self._tab_state_file.stat()
            if not self._tab_state_file.is_file() or stat.st_mode & 0o077:
                return None
            payload = json.loads(self._tab_state_file.read_text(encoding="utf-8"))
        except Exception:
            return None
        if not isinstance(payload, dict) or payload.get("version") != 1:
            return None
        raw_tabs = payload.get("tabs")
        if not isinstance(raw_tabs, list):
            return None
        tabs = []
        for candidate in raw_tabs[:32]:
            url = candidate.get("url") if isinstance(candidate, dict) else None
            if isinstance(url, str) and 0 < len(url) <= 2_000_000:
                tabs.append({"url": url})
        if not tabs:
            return None
        current_index = payload.get("currentIndex")
        if not isinstance(current_index, int) or current_index < 0 or current_index >= len(tabs):
            current_index = 0
        return {"tabs": tabs, "currentIndex": current_index}

    def _persist_tab_state(self) -> None:
        session = self._session
        if session is None:
            return
        ordered_tabs = [
            tab
            for tab in sorted(session.tabs.values(), key=lambda candidate: candidate.tab_id)
            if not tab.page.is_closed()
        ]
        if not ordered_tabs:
            return
        current_index = next(
            (index for index, tab in enumerate(ordered_tabs) if tab.tab_id == session.current_tab_id),
            0,
        )
        payload = json.dumps({
            "version": 1,
            "updatedAt": datetime.now(UTC).isoformat(),
            "currentIndex": current_index,
            "tabs": [{"url": tab.page.url} for tab in ordered_tabs],
        }, ensure_ascii=False)
        temporary_path = self._tab_state_file.with_name(
            f"{self._tab_state_file.name}.tmp-{os.getpid()}-{threading.get_ident()}"
        )
        file_descriptor = os.open(temporary_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.fchmod(file_descriptor, 0o600)
            with os.fdopen(file_descriptor, "w", encoding="utf-8") as state_stream:
                state_stream.write(payload)
            file_descriptor = -1
            os.replace(temporary_path, self._tab_state_file)
            os.chmod(self._tab_state_file, 0o600)
        finally:
            if file_descriptor >= 0:
                os.close(file_descriptor)
            try:
                temporary_path.unlink(missing_ok=True)
            except Exception:
                pass

    def _register_page(self, session: BrowserSession, page: Page, *, set_current: bool) -> BrowserTab:
        page_key = id(page)
        existing_id = session.page_ids.get(page_key)
        if existing_id is not None:
            if set_current:
                session.current_tab_id = existing_id
            return session.tabs[existing_id]

        tab_id = session.next_tab_id
        session.next_tab_id += 1
        tab = BrowserTab(tab_id=tab_id, page=page)
        session.tabs[tab_id] = tab
        session.page_ids[page_key] = tab_id
        if set_current or session.current_tab_id is None:
            session.current_tab_id = tab_id

        def on_console(message) -> None:
            tab.console_messages.append(
                {
                    "text": message.text,
                    "timestamp": datetime.now(UTC).isoformat(),
                    "type": message.type,
                }
            )
            self._trim_events(tab.console_messages)

        def on_page_error(error) -> None:
            tab.console_messages.append(
                {
                    "text": str(error),
                    "timestamp": datetime.now(UTC).isoformat(),
                    "type": "pageerror",
                }
            )
            self._trim_events(tab.console_messages)

        def on_request(request) -> None:
            entry = {
                "method": request.method,
                "resourceType": request.resource_type,
                "startedAt": datetime.now(UTC).isoformat(),
                "status": "pending",
                "tabId": tab_id,
                "url": request.url,
            }
            tab.pending_request_indexes[id(request)] = len(tab.network_requests)
            tab.network_requests.append(entry)

        def on_response(response) -> None:
            request = response.request
            index = tab.pending_request_indexes.get(id(request))
            if index is None or index >= len(tab.network_requests):
                return
            tab.network_requests[index].update(
                {
                    "contentType": response.headers.get("content-type"),
                    "endedAt": datetime.now(UTC).isoformat(),
                    "ok": response.ok,
                    "status": "completed",
                    "statusCode": response.status,
                }
            )

        def on_request_failed(request) -> None:
            index = tab.pending_request_indexes.get(id(request))
            if index is None or index >= len(tab.network_requests):
                return
            tab.network_requests[index].update(
                {
                    "endedAt": datetime.now(UTC).isoformat(),
                    "failureText": request.failure,
                    "status": "failed",
                }
            )

        def on_close() -> None:
            self._drop_tab(tab_id)

        page.on("console", on_console)
        page.on("pageerror", on_page_error)
        page.on("request", on_request)
        page.on("response", on_response)
        page.on("requestfailed", on_request_failed)
        page.on("close", lambda: on_close())
        self._start_live_stream(session, tab)
        return tab

    def _start_live_stream(self, session: BrowserSession, tab: BrowserTab) -> None:
        if tab.live_stream_started or tab.page.is_closed():
            return
        try:
            cdp_session = session.context.new_cdp_session(tab.page)
            tab.live_cdp_session = cdp_session

            def on_screencast_frame(event: dict[str, Any]) -> None:
                session_id = event.get("sessionId")
                try:
                    frame_data = base64.b64decode(event.get("data") or "")
                    metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
                    width = max(1, int(metadata.get("deviceWidth") or 1))
                    height = max(1, int(metadata.get("deviceHeight") or 1))
                    if frame_data:
                        with self._live_frame_condition:
                            self._live_frame_sequence += 1
                            self._live_frames[tab.tab_id] = BrowserLiveFrame(
                                captured_at=datetime.now(UTC).isoformat(),
                                data=frame_data,
                                height=height,
                                sequence=self._live_frame_sequence,
                                tab_id=tab.tab_id,
                                width=width,
                            )
                            self._live_frame_condition.notify_all()
                finally:
                    if session_id is not None:
                        try:
                            cdp_session.send("Page.screencastFrameAck", {"sessionId": session_id})
                        except Exception:
                            pass

            cdp_session.on("Page.screencastFrame", on_screencast_frame)
            cdp_session.send("Page.startScreencast", {
                "everyNthFrame": 1,
                "format": "jpeg",
                "maxHeight": LIVE_FRAME_MAX_HEIGHT,
                "maxWidth": LIVE_FRAME_MAX_WIDTH,
                "quality": LIVE_FRAME_QUALITY,
            })
            tab.live_stream_started = True
        except Exception:
            # Screenshot polling remains the compatibility fallback on browsers
            # that do not expose the Chromium Page.screencastFrame command.
            tab.live_cdp_session = None
            tab.live_stream_started = False

    def _drop_tab(self, tab_id: int) -> None:
        if self._session is None:
            return
        tab = self._session.tabs.pop(tab_id, None)
        if tab is None:
            return
        if tab.live_cdp_session is not None:
            try:
                tab.live_cdp_session.send("Page.stopScreencast")
            except Exception:
                pass
            try:
                tab.live_cdp_session.detach()
            except Exception:
                pass
        with self._live_frame_condition:
            self._live_frames.pop(tab_id, None)
            self._live_frame_condition.notify_all()
        self._session.page_ids.pop(id(tab.page), None)
        if self._session.current_tab_id == tab_id:
            remaining = sorted(self._session.tabs)
            self._session.current_tab_id = remaining[0] if remaining else None

    def _get_tab_from_input(self, input_data: dict | None) -> BrowserTab:
        return self._get_tab(self._extract_tab_id(input_data or {}))

    def _get_tab(self, tab_id: int | None) -> BrowserTab:
        session = self._ensure_session()
        resolved_tab_id = tab_id or session.current_tab_id
        if resolved_tab_id is None or resolved_tab_id not in session.tabs:
            raise BrowserRuntimeError(
                "WEB_TAB_NOT_FOUND",
                False,
                404,
                f"Unknown browser tab: {resolved_tab_id}",
                "Inspect tabs_context and pass a valid tabId.",
            )
        session.current_tab_id = resolved_tab_id
        return session.tabs[resolved_tab_id]

    def _extract_tab_id(self, input_data: dict) -> int | None:
        raw_value = input_data.get("tabId", input_data.get("tab_id"))
        if raw_value in {None, ""}:
            return None
        try:
            return int(raw_value)
        except (TypeError, ValueError) as exc:
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                "tabId must be an integer.",
                "Provide a valid tabId from tabs_context or tabs_create.",
            ) from exc

    def _resolve_selector(self, selector: str | None, description: str | None, ref: str | None, tab_id: int | None = None) -> str:
        if selector:
            return selector
        if ref:
            return ref
        if not description:
            raise BrowserRuntimeError(
                "WEB_SELECTOR_REQUIRED",
                False,
                400,
                "A selector, ref, or natural-language description is required for this action.",
                "Provide selector, ref, or description.",
            )
        match = self.find_element({"description": description, "limit": 1, "tabId": tab_id})
        return match["matchedElement"]["selector"]

    def _resolve_optional_target_selector(self, input_data: dict, tab_id: int) -> str | None:
        if input_data.get("selector") or input_data.get("ref") or input_data.get("description"):
            return self._resolve_selector(
                input_data.get("selector"),
                input_data.get("description"),
                input_data.get("ref"),
                tab_id,
            )
        return None

    def _resolve_executable_path(self) -> str | None:
        if self._settings.web_browser_executable_path:
            return self._settings.web_browser_executable_path
        for candidate in COMMON_BROWSER_PATHS:
            path = Path(candidate)
            if path.exists() and path.is_file():
                return candidate
        return None

    def _guard_against_blocked_page(self, page: Page) -> None:
        html = page.content()
        extracted = extract_page_content(
            html=html,
            include_links=False,
            max_chars=min(self._settings.web_page_max_chars, 5000),
            url=page.url,
        )
        if looks_like_blocked_page(extracted.get("title"), extracted.get("markdown", "")):
            raise BrowserRuntimeError(
                "WEB_NEEDS_HUMAN_BROWSER",
                False,
                409,
                "The page appears to be behind bot protection or a human verification step.",
                "Route this task through a human browser session or a compliant first-party API.",
            )

    def _use_accessibility_mode(self, input_data: dict) -> bool:
        return any(key in input_data for key in ("depth", "filter", "ref_id", "refId")) or input_data.get("mode") == "accessibility"

    def _normalize_modifiers(self, value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            candidates = [value]
        elif isinstance(value, list):
            candidates = [str(item) for item in value]
        else:
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                "modifiers must be a string or string array.",
                "Provide modifiers such as ['ctrl', 'shift'].",
            )
        normalized: list[str] = []
        for candidate in candidates:
            key = KEY_MODIFIER_MAP.get(candidate.strip().lower())
            if key and key not in normalized:
                normalized.append(key)
        return normalized

    def _require_coordinate(self, value: Any) -> tuple[float, float]:
        if not isinstance(value, (list, tuple)) or len(value) != 2:
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                "A coordinate must be provided as [x, y].",
                "Provide valid numeric coordinates.",
            )
        try:
            return float(value[0]), float(value[1])
        except (TypeError, ValueError) as exc:
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                "Coordinate values must be numeric.",
                "Provide valid numeric coordinates.",
            ) from exc

    def _clip_from_region(self, value: Any) -> dict[str, float]:
        if not isinstance(value, (list, tuple)) or len(value) != 4:
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                "A region must be provided as [x0, y0, x1, y1].",
                "Provide a valid region.",
            )
        try:
            x0, y0, x1, y1 = [float(entry) for entry in value]
        except (TypeError, ValueError) as exc:
            raise BrowserRuntimeError(
                "WEB_TOOL_VALIDATION_FAILED",
                False,
                400,
                "Region values must be numeric.",
                "Provide a valid region.",
            ) from exc
        return {"x": x0, "y": y0, "width": max(1.0, x1 - x0), "height": max(1.0, y1 - y0)}

    def _trim_events(self, events: list[dict[str, Any]]) -> None:
        excess = len(events) - DEFAULT_MAX_CAPTURED_EVENTS
        if excess > 0:
            del events[:excess]

    def _maybe_capture_gif_frame(self, tab: BrowserTab, *, label: str) -> None:
        if not tab.gif_recording:
            return
        frame_path = self._screenshot_dir / f"gif-tab-{tab.tab_id}-{label}-{datetime.now(UTC).strftime('%Y%m%d%H%M%S%f')}.png"
        tab.page.screenshot(path=str(frame_path), type="png")
        tab.gif_frames.append(str(frame_path))

    def _resolve_artifact_path(self, image_id: str) -> Path:
        session = self._ensure_session()
        candidate = session.artifacts.get(image_id)
        if candidate:
            path = Path(candidate)
            if path.exists():
                return path
        direct = Path(image_id)
        if direct.exists() and direct.is_file():
            return direct
        raise BrowserRuntimeError(
            "WEB_ARTIFACT_NOT_FOUND",
            False,
            404,
            f"Unknown image artifact: {image_id}",
            "Capture a screenshot first or provide a valid local image path.",
        )

    class _PressedModifiers:
        def __init__(self, page: Page, modifiers: list[str]) -> None:
            self._page = page
            self._modifiers = modifiers

        def __enter__(self) -> None:
            for modifier in self._modifiers:
                self._page.keyboard.down(modifier)

        def __exit__(self, exc_type, exc, tb) -> None:
            for modifier in reversed(self._modifiers):
                self._page.keyboard.up(modifier)

    def _pressed_modifiers(self, page: Page, modifiers: list[str]) -> _PressedModifiers:
        return self._PressedModifiers(page, modifiers)

    def _as_runtime_error(self, error: Exception) -> BrowserRuntimeError:
        if isinstance(error, BrowserRuntimeError):
            return error
        if isinstance(error, PlaywrightTimeoutError) or "Timeout" in str(error):
            return BrowserRuntimeError(
                "WEB_TIMEOUT",
                True,
                504,
                str(error),
                "Retry the page interaction or reduce the requested page complexity.",
            )
        if isinstance(error, PlaywrightError):
            return BrowserRuntimeError(
                "WEB_RUNTIME_FAILURE",
                True,
                502,
                str(error),
                "Retry the operation. If the site keeps failing, route to a human browser session.",
            )
        return BrowserRuntimeError(
            "WEB_RUNTIME_FAILURE",
            True,
            502,
            str(error),
            "Retry the operation. If the site keeps failing, route to a human browser session.",
        )

    def _bridge_url(self) -> str | None:
        if self._bridge_port is None:
            return None
        return f"http://127.0.0.1:{self._bridge_port}"

    def _resolve_bridge_port(self) -> int:
        digest = hashlib.sha1(str(self._profile_dir).encode("utf-8")).digest()
        base_offset = int.from_bytes(digest[:2], "big") % DEFAULT_BRIDGE_PORT_SPAN
        candidate = DEFAULT_BRIDGE_PORT_BASE + base_offset
        return candidate

    def _start_bridge_server(self) -> None:
        if self._bridge_server is not None:
            return

        runtime = self

        class BridgeHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                if not self._is_authorized():
                    self._write_json({"ok": False, "error": {"message": "Unauthorized browser bridge request."}}, 401)
                    return
                parsed = urlparse(self.path)
                if parsed.path == "/health":
                    self._write_json({"ok": True, "result": runtime.dispatch_action("browser_health", {})}, 200)
                    return
                if parsed.path == "/viewer/frame":
                    query = parse_qs(parsed.query)
                    try:
                        tab_id = int((query.get("tabId") or [""])[0])
                        after_sequence = int((query.get("after") or ["0"])[0])
                        wait_ms = int((query.get("waitMs") or ["0"])[0])
                    except (TypeError, ValueError):
                        self._write_json({"ok": False, "error": {"message": "Invalid live frame query."}}, 400)
                        return
                    frame = runtime.read_live_frame(tab_id, after_sequence, wait_ms)
                    if frame is None:
                        self.send_response(204)
                        self.send_header("Cache-Control", "no-store")
                        self.end_headers()
                        return
                    self._write_live_frame(frame)
                    return
                else:
                    self.send_response(404)
                    self.end_headers()
                    return

            def do_POST(self):
                if not self._is_authorized():
                    self._write_json({"ok": False, "error": {"message": "Unauthorized browser bridge request."}}, 401)
                    return
                allowed_paths = {"/call"}
                if self.path not in allowed_paths:
                    self.send_response(404)
                    self.end_headers()
                    return
                try:
                    content_length = int(self.headers.get("content-length", "0"))
                except ValueError:
                    content_length = 0
                raw = self.rfile.read(content_length) if content_length > 0 else b"{}"
                try:
                    payload = json.loads(raw.decode("utf-8") or "{}")
                    name = payload.get("name")
                    if not isinstance(name, str) or not name.strip():
                        raise BrowserRuntimeError(
                            "WEB_TOOL_VALIDATION_FAILED",
                            False,
                            400,
                            "Tool name is required.",
                            "Provide a valid browser tool name.",
                        )
                    result = runtime.dispatch_action(name.strip(), payload.get("arguments") or {})
                    self._write_json({"ok": True, "result": result}, 200)
                except BrowserRuntimeError as exc:
                    self._write_json({
                        "ok": False,
                        "error": {
                            "error_code": exc.error_code,
                            "message": str(exc),
                            "is_retryable": exc.is_retryable,
                            "status_code": exc.status_code,
                            "suggested_remediation": exc.suggested_remediation,
                        },
                    }, exc.status_code)
                except Exception as exc:
                    self._write_json({
                        "ok": False,
                        "error": {
                            "error_code": "BROWSER_MODE_RUNTIME_FAILURE",
                            "message": str(exc),
                            "is_retryable": False,
                            "status_code": 500,
                            "suggested_remediation": "Inspect the local browser-mode runtime logs.",
                        },
                    }, 500)

            def log_message(self, format, *args):
                del format, args

            def _is_authorized(self) -> bool:
                authorization = self.headers.get("authorization", "")
                return hmac.compare_digest(authorization, f"Bearer {runtime._bridge_token}")

            def _write_json(self, payload: dict[str, Any], status_code: int):
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status_code)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _write_live_frame(self, frame: BrowserLiveFrame):
                self.send_response(200)
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(frame.data)))
                self.send_header("X-Frame-Captured-At", frame.captured_at)
                self.send_header("X-Frame-Height", str(frame.height))
                self.send_header("X-Frame-Sequence", str(frame.sequence))
                self.send_header("X-Frame-Width", str(frame.width))
                self.end_headers()
                self.wfile.write(frame.data)

        last_error: Exception | None = None
        start_port = self._resolve_bridge_port()
        for offset in range(25):
            port = start_port + offset
            try:
                server = ThreadingHTTPServer(("127.0.0.1", port), BridgeHandler)
                server.daemon_threads = True
                thread = threading.Thread(target=server.serve_forever, name=f"browser-runtime-bridge-{port}", daemon=True)
                thread.start()
                self._bridge_port = port
                self._bridge_server = server
                self._bridge_thread = thread
                bridge_payload = json.dumps({
                    "pid": os.getpid(),
                    "port": port,
                    "url": f"http://127.0.0.1:{port}",
                    "token": self._bridge_token,
                    "profile_dir": str(self._profile_dir),
                    "started_at": datetime.now(UTC).isoformat(),
                }, ensure_ascii=False)
                bridge_fd = os.open(self._bridge_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                try:
                    os.fchmod(bridge_fd, 0o600)
                    with os.fdopen(bridge_fd, "w", encoding="utf-8") as bridge_stream:
                        bridge_stream.write(bridge_payload)
                    bridge_fd = -1
                finally:
                    if bridge_fd >= 0:
                        os.close(bridge_fd)
                return
            except OSError as exc:
                last_error = exc
                continue

        raise RuntimeError(f"Failed to start browser HTTP bridge: {last_error}")

    def _stop_bridge_server(self) -> None:
        if self._bridge_server is not None:
            try:
                self._bridge_server.shutdown()
                self._bridge_server.server_close()
            finally:
                self._bridge_server = None
                self._bridge_thread = None
                self._bridge_port = None
        self._bridge_file.unlink(missing_ok=True)
