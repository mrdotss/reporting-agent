"""Read one provider documentation page for Ask — and only from the provider's own docs.

The Azure skills are indexes of learn.microsoft.com pages, so without reading a page Ask
would know a topic's title and nothing else. This is the one place the runtime reads the
public web for a model, and it is fenced accordingly:

* **Two hosts, exactly**: `learn.microsoft.com` and `docs.aws.amazon.com`, over HTTPS. The
  URL comes from a vendored skill, never from a user or a model's free text — the model only
  picks among topics the skill already listed.
* **Redirects are followed by hand**, each target re-checked against the same allowlist, so a
  docs page cannot bounce the request anywhere else.
* **Bounded**: a timeout, a byte cap on the response, and a character cap on what reaches the
  prompt. A page that fails any of these is simply not read — Ask answers without it.

What comes back is data. The chat grounding wraps it as reference material, and the prompt
tells the model it is never instructions.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Final
from urllib.parse import urlencode, urljoin, urlsplit, urlunsplit

import httpx

__all__ = ["ALLOWED_HOSTS", "DocPage", "fetch_doc", "is_allowed"]

ALLOWED_HOSTS: Final[frozenset[str]] = frozenset({"learn.microsoft.com", "docs.aws.amazon.com"})
TIMEOUT_SECONDS: Final[float] = 8.0
MAX_BYTES: Final[int] = 1_500_000
MAX_TEXT_CHARS: Final[int] = 12_000
MAX_REDIRECTS: Final[int] = 3

_BLANK_LINES: Final[re.Pattern[str]] = re.compile(r"\n{3,}")
_MD_TITLE: Final[re.Pattern[str]] = re.compile(r"^# (.+?)\s*$", re.M)
_FRONT_MATTER: Final[re.Pattern[str]] = re.compile(r"\A---\n.*?\n---\n", re.S)


@dataclass(frozen=True, slots=True)
class DocPage:
    url: str
    title: str
    text: str


def is_allowed(url: str) -> bool:
    parts = urlsplit(url)
    return parts.scheme == "https" and parts.hostname in ALLOWED_HOSTS and not parts.port


def _request_urls(url: str) -> tuple[str, ...]:
    """The URLs to try, Markdown first: both hosts serve a page as Markdown when asked —
    learn.microsoft.com by query string, as Microsoft's skills specify, and
    docs.aws.amazon.com at the same path with `.md` for `.html` — which reads far cleaner
    than scraped HTML. The HTML page is the fallback."""
    parts = urlsplit(url)
    plain = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    if parts.hostname == "learn.microsoft.com":
        query = urlencode({"from": "learn-agent-skill", "accept": "text/markdown"})
        return (urlunsplit((parts.scheme, parts.netloc, parts.path, query, "")),)
    if parts.path.endswith(".html"):
        markdown = urlunsplit((parts.scheme, parts.netloc, parts.path[: -len(".html")] + ".md", "", ""))
        return (markdown, plain)
    return (plain,)


class _TextOf(HTMLParser):
    """An HTML page's readable text: skips scripts, styles and page chrome, keeps the rest."""

    _SKIP: Final[frozenset[str]] = frozenset({"script", "style", "nav", "header", "footer", "noscript", "svg"})
    _BLOCK: Final[frozenset[str]] = frozenset({"p", "div", "li", "tr", "h1", "h2", "h3", "h4", "pre", "br", "section"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title = ""
        self._skipping = 0
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._SKIP:
            self._skipping += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self._SKIP and self._skipping:
            self._skipping -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        elif not self._skipping:
            self.parts.append(data)


def _clean(text: str) -> str:
    lines = [" ".join(line.split()) for line in text.splitlines()]
    return _BLANK_LINES.sub("\n\n", "\n".join(lines)).strip()


async def fetch_doc(url: str, *, fallback_title: str = "", client: httpx.AsyncClient | None = None) -> DocPage | None:
    """The page's title and text, trimmed for a prompt — or `None` when it cannot be read."""
    if not is_allowed(url):
        return None
    owned = client is None
    client = client or httpx.AsyncClient(timeout=TIMEOUT_SECONDS, follow_redirects=False)
    try:
        for candidate in _request_urls(url):
            response = await _get(client, candidate)
            if response is not None:
                break
        else:
            return None
        body = response.text
        if "markdown" in response.headers.get("content-type", ""):
            body = _FRONT_MATTER.sub("", body, count=1)
            heading = _MD_TITLE.search(body)
            title = heading.group(1).split(" | ")[0].strip() if heading else fallback_title
            text = _clean(body)
        else:
            parser = _TextOf()
            parser.feed(body)
            title = html.unescape(parser.title).split("|")[0].strip() or fallback_title
            text = _clean("".join(parser.parts))
        if not text:
            return None
        return DocPage(url=url, title=title or url, text=text[:MAX_TEXT_CHARS])
    except (httpx.HTTPError, ValueError):
        return None
    finally:
        if owned:
            await client.aclose()


async def _get(client: httpx.AsyncClient, url: str) -> httpx.Response | None:
    """One GET, following at most a few redirects — each target re-checked — to a 200 of a
    bounded size, or `None`."""
    target = url
    for _ in range(MAX_REDIRECTS + 1):
        response = await client.get(target, headers={"User-Agent": "reporting-agent/1.0"})
        if not response.is_redirect:
            if response.status_code != 200 or len(response.content) > MAX_BYTES:
                return None
            return response
        location = urljoin(target, response.headers.get("location", ""))
        if not is_allowed(location):
            return None
        target = location
    return None
