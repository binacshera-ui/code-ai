from __future__ import annotations

import re
from html import unescape
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from markdownify import markdownify as to_markdown
from readability import Document

BLOCKED_PAGE_MARKERS = [
    "captcha",
    "verify you are human",
    "access denied",
    "temporarily blocked",
    "checking your browser",
    "cf-chl-bypass",
    "why did this happen",
    "unusual traffic",
]
TURNDOWN_MAX_LINKS = 50
TURNDOWN_ELLIPSIS = "\n\n[truncated]"


def collapse_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def normalize_markdown(value: str) -> str:
    return (
        value.replace("\r\n", "\n")
        .replace("\n\n\n", "\n\n")
        .strip()
    )


def truncate_markdown(markdown: str, max_chars: int) -> tuple[str, bool]:
    if len(markdown) <= max_chars:
        return markdown, False
    allowance = max(0, max_chars - len(TURNDOWN_ELLIPSIS))
    return f"{markdown[:allowance].rstrip()}{TURNDOWN_ELLIPSIS}", True


def count_words(text: str) -> int:
    return len([word for word in re.split(r"\s+", text) if word.strip()])


def strip_noise(soup: BeautifulSoup) -> None:
    for selector in [
        "script",
        "style",
        "noscript",
        "svg",
        "canvas",
        "iframe",
        "footer nav",
        "header nav",
        "aside",
    ]:
        for node in soup.select(selector):
            node.decompose()


def extract_links(soup: BeautifulSoup, url: str) -> list[dict[str, str]]:
    links: list[dict[str, str]] = []
    seen: set[str] = set()
    for anchor in soup.select("a[href]"):
        href = anchor.get("href")
        text = collapse_whitespace(anchor.get_text(" ", strip=True))
        if not href or href.startswith("#"):
            continue
        resolved = urljoin(url, href)
        key = f"{resolved}::{text}"
        if key in seen:
            continue
        seen.add(key)
        links.append({"url": resolved, "text": text or resolved})
        if len(links) >= TURNDOWN_MAX_LINKS:
            break
    return links


def looks_like_blocked_page(title: str | None, text: str) -> bool:
    haystack = f"{title or ''} {text}".lower()
    return any(marker in haystack for marker in BLOCKED_PAGE_MARKERS)


def _selector_html(html: str, selector: str) -> str | None:
    soup = BeautifulSoup(html, "html.parser")
    strip_noise(soup)
    selected = soup.select_one(selector)
    if selected is None:
        return None
    return str(selected)


def _readability_html(html: str) -> tuple[str | None, str | None, str | None]:
    try:
        document = Document(html)
        summary = document.summary(html_partial=True)
        return summary, document.title(), document.short_title()
    except Exception:
        return None, None, None


def extract_page_content(
    *,
    html: str,
    url: str,
    max_chars: int,
    include_links: bool = False,
    selector: str | None = None,
) -> dict:
    base_soup = BeautifulSoup(html, "html.parser")
    strip_noise(base_soup)

    title = collapse_whitespace(base_soup.title.get_text(" ", strip=True)) if base_soup.title else None
    language = collapse_whitespace(base_soup.html.get("lang", "")) or None if base_soup.html else None
    excerpt: str | None = None
    byline: str | None = None
    site_name: str | None = None
    content_source = "document"
    content_html = str(base_soup.body or base_soup)
    text_content = collapse_whitespace(base_soup.get_text(" ", strip=True))

    if selector:
        selected_html = _selector_html(html, selector)
        if selected_html is None:
            raise ValueError(f"No element matched selector: {selector}")
        content_source = "selector"
        content_html = selected_html
        selected_soup = BeautifulSoup(selected_html, "html.parser")
        text_content = collapse_whitespace(selected_soup.get_text(" ", strip=True))
    else:
        readability_html, readability_title, readability_short_title = _readability_html(html)
        if readability_html:
            readable_soup = BeautifulSoup(readability_html, "html.parser")
            strip_noise(readable_soup)
            readable_text = collapse_whitespace(readable_soup.get_text(" ", strip=True))
            if readable_text:
                content_source = "readability"
                content_html = str(readable_soup)
                text_content = readable_text
                title = collapse_whitespace(readability_title or readability_short_title or title or "") or None
                excerpt = readable_text[:280] or None

    markdown = normalize_markdown(
        to_markdown(
            content_html,
            heading_style="ATX",
            bullets="-",
            autolinks=True,
        )
    )
    if not markdown and text_content:
        markdown = unescape(text_content)

    markdown, truncated = truncate_markdown(markdown, max_chars)

    return {
        "byline": byline,
        "contentSource": content_source,
        "excerpt": excerpt,
        "finalUrl": url,
        "language": language,
        "links": extract_links(base_soup, url) if include_links else [],
        "markdown": markdown,
        "siteName": site_name,
        "title": title,
        "truncated": truncated,
        "wordCount": count_words(text_content),
    }


def extract_page_text(
    *,
    html: str,
    max_chars: int,
    selector: str | None = None,
) -> dict:
    base_soup = BeautifulSoup(html, "html.parser")
    strip_noise(base_soup)
    title = collapse_whitespace(base_soup.title.get_text(" ", strip=True)) if base_soup.title else None
    content_source = "document"
    text_content = collapse_whitespace(base_soup.get_text(" ", strip=True))

    if selector:
        selected_html = _selector_html(html, selector)
        if selected_html is None:
            raise ValueError(f"No element matched selector: {selector}")
        selected_soup = BeautifulSoup(selected_html, "html.parser")
        strip_noise(selected_soup)
        content_source = "selector"
        text_content = collapse_whitespace(selected_soup.get_text(" ", strip=True))
    else:
        readability_html, readability_title, readability_short_title = _readability_html(html)
        if readability_html:
            readable_soup = BeautifulSoup(readability_html, "html.parser")
            strip_noise(readable_soup)
            readable_text = collapse_whitespace(readable_soup.get_text(" ", strip=True))
            if readable_text:
                content_source = "readability"
                text_content = readable_text
                title = collapse_whitespace(readability_title or readability_short_title or title or "") or None

    truncated_text, truncated = truncate_markdown(text_content, max_chars)
    return {
        "contentSource": content_source,
        "text": truncated_text,
        "title": title,
        "truncated": truncated,
        "wordCount": count_words(text_content),
    }
