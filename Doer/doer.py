#!/usr/bin/env python
# -*- coding: utf-8 -*-
# ---------------------------------------------------------------------------
# Doer/doer.py - drive Gemini in a real Chrome window and translate the novel
# one SOURCE UNIT at a time, straight from the Chinese original.
#
#   * launches Chrome through Selenium and signs in with the cookie jar kept in
#     Doer/account.json (the "Cookie-Editor" / "EditThisCookie" export format)
#   * walks sources/chapter_XXXX/original.zh.txt (the Chinese original - never
#     the finished English translation), lowest number first, ONE UNIT AT A TIME;
#     the retired sources/page_XXXX folders are still accepted
#   * pastes the translation prompt into Gemini's prompt box, presses send and
#     waits for the answer to stop streaming
#   * NEVER reloads the page between units: Gemini's own New chat control, the
#     <a href="/app" aria-label="New chat"> link in the header, is clicked, which
#     swaps the conversation in place. /app is opened exactly once per run
#   * an answer is only trusted once it stopped changing: after it looks finished
#     it is re-read --stable-hold seconds later (4 by default) and counts only
#     when that second read is identical, because Gemini sometimes rewrites a
#     reply right after it stopped streaming (a server hiccup on their side)
#   * an answer that came back without its "Answer:" marker is not thrown away:
#     the Redo button under that answer is clicked and "Try again" is picked in
#     the menu it opens (Longer / Shorter / Don't personalise / Try again), so
#     Gemini writes the same prompt's answer once more. That is tried three times
#     (--redo-retries) before anything else happens
#   * when the three redos still have no "Answer:" the unit starts over: New chat
#     is clicked, the very same prompt is pasted and sent again, and the three
#     redos are tried again - round after round until a reply carries its marker
#     (--max-rounds caps that; 0, the default, means keep going)
#   * keeps only what follows "Answer:" and writes it to
#     Doer/Result/chapter_XXXX/chapter_XXXX.txt (CRLF, one paragraph per line,
#     single trailing newline - the same shape as the source *.txt files)
#   * the chapter_XXXX layout needs no divider surgery: ONE UNIT IS ONE CHAPTER,
#     its 第N章 … heading sits in the file's own `# heading:` comment (so the body
#     is pure prose), and the heading the model may echo back at the top of its
#     answer is stripped. A "== Chapter 86 · On the Road (Part 2) ==" divider is
#     only produced for the legacy page layout, where the scrape glued several
#     chapters into one file (data/outline.json said where each one started).
#     English titles come from tools/chapter-titles.json.
#
# Usage
#   py Doer/doer.py                              translate every unit that is not done yet,
#                                                chapter_0001, chapter_0002, ... one at a time
#   py Doer/doer.py --pages 258-260              only these chapter numbers
#   py Doer/doer.py --limit 20                   stop after 20 units
#   py Doer/doer.py --dry-run --limit 1          show the first prompt, no browser
#   py Doer/doer.py --promote                    also copy each result into sources/
#   py Doer/doer.py --all --start 258 --limit 5  redo units even if they are done
#   py Doer/doer.py --redo-retries 5             more Redo -> "Try again" rounds at a bad reply
#   py Doer/doer.py --max-rounds 5               give up on a unit after 5 send rounds
#   py Doer/doer.py --stable-hold 6              wait longer before trusting a finished answer
#
# Resume: a unit is done when Doer/Result/chapter_XXXX/chapter_XXXX.txt (or,
# after --promote, sources/chapter_XXXX/chapter_XXXX.txt) exists. Every run
# prints where it left off and starts again at the first unit that has neither,
# so stopping with Ctrl+C and running the same command later never redoes
# finished units.
#
# The browser stays signed in between runs because it reuses
# Doer/chrome-profile; the cookie jar is re-injected on every start anyway.
# Inside a run the page is never reloaded either: every unit starts by clicking
# Gemini's New chat control, which resets the conversation in place. A unit whose
# reply keeps losing its "Answer:" marker is re-sent the same way - New chat, the
# same prompt pasted again, the three redos tried again - until it comes back
# right, so a unit only ends up in the failure list when --max-rounds says so.
# ---------------------------------------------------------------------------
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent          # .../novelity/Doer
NOVELITY = ROOT.parent                          # .../novelity
SOURCES = NOVELITY / "sources"

DEFAULT_OUT = ROOT / "Result"
DEFAULT_ACCOUNT = ROOT / "account.json"
DEFAULT_PROFILE = ROOT / "chrome-profile"

GEMINI_URL = "https://gemini.google.com/app"

# The prompt the whole thing is built around. {chapter} is the chapter number
# the page belongs to, {text} is the raw Chinese of that one page.
PROMPT_TEMPLATE = (
    'Act as web novel story translater, the goal is to not just translate, deeply put it '
    'simple way, not make up of sopphisticated words to describe or details too much, make it '
    'interesting, dark, align with what a novel of "Omnipresent God of War is like", '
    'Chapter {chapter}: [{text}], reminder the goal is to write simple word using, '
    'Do not use em dash in the novel'
    'Not shorten but simple words. DO not reply anything else, '
    'As in English'
    'reply as Answer: [your translation]'
)

try:
    from selenium import webdriver
    from selenium.common.exceptions import (
        ElementClickInterceptedException,
        NoSuchElementException,
        StaleElementReferenceException,
        WebDriverException,
    )
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.common.action_chains import ActionChains
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
except ImportError:  # pragma: no cover - dependency hint
    sys.exit("selenium is missing - install it with:  py -m pip install selenium")


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# Chinese has to survive a cp1252/cp437 console (and redirected output).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):                         # pragma: no cover
        pass


# ---------------------------------------------------------------------------
# 1. the source units
# ---------------------------------------------------------------------------
# sources/chapter_0001/ (the clean per-chapter split: ONE FOLDER = ONE CHAPTER)
# and the retired sources/page_0001/ scrape both look like "<kind>_NNNN".
UNIT_DIR_RE = re.compile(r"^(?:chapter|page)_(\d{4})$")
CHAPTER_HEADER_RE = re.compile(r"^#\s*chapters on this page:\s*(.*)$", re.M)
CHAPTER_NUM_RE = re.compile(r"ch(\d+)\b")
HEADING_HEADER_RE = re.compile(r"^#\s*heading:\s*(.+?)\s*$", re.M)
SOURCE_CHAPTER_RE = re.compile(r"^#\s*source chapter\s+(\d+)\s*$", re.M)
HEADING_RE = re.compile(r"^第(\d+)章[ \u3000]*(.*)$")
PART_CHARS = ("上", "下", "中", "一", "二", "三", "四")
# 上 / 下 - and the 一 / 二 of chapters 29-30 - name the two halves of one chapter.
# The same map the reader's own tool reads them with (tools/build-data.mjs), so a
# divider written here and the heading drawn there spell a half the same way.
PART_EN = {"上": "Part 1", "下": "Part 2", "一": "Part 1", "二": "Part 2"}
TITLES_FILE = NOVELITY / "tools" / "chapter-titles.json"
INDEX_FILE = SOURCES / "index.json"


def load_chapter_titles() -> dict:
    """tools/chapter-titles.json -> {chapter number: {en, partEn}}.

    An entry is the chapter's English title, or the record form when the half it
    names has to be spelled out:

        "151": "Counter-Plot"                                the usual entry
        "151": {"en": "Counter-Plot", "partEn": "Part 1"}    when one needs it

    Both are read as one record - the shape tools/build-data.mjs reads this very
    file in with for the reader. The Chinese title and its half are not this
    file's business any more: they come from the edition index
    (sources/index.json), the splitter's own record of every chapter.
    """
    if not TITLES_FILE.exists():
        log(f"! tools/{TITLES_FILE.name} not found - English title fall back to 'Chapter N'")
        return {}
    data = json.loads(TITLES_FILE.read_text(encoding="utf-8"))
    titles: dict[int, dict] = {}
    for key, value in data.items():
        if not str(key).isdigit():
            continue
        if isinstance(value, dict):
            titles[int(key)] = value                  # the full record, as written
        elif isinstance(value, str) and value.strip():
            titles[int(key)] = {"en": value.strip()}  # a bare English title
    return titles


def load_split_index() -> dict:
    """sources/index.json (tools/split-chapters.py) -> {chapter number: chapter}.

    The splitter's own record of every chapter, so the number, 第N章 heading and
    title the translator uses are exactly the ones the reader is built from.
    """
    if not INDEX_FILE.exists():
        return {}
    try:
        data = json.loads(INDEX_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        log(f"! sources/{INDEX_FILE.name} could not be read ({exc.__class__.__name__}) - "
            f"chapter headings come from the file headers instead")
        return {}
    return {c["num"]: c for c in data.get("chapters") or [] if isinstance(c.get("num"), int)}


def unit_chapter(num: int, heading: str, titles: dict, split: dict | None = None) -> dict:
    """The chapter a sources/chapter_XXXX folder holds, built from the split index.

    `heading` is the 第N章 … line the splitter kept in the file's "# heading:"
    comment, used when sources/index.json cannot be read, so this layout never
    needs data/outline.json (which describes the retired page scrape).
    """
    split = split if split and split.get("num") == num else {}
    heading = split.get("headingZh") or heading or f"第{num}章"
    if split:
        title_zh, part_zh = split.get("titleZh") or "", split.get("partZh") or ""
    else:
        title_zh, part_zh = "", ""
        match = HEADING_RE.match(heading)
        if match:
            words = match.group(2).split()
            if len(words) > 1 and words[-1] in PART_CHARS:   # 安定 上 / 安定 下
                part_zh = words.pop()
            title_zh = " ".join(words)
    # what the heading itself said, kept as the raw pair beside the curated one
    raw_title_zh, raw_part_zh = title_zh, part_zh
    # the split now and then glues a half onto its title (chapter 509 is 希望上,
    # not 希望 上): peeled off here the way tools/build-data.mjs peels it for the
    # reader, so both name that chapter's half the same
    if not part_zh and len(title_zh) > 1 and title_zh[-1] in PART_EN:
        part_zh = title_zh[-1]
        title_zh = title_zh[:-1]
    curated = titles.get(num) or {}
    # an older titles file carried the Chinese side too (zh / partZh); when it is
    # there it still wins, the precedence tools/split.mjs read it with
    title_zh = curated.get("zh") or title_zh
    part_zh = curated.get("partZh") or part_zh
    title_en = curated.get("en") or None
    # the half's English: written out in the entry when it needs to be, otherwise
    # 上 / 下 / 一 / 二 said the way the reader says them
    part_en = curated.get("partEn") or PART_EN.get(part_zh, "")
    heading_en = (f"Chapter {num} · {title_en}" + (f" ({part_en})" if part_en else "")
                  if title_en else None)
    return {
        "id": f"ch{num}",
        "num": num,
        "headingZh": heading or f"第{num}章",
        "rawTitleZh": raw_title_zh,
        "rawPartZh": raw_part_zh,
        "titleZh": title_zh,
        "partZh": part_zh,
        "titleEn": title_en,
        "partEn": part_en,
        "headingEn": heading_en,
    }


def load_pages(out_dir: Path = DEFAULT_OUT, count_sources: bool = True) -> list[dict]:
    """Every sources/<kind>_XXXX folder that has an original.zh.txt, lowest first.

    chapter_XXXX (the current layout) is one folder per chapter: the number and
    the 第N章 … heading come from the folder name and the file's own header
    comments. page_XXXX (the retired scrape) keeps the old behaviour, where the
    "# chapters on this page:" comment and data/outline.json say which chapters
    the file holds.

    A unit counts as done when its translation is in out_dir/<name>/ (where this
    script writes) or - unless --count-sources is off - in sources/<name>/
    (where --promote copies it), so a stopped run resumes at the first unit that
    has neither.
    """
    titles = load_chapter_titles()
    splits = load_split_index()
    entries: list[tuple[Path, str, int]] = []
    for entry in sorted(SOURCES.iterdir(), key=lambda p: p.name):
        match = UNIT_DIR_RE.match(entry.name)
        if not match or not entry.is_dir():
            continue
        if not (entry / "original.zh.txt").exists():
            continue
        entries.append((entry, entry.name.split("_")[0], int(match.group(1))))

    # only the legacy page layout needs the outline (it is page based)
    outline_pages = load_outline()[0] if any(kind == "page" for _, kind, _ in entries) else {}

    pages: list[dict] = []
    chapter = 0
    for entry, kind, num in entries:
        raw = (entry / "original.zh.txt").read_text(encoding="utf-8")
        header = CHAPTER_HEADER_RE.search(raw)
        numbers = CHAPTER_NUM_RE.findall(header.group(1)) if header else []
        heading = HEADING_HEADER_RE.search(raw)             # the 第N章 … comment line
        source_ch = SOURCE_CHAPTER_RE.search(raw)           # the "# source chapter N" line
        info = None
        if kind == "chapter":
            cnum = int(source_ch.group(1)) if source_ch else (int(numbers[0]) if numbers else num)
            info = unit_chapter(cnum, heading.group(1) if heading else "", titles, splits.get(cnum))
            chapter = info["num"]
        elif numbers:               # "(continuation only)" keeps the chapter we are already in
            chapter = int(numbers[0])
        # the body is the source text exactly as the splitter wrote it (the
        # outline offsets are character positions in it), so only the header
        # comment lines are dropped here
        lines = [line for line in raw.splitlines() if not line.lstrip().startswith("#")]
        while lines and not lines[0].strip():
            lines.pop(0)
        body = "\n".join(lines).rstrip("\n")
        name = entry.name
        in_sources = (entry / f"{name}.txt").exists()
        in_result = (out_dir / name / f"{name}.txt").exists()
        pages.append({
            "id": num,
            "name": name,
            "kind": kind,
            "dir": entry,
            "chapter": chapter,
            "chapter_key": info["id"] if info else None,
            "chapter_info": info,
            "one_chapter": info is not None,
            "zh": body,
            "body": body,
            "outline": outline_pages.get(num),
            "in_sources": in_sources,
            "in_result": in_result,
            "translated": in_result or (in_sources and count_sources),
        })
    return pages


def select_pages(pages: list[dict], args) -> list[dict]:
    """Apply --start/--end/--pages/--all/--limit, keeping source order."""
    wanted: set[int] | None = None
    if args.pages:
        wanted = set()
        for chunk in args.pages.split(","):
            chunk = chunk.strip()
            if not chunk:
                continue
            if "-" in chunk:
                low, high = chunk.split("-", 1)
                wanted.update(range(int(low), int(high) + 1))
            else:
                wanted.add(int(chunk))
    todo = []
    for page in pages:
        if wanted is not None and page["id"] not in wanted:
            continue
        if args.start is not None and page["id"] < args.start:
            continue
        if args.end is not None and page["id"] > args.end:
            continue
        if not args.all and page["translated"]:
            continue
        todo.append(page)
    if args.limit:
        todo = todo[:args.limit]
    return todo


# ---------------------------------------------------------------------------
# 1b. chapter breaks inside a source unit
#
# A chapter_XXXX unit is already split, so ONE UNIT IS ONE CHAPTER: there is no
# mid unit break to mark and nothing to strip, the chapter comes from the file's
# own header. Only the retired page_XXXX scrape needs the old surgery - it glued
# the 第86章路途下 heading straight onto the next paragraph, so data/outline.json
# said where each chapter started inside the file, the heading was replaced by a
# marker, and the marker came back from Gemini as the
# "== Chapter 86 · On the Road (Part 2) ==" divider the pipeline expects (one
# divider per chapter break inside the page - a chapter that starts the page
# gets none, its heading is generated from tools/chapter-titles.json).
# ---------------------------------------------------------------------------
OUTLINE_FILE = NOVELITY / "data" / "outline.json"
SENTINEL_RE = re.compile(r"[<\[*_]{0,4}\s*CHAPTER[\s_-]*BREAK\s*[:：]?\s*(\d*)\s*[>\]*_]{0,4}", re.I)
CHAPTER_RE = re.compile(r"chapter\s*(\d+)\b\s*[:\-–—·]?\s*", re.I)
PART_RE = re.compile(r"^(.{0,80}?\(part\s*\d\))\s*", re.I)


def load_outline() -> tuple[dict, dict]:
    """data/outline.json -> (pages by id, chapters by key)."""
    if not OUTLINE_FILE.exists():
        log("! data/outline.json not found - chapter breaks inside pages cannot be handled")
        return {}, {}
    data = json.loads(OUTLINE_FILE.read_text(encoding="utf-8"))
    return (
        {p["id"]: p for p in data.get("pages", [])},
        {c["id"]: c for c in data.get("chapters", [])},
    )


def page_breaks(page: dict, chapters: dict) -> list[dict]:
    """Every chapter start inside this unit's raw text, in reading order."""
    if page.get("one_chapter"):
        # chapter_XXXX: the unit *is* the chapter and its heading is already out
        # of the body, so the only break is the chapter starting the unit
        return [{
            "key": page["chapter_key"],
            "chapter": page["chapter_info"],
            "offset": 0,
            "at_start": True,
        }]
    segments = (page.get("outline") or {}).get("segments") or []
    if len(segments) < 2 and not (segments and segments[0].get("chapterKey")):
        return []
    if sum(int(s.get("chars") or 0) for s in segments) != len(page["body"]):
        log(f"  ! outline char counts do not match {page['name']}/original.zh.txt - headings left alone")
        return []
    breaks, offset = [], 0
    for index, segment in enumerate(segments):
        key = segment.get("chapterKey")
        if key:
            breaks.append({
                "key": key,
                "chapter": chapters.get(key, {}),
                "offset": offset,
                "at_start": index == 0,
            })
        offset += int(segment.get("chars") or 0)
    return breaks


def heading_chunk(text: str, at: int, chapter: dict) -> str | None:
    """The 第N章… heading exactly as the scrape left it, or None."""
    num = chapter.get("num")
    if not num:
        return None
    base = f"第{num}章"
    options: list[str] = []
    for title in (chapter.get("rawTitleZh"), chapter.get("titleZh")):
        for part in (chapter.get("rawPartZh"), chapter.get("partZh")):
            options.append(f"{base}{title or ''}{part or ''}")
        options.append(f"{base}{title or ''}")
    options.append(base)
    for option in options:
        if option and text.startswith(option, at):
            return option
    return None


def mark_breaks(page: dict, chapters: dict, keep_headings: bool) -> tuple[list[dict], str]:
    """Strip the 第N章 heading and mark mid page breaks with a sentinel."""
    breaks = [] if keep_headings else page_breaks(page, chapters)
    text = page["body"]
    if not breaks:
        return [], text
    if page.get("one_chapter"):
        # the splitter already parked 第N章 … in the file's "# heading:" comment,
        # so the body is pure prose and there is no heading to take out. The
        # at_start break is still handed back: apply_dividers() needs it to drop a
        # "Chapter N: …" line the model may echo at the top of its answer (and it
        # never turns an at_start break into a divider).
        return breaks, text
    shift = 0
    for brk in breaks:
        at = brk["offset"] + shift
        chunk = heading_chunk(text, at, brk["chapter"])
        if chunk is None:                      # heading not where the outline says
            base = f"第{brk['chapter'].get('num')}章"
            found = text.find(base, max(0, at - 40))
            if found < 0 or found > at + 40:
                log(f"  ! cannot find the {brk['key']} heading in {page['name']} - divider may be missing")
                continue
            at = found
            chunk = heading_chunk(text, at, brk["chapter"]) or base
        brk["sentinel"] = f"<<<CHAPTER-BREAK:{brk['chapter'].get('num')}>>>"
        replacement = "" if brk["at_start"] else f"\n{brk['sentinel']}\n"
        text = text[:at] + replacement + text[at + len(chunk):]
        shift += len(replacement) - len(chunk)
        if text[:1] == "\n":
            text = text[1:]
            shift -= 1
    return breaks, text.lstrip("\n")


# ---------------------------------------------------------------------------
# 2. the account cookie jar
# ---------------------------------------------------------------------------
SAMESITE = {
    "no_restriction": "None",
    "unspecified": "None",
    "none": "None",
    "lax": "Lax",
    "strict": "Strict",
}


def load_account(path: Path) -> list[dict]:
    if not path.exists():
        sys.exit(f"account cookie file not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict):              # tolerate {"cookies": [...]}
        data = data.get("cookies", [])
    if not isinstance(data, list) or not data:
        sys.exit(f"no cookies found in: {path}")
    return data


def domain_home(domain: str) -> str:
    return f"https://{domain.lstrip('.')}/"


def build_cookie(raw: dict) -> dict:
    """Turn one exported cookie into the dict ChromeDriver's add_cookie wants."""
    cookie = {
        "name": raw["name"],
        "value": raw["value"],
        "path": raw.get("path") or "/",
    }
    domain = (raw.get("domain") or "").strip()
    if domain:
        cookie["domain"] = domain
    if raw.get("secure"):
        cookie["secure"] = True
    if raw.get("httpOnly"):
        cookie["httpOnly"] = True
    same = SAMESITE.get(str(raw.get("sameSite") or "").lower())
    if same:
        cookie["sameSite"] = same
    expires = raw.get("expirationDate")
    if expires and not raw.get("session"):
        cookie["expiry"] = int(float(expires))
    return cookie


def inject_cookies(driver, cookies: list[dict]) -> int:
    """Visit each cookie domain and drop the whole jar in, Google first."""
    origins = sorted({domain_home(c.get("domain") or "") for c in cookies}, key=len)
    added = 0
    for origin in origins:
        try:
            driver.get(origin)
        except WebDriverException as exc:
            log(f"  ! could not open {origin}: {exc.__class__.__name__}")
            continue
        for raw in cookies:
            if domain_home(raw.get("domain") or "") != origin:
                continue
            for cookie in (build_cookie(raw), {**build_cookie(raw), "domain": (raw.get('domain') or '').lstrip('.')}):
                try:
                    driver.add_cookie(cookie)
                    added += 1
                    break
                except WebDriverException:
                    continue
    log(f"account: {added}/{len(cookies)} cookies loaded")
    return added


# ---------------------------------------------------------------------------
# 3. clipboard paste helper (Windows)
# ---------------------------------------------------------------------------
def clipboard_ctypes(text: str) -> bool:
    """Put text on the Windows clipboard with nothing but ctypes."""
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        kernel32.GlobalAlloc.restype = ctypes.c_void_p
        kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
        kernel32.GlobalLock.restype = ctypes.c_void_p
        kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
        kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]
        user32.SetClipboardData.restype = ctypes.c_void_p
        user32.SetClipboardData.argtypes = [wintypes.UINT, ctypes.c_void_p]

        data = text.encode("utf-16-le") + b"\x00\x00"
        if not user32.OpenClipboard(None):
            return False
        try:
            user32.EmptyClipboard()
            handle = kernel32.GlobalAlloc(0x0002, len(data))     # GMEM_MOVEABLE
            if not handle:
                return False
            pointer = kernel32.GlobalLock(handle)
            ctypes.memmove(pointer, data, len(data))
            kernel32.GlobalUnlock(handle)
            if not user32.SetClipboardData(13, handle):          # CF_UNICODETEXT
                return False
        finally:
            user32.CloseClipboard()
        return True
    except Exception as exc:                                     # pragma: no cover
        log(f"  ! clipboard via ctypes failed ({exc})")
        return False


def clipboard_powershell(text: str) -> bool:
    """Fallback: let PowerShell own the clipboard."""
    try:
        tmp = ROOT / "_prompt.tmp.txt"
        tmp.write_text(text, encoding="utf-8")
        import subprocess
        subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"Set-Clipboard -Value ([IO.File]::ReadAllText('{tmp}', [Text.Encoding]::UTF8))"],
            check=True, capture_output=True,
        )
        return True
    except Exception as exc:                                     # pragma: no cover
        log(f"  ! clipboard via PowerShell failed ({exc})")
        return False


def set_clipboard(text: str) -> bool:
    """Put text on the Windows clipboard so Ctrl+V can paste it into Gemini."""
    return clipboard_ctypes(text) or clipboard_powershell(text)


# ---------------------------------------------------------------------------
# 4. the browser
# ---------------------------------------------------------------------------
def make_driver(args):
    options = Options()
    options.add_argument(f"--user-data-dir={Path(args.profile).resolve()}")
    options.add_argument("--profile-directory=Default")
    options.add_argument("--window-size=1440,1000")
    options.add_argument("--lang=en-US")
    options.add_argument("--no-first-run")
    options.add_argument("--no-default-browser-check")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_experimental_option("excludeSwitches", ["enable-automation"])
    options.add_experimental_option("useAutomationExtension", False)
    if args.chrome:
        options.binary_location = args.chrome
    if args.headless:
        options.add_argument("--headless=new")

    log("launching Chrome ...")
    driver = webdriver.Chrome(options=options)
    driver.set_page_load_timeout(args.page_load_timeout)
    try:
        driver.execute_cdp_cmd(
            "Page.addScriptToEvaluateOnNewDocument",
            {"source": "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"},
        )
    except WebDriverException:
        pass
    return driver


# ---------------------------------------------------------------------------
# 5. talking to Gemini
# ---------------------------------------------------------------------------
BOX_SELECTORS = (
    'rich-textarea div.ql-editor[contenteditable="true"]',
    'rich-textarea [contenteditable="true"]',
    'div.ql-editor[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
)
SEND_SELECTORS = (
    'button[aria-label="Send message"]',
    'button[aria-label*="Send" i]',
    'button.send-button',
)
STOP_SELECTORS = (
    'button[aria-label="Stop response"]',
    'button[aria-label*="Stop" i]',
)
BLOCK_SELECTORS = (
    "model-response",
    "message-content",
    "div.model-response-text",
    "response-container",
    "div.markdown",
)
TEXT_SELECTORS = (
    "message-content",
    "div.markdown",
    "div.model-response-text",
    "div.response-content",
)
SIGNED_OUT_HINTS = ("Sign in", "Sign in to Gemini", "Sign in with Google")
# The header "New chat" control is an <a href="/app"> in the current Gemini UI
# (with a <mat-icon data-mat-icon-name="gemini_chat"> inside); older builds used
# a real <button>. Clicking it swaps the conversation in place - no reload.
NEW_CHAT_TARGETS = (
    (By.CSS_SELECTOR, 'a[href="/app"][aria-label="New chat"]'),
    (By.CSS_SELECTOR, 'a[aria-label="New chat"]'),
    (By.CSS_SELECTOR, 'button[aria-label="New chat"]'),
    (By.CSS_SELECTOR, '[aria-label="New chat"]'),
    (By.XPATH, '//a[contains(@href, "/app")][.//mat-icon[@data-mat-icon-name="gemini_chat"]]'),
)
# The "Redo" control under the answer we just got: <button aria-label="Redo"> with
# a <mat-icon fonticon="refresh" data-mat-icon-namespace="lumi-symbols"> inside.
# Every answer has one; the newest answer's toolbar is last in the DOM, so the
# last match is the button that redos that answer.
REDO_TARGETS = (
    (By.XPATH, '(//model-response//button[@aria-label="Redo"])[last()]'),
    (By.XPATH, '(//button[@aria-label="Redo"])[last()]'),
    (By.XPATH, '(//button[.//mat-icon[@fonticon="refresh"]])[last()]'),
    (By.XPATH, '(//button[.//mat-icon[@data-mat-icon-name="refresh"]])[last()]'),
    (By.CSS_SELECTOR, 'button[aria-label="Redo"]'),
)
# Redo opens a cdk overlay menu (gem-menu with gem-menu-item[data-test-id=
# "regenerate-option"] entries - Longer, Shorter, Don't personalise, ...) whose
# last entry is "Try again"; that entry makes Gemini write the answer again.
TRY_AGAIN_TARGETS = (
    (By.XPATH, '//gem-menu-item[@data-test-id="regenerate-option"]'
               '[.//span[normalize-space()="Try again"]]'),
    (By.XPATH, '//gem-menu-item[@role="menuitem"][.//span[normalize-space()="Try again"]]'),
    (By.XPATH, '//span[normalize-space()="Try again"]/ancestor::gem-menu-item[1]'),
    (By.XPATH, '//span[normalize-space()="Try again"]/ancestor::*[@role="menuitem"][1]'),
    (By.XPATH, '//div[contains(@class, "cdk-overlay-pane")]//span[normalize-space()="Try again"]'),
)


class Gemini:
    """Thin, defensive wrapper around the bits of the Gemini DOM we need."""

    def __init__(self, driver, args):
        self.driver = driver
        self.args = args

    # -- element hunting ---------------------------------------------------
    def find_all(self, selector: str) -> list:
        try:
            return [e for e in self.driver.find_elements(By.CSS_SELECTOR, selector) if e.is_displayed()]
        except (WebDriverException, StaleElementReferenceException):
            return []

    def find_first(self, selectors, timeout: float | None = None):
        timeout = self.args.element_timeout if timeout is None else timeout
        deadline = time.time() + timeout
        while True:
            for selector in selectors:
                found = self.find_all(selector)
                if found:
                    return found[0], selector
            if time.time() > deadline:
                return None, None
            time.sleep(0.4)

    def signed_out(self) -> bool:
        try:
            body = self.driver.find_element(By.TAG_NAME, "body").text
        except WebDriverException:
            return False
        return any(hint in body for hint in SIGNED_OUT_HINTS) and "Ask Gemini" not in body

    def wait_ready(self, box=None):
        if box is None:
            box, _ = self.find_first(BOX_SELECTORS, self.args.element_timeout)
        if box is None:
            if self.signed_out():
                raise RuntimeError("Gemini shows a sign-in page - the cookies in account.json are stale")
            raise RuntimeError("Gemini prompt box never appeared")
        return box

    def open(self):
        log(f"opening {GEMINI_URL}")
        self.driver.get(GEMINI_URL)
        return self.wait_ready()

    def new_chat(self) -> bool:
        """Start a clean conversation by clicking Gemini's own New chat control.

        That is the `<a href="/app" aria-label="New chat">` link in the header:
        the app swaps the conversation in place, so NOTHING is reloaded - no
        driver.get(), no tab closed and reopened. /app is opened exactly once per
        run, by open(); only --reload-new-chat falls back to a reload.
        """
        deadline = time.time() + self.args.element_timeout
        while time.time() < deadline:
            for how, what in NEW_CHAT_TARGETS:
                for control in self.driver.find_elements(how, what):
                    try:
                        if not control.is_displayed():
                            continue
                        control.click()
                        time.sleep(self.args.new_chat_wait)
                        return True
                    except WebDriverException:
                        try:                 # hidden until hover - click it in the DOM
                            self.driver.execute_script("arguments[0].click()", control)
                            time.sleep(self.args.new_chat_wait)
                            return True
                        except WebDriverException:
                            continue
            time.sleep(0.5)
        if self.args.reload_new_chat:
            log(f"  ! no New chat control - reloading {GEMINI_URL}")
            self.driver.get(GEMINI_URL)
            time.sleep(self.args.new_chat_wait)
            return False
        log("  ! no New chat control - carrying on in the same conversation")
        return False

    # -- prompt box --------------------------------------------------------
    def box_length(self, box) -> int:
        try:
            return len(box.text or "")
        except (StaleElementReferenceException, WebDriverException):
            return 0

    def paste(self, box, text: str) -> int:
        box.click()
        time.sleep(0.3)
        if set_clipboard(text):
            box.send_keys(Keys.CONTROL, "v")
        deadline = time.time() + self.args.element_timeout
        got = self.box_length(box)
        while got < len(text) * 0.95 and time.time() < deadline:
            time.sleep(0.5)
            got = self.box_length(box)
        if got == 0:                       # clipboard paste did nothing - type it
            log("  ! paste produced nothing, typing the prompt instead")
            box.send_keys(text)
            time.sleep(1.0)
            got = self.box_length(box)
        return got

    def send(self, box):
        deadline = time.time() + self.args.element_timeout
        while time.time() < deadline:
            button, _ = self.find_first(SEND_SELECTORS, 5)
            if button is not None:
                try:
                    if button.is_enabled() and button.get_attribute("aria-disabled") != "true":
                        button.click()
                        return True
                except (StaleElementReferenceException, WebDriverException):
                    pass
            time.sleep(0.5)
        raise RuntimeError("Gemini's send button never became clickable")

    # -- asking Gemini for the answer again --------------------------------
    def try_click(self, element, allow_hidden: bool = False) -> bool:
        """Click an element, in the DOM when a real click does not land.

        `allow_hidden` is for controls that only exist while the row is hovered:
        clicking those through the DOM still runs Angular's handler, so it is
        used as a fallback, never for the first choice.
        """
        try:
            if element.is_displayed():
                element.click()
                time.sleep(0.5)
                return True
            if not allow_hidden:
                return False
        except WebDriverException:
            return False
        try:                       # not on screen - click it in the DOM
            self.driver.execute_script("arguments[0].click()", element)
            time.sleep(0.5)
            return True
        except WebDriverException:
            return False

    def click_redo(self) -> bool:
        """Click the Redo (refresh) button under the answer we just got."""
        blocks = self.driver.find_elements(By.CSS_SELECTOR, BLOCK_SELECTORS[0])
        if blocks:
            try:                   # the row's controls show up on hover
                ActionChains(self.driver).move_to_element(blocks[-1]).perform()
                time.sleep(0.2)
            except (WebDriverException, AttributeError, TypeError):
                pass               # best effort: the DOM click below still works
        deadline = time.time() + self.args.element_timeout
        while time.time() < deadline:
            for how, what in REDO_TARGETS:
                found = self.driver.find_elements(how, what)
                for button in reversed(found):          # the newest answer is last
                    if self.try_click(button):
                        return True
                if found and self.try_click(found[-1], allow_hidden=True):
                    return True
            time.sleep(0.3)
        return False

    def click_try_again(self) -> bool:
        """Click "Try again" in the menu Redo just opened."""
        deadline = time.time() + self.args.redo_wait
        while time.time() < deadline:
            for how, what in TRY_AGAIN_TARGETS:
                found = self.driver.find_elements(how, what)
                for item in reversed(found):            # the newest menu is last
                    if self.try_click(item):
                        return True
                if found and self.try_click(found[-1], allow_hidden=True):
                    return True
            time.sleep(0.3)
        return False

    def redo(self, selector: str, previous: str) -> str:
        """Ask for this answer again: Redo -> "Try again" -> the new answer.

        Used when the reply arrived without its "Answer:" marker. Gemini writes
        the same prompt's answer once more - nothing is retyped, the prompt is
        not edited and the conversation is not restarted.
        """
        try:
            _, before = self.count_blocks()               # the answer we have now
        except (StaleElementReferenceException, WebDriverException):
            _, before = BLOCK_SELECTORS[0], 0
        if not self.click_redo():
            raise RuntimeError("Gemini's Redo button never appeared")
        if not self.click_try_again():
            raise RuntimeError('"Try again" never appeared in Gemini\'s Redo menu')
        log("    redo sent - waiting for the answer Gemini writes again")
        return self.wait_redo(selector, before, previous)

    # -- answer ------------------------------------------------------------
    def count_blocks(self):
        for selector in BLOCK_SELECTORS:
            found = self.find_all(selector)
            if selector == "message-content":
                found = [e for e in found if not self.inside_user_query(e)]
            if found:
                return selector, len(found)
        return BLOCK_SELECTORS[0], 0

    @staticmethod
    def inside_user_query(el) -> bool:
        """message-content shows up for our own prompt too - skip those blocks."""
        try:
            return bool(el.find_elements(By.XPATH, "ancestor-or-self::user-query"))
        except (StaleElementReferenceException, WebDriverException, NoSuchElementException):
            return False

    def block_text(self, el) -> str:
        for selector in TEXT_SELECTORS:
            try:
                inner = el.find_elements(By.CSS_SELECTOR, selector)
            except (StaleElementReferenceException, WebDriverException, NoSuchElementException):
                return ""
            for node in inner:
                try:
                    text = (node.text or "").strip()
                except StaleElementReferenceException:
                    return ""
                if text:
                    return text
        try:
            return (el.text or "").strip()
        except (StaleElementReferenceException, WebDriverException):
            return ""

    def streaming(self) -> bool:
        for selector in STOP_SELECTORS:
            if self.find_all(selector):
                return True
        return False

    def settle(self, block, deadline: float) -> str:
        """Let one answer finish streaming: same text N times, no Stop button.

        A finished-looking answer is not trusted straight away: it is re-read
        --stable-hold seconds later (4 by default) and only counts when that
        second read is identical. Gemini sometimes rewrites a reply shortly
        after it stopped streaming - a hiccup on their side - and that rewrite
        must not be written to disk as the final answer.
        """
        last, stable = "", 0
        while time.time() < deadline:
            text = self.block_text(block)
            if text and text == last:
                stable += 1
            else:
                stable = 0
                last = text
            if text and stable >= self.args.stable_checks and not self.streaming():
                time.sleep(self.args.stable_hold)            # it may still change
                if time.time() > deadline:
                    break
                settled = self.block_text(block)
                if settled and settled == text and not self.streaming():
                    return settled
                log("  ! the reply changed after it looked finished - waiting for it to settle")
                last, stable = settled, 0                    # keep watching it
                continue
            time.sleep(1.0)
        log("  ! answer timeout - keeping what arrived so far")
        return last

    def wait_answer(self, selector: str, before: int) -> str:
        """Wait for the new answer block, then let it finish streaming."""
        deadline = time.time() + self.args.answer_timeout
        block = None
        while time.time() < deadline:
            found = self.driver.find_elements(By.CSS_SELECTOR, selector)
            if len(found) > before:
                block = found[-1]
                break
            time.sleep(0.5)
        if block is None:
            raise TimeoutError("Gemini never started answering")
        return self.settle(block, deadline)

    def wait_redo(self, selector: str, before: int, previous: str) -> str:
        """Wait for the answer Gemini writes after Redo -> "Try again".

        A redo usually rewrites the reply in place - the block count stays the
        same and only its text changes - but it can also come back as one more
        block, and while it streams the bubble can be empty for a moment. All of
        those count, as does a rewrite that happens to land on the very same
        text (the Stop button tells us a redo did happen); a redo that never
        starts is cut short instead of waiting out the whole answer timeout.
        """
        clicked = time.time()
        deadline = clicked + self.args.answer_timeout
        streamed = False
        while time.time() < deadline:
            if self.streaming():
                streamed = True
                clicked = time.time()                       # it is writing again
            found = self.driver.find_elements(By.CSS_SELECTOR, selector)
            text = self.block_text(found[-1]) if found else ""
            if text and not self.streaming() and (streamed or len(found) > before
                                                  or text != previous):
                return self.settle(found[-1], deadline)
            if not streamed and time.time() - clicked > self.args.redo_wait:
                raise TimeoutError(f"nothing happened after the redo for "
                                   f"{self.args.redo_wait:.0f}s")
            time.sleep(0.5)
        raise TimeoutError("Gemini never finished the answer it started for the redo")


# ---------------------------------------------------------------------------
# 6. the answer -> a page file
# ---------------------------------------------------------------------------
ANSWER_RE = re.compile(r"answer\s*[:：]", re.I)
FENCE_RE = re.compile(r"^\s*```[a-zA-Z0-9_-]*\s*|\s*```\s*$")
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
TERMINAL = (".", "!", "?", '"', "”", "’", "…")


def has_answer_marker(raw: str) -> bool:
    """True when the reply really carries the 'Answer:' marker the prompt asks for."""
    return bool(ANSWER_RE.search(raw or ""))


def extract_answer(raw: str) -> str:
    """Keep only what came after the final 'Answer:'."""
    body = raw or ""
    hits = list(ANSWER_RE.finditer(body))
    if hits:
        body = body[hits[-1].end():]
    body = FENCE_RE.sub("", body.strip()).strip()
    body = body.strip("`").strip()
    if body.startswith("[") and body.endswith("]"):
        body = body[1:-1].strip()
    while body.startswith("[") and body.count("[") == 1:
        body = body[1:].strip()
    return body.strip()


def split_paragraphs(body: str) -> list[str]:
    """One paragraph per line, the way the sources/*/original.zh.txt files are written."""
    text = (body or "").replace("\r\n", "\n").replace("\r", "\n")
    if re.search(r"\n\s*\n", text):
        chunks = re.split(r"\n\s*\n", text)
    else:
        chunks = text.split("\n")
    paras: list[str] = []
    current = ""
    for chunk in chunks:
        line = " ".join(part.strip() for part in chunk.split("\n") if part.strip()).strip()
        if not line:
            if current:
                paras.append(current)
                current = ""
            continue
        if current and current.endswith(TERMINAL):
            paras.append(current)
            current = line
        elif current:
            current = f"{current} {line}"
        else:
            current = line
    if current:
        paras.append(current)
    return [re.sub(r"\s{2,}", " ", p) for p in paras if p]


def write_page(page: dict, body: str, raw: str, args) -> tuple[Path, int, int]:
    """Write Result/<name>/<name>.txt (CRLF, one trailing newline)."""
    paras = split_paragraphs(body)
    paras = apply_dividers(paras, page.get("breaks") or [], page["name"])
    text = "\r\n".join(paras) + "\r\n"

    out_dir = Path(args.out) / page["name"]
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{page['name']}.txt"
    out_file.write_text(text, encoding="utf-8", newline="")

    raw_dir = Path(args.out) / "_raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    (raw_dir / f"{page['name']}.raw.txt").write_text(raw or "", encoding="utf-8", newline="")

    if args.promote:
        target = page["dir"] / f"{page['name']}.txt"
        shutil.copyfile(out_file, target)
        try:
            shown = target.relative_to(NOVELITY)
        except ValueError:                      # --out/dir outside the repo
            shown = target
        log(f"  promoted -> {shown}")

    return out_file, len(paras), len(CJK_RE.findall(text))


# ---------------------------------------------------------------------------
# 7. command line + run loop
# ---------------------------------------------------------------------------
def build_prompt(page: dict) -> str:
    return PROMPT_TEMPLATE.format(chapter=page["chapter"] or "?", text=page.get("prompt_text") or page["zh"])


def divider_line(brk: dict, page_name: str) -> str:
    """The `== Chapter 86 · On the Road (Part 2) ==` line the pipeline expects."""
    chapter = brk.get("chapter") or {}
    heading = chapter.get("headingEn")
    if not heading:
        heading = f"Chapter {chapter.get('num')}"
        log(f"  ! {page_name}: {brk.get('key')} has no English title yet - "
            f"writing '== {heading} =='; add it to tools/chapter-titles.json")
    return f"== {heading} =="


def strip_heading_remnant(text: str, num) -> str:
    """Drop a 'Chapter 86: The Road Ahead (Part 2)' remnant the model kept."""
    if not num or not text:
        return text
    stripped = text.strip()
    match = CHAPTER_RE.match(stripped)
    if not match:
        return text
    rest = stripped[match.end():]
    part = PART_RE.match(rest)
    if part:
        rest = rest[part.end():]
    return rest.strip()


def chapter_start_index(paragraphs: list[str], num) -> int | None:
    for index, para in enumerate(paragraphs):
        match = CHAPTER_RE.match(para.strip())
        if match and (num is None or int(match.group(1)) == num):
            return index
    return None


def apply_dividers(paragraphs: list[str], breaks: list[dict], page_name: str) -> list[str]:
    """Sentinel line -> divider line, then tidy up any heading remnant."""
    if not breaks:
        return paragraphs
    by_num = {brk["chapter"].get("num"): brk for brk in breaks}
    out: list[str] = []
    used: set[str] = set()

    for para in paragraphs:
        while True:
            hit = SENTINEL_RE.search(para)
            if not hit:
                break
            before = para[:hit.start()].strip()
            after = para[hit.end():].strip()
            if before:
                out.append(before)
            num = int(hit.group(1)) if hit.group(1) else None
            brk = by_num.get(num) or next((b for b in breaks if b["key"] not in used), breaks[0])
            out.append(divider_line(brk, page_name))
            used.add(brk["key"])
            para = strip_heading_remnant(after, brk["chapter"].get("num"))
        if para.strip():
            out.append(para.strip())

    # a break the model swallowed: fall back to the "Chapter N" text it kept
    for brk in breaks:
        if brk["key"] in used or brk.get("at_start"):
            continue
        num = brk["chapter"].get("num")
        index = chapter_start_index(out, num)
        if index is None:
            log(f"  ! {page_name}: no {brk['key']} break came back from Gemini - the divider is missing, fix it by hand")
            continue
        out[index] = strip_heading_remnant(out[index], num)
        if not out[index].strip():
            del out[index]
            index = min(index, len(out))
        out.insert(index, divider_line(brk, page_name))
        used.add(brk["key"])

    # a chapter that starts the page must not keep its scraped heading either
    for brk in breaks:
        if not brk.get("at_start"):
            continue
        num = brk["chapter"].get("num")
        index = chapter_start_index(out, num)
        if index is not None:
            out[index] = strip_heading_remnant(out[index], num)

    return [para for para in out if para.strip()]


def debug_dump(driver, args, page: dict, exc: Exception) -> None:
    """Keep a screenshot + page source whenever a page goes wrong."""
    directory = Path(args.out) / "_debug"
    try:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{page['name']}.error.txt").write_text(f"{exc!r}\n", encoding="utf-8")
        try:
            driver.save_screenshot(str(directory / f"{page['name']}.png"))
        except Exception:
            pass
        try:
            (directory / f"{page['name']}.html").write_text(driver.page_source, encoding="utf-8")
        except Exception:
            pass
        log(f"  debug files -> {directory}")
    except Exception:
        pass


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Translate sources/chapter_XXXX/original.zh.txt through Gemini, one unit at a time.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--account", default=str(DEFAULT_ACCOUNT), help="cookie jar JSON (default: Doer/account.json)")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="result folder (default: Doer/Result)")
    parser.add_argument("--profile", default=str(DEFAULT_PROFILE), help="Chrome profile folder")
    parser.add_argument("--chrome", default=None, help="path to chrome.exe, if it is not found automatically")
    parser.add_argument("--pages", default=None, help="unit numbers, e.g. 258 or 258-260 or 258,260-262")
    parser.add_argument("--start", type=int, default=None, help="first unit number to consider")
    parser.add_argument("--end", type=int, default=None, help="last unit number to consider")
    parser.add_argument("--all", action="store_true", help="also redo units that already have a translation")
    parser.add_argument("--count-sources", action="store_true",
                        help=f"also count the translations that are already in sources/ as done; without it "
                             f"{DEFAULT_OUT.name}/ is the only progress marker, so a fresh run starts at the first unit")
    parser.add_argument("--result-only", action="store_true", help=argparse.SUPPRESS)  # the default now
    parser.add_argument("--limit", type=int, default=0, help="stop after this many units")
    parser.add_argument("--dry-run", action="store_true", help="print the first prompt and exit")
    parser.add_argument("--headless", action="store_true", help="run Chrome headless (Gemini may object)")
    parser.add_argument("--keep-open", action="store_true", help="leave the browser open when done")
    parser.add_argument("--fresh-profile", action="store_true", help="delete the Chrome profile folder first")
    parser.add_argument("--promote", action="store_true", help="also copy each result into sources/<name>/")
    parser.add_argument("--retries", type=int, default=1, help="extra tries per page (default: 1)")
    parser.add_argument("--redo-retries", "--edit-retries", dest="redo_retries",
                        type=int, default=3,
                        help="how often a reply without 'Answer:' is asked for again (Redo -> "
                             "'Try again') before a new chat is started (default: 3); "
                             "--edit-retries is accepted as the older name of this option")
    parser.add_argument("--redo-wait", type=float, default=30.0,
                        help="seconds to wait for the Redo menu to open, and for the answer it "
                             "starts to begin (default: 30)")
    parser.add_argument("--max-rounds", type=int, default=0,
                        help="give up on a unit after this many rounds of New chat + the same "
                             "prompt + the three redos; 0 keeps going until a reply has its "
                             "'Answer:' marker (default: 0)")
    parser.add_argument("--new-chat-wait", type=float, default=2.0,
                        help="seconds to let the New chat click settle (default: 2)")
    parser.add_argument("--reload-new-chat", action="store_true",
                        help="reload /app when the New chat control is missing instead of carrying on "
                             "in the same conversation (the page is never reloaded otherwise)")
    parser.add_argument("--delay", type=float, default=5.0, help="seconds to wait between pages")
    parser.add_argument("--answer-timeout", type=float, default=900.0, help="max seconds to wait per answer")
    parser.add_argument("--element-timeout", type=float, default=60.0, help="max seconds to wait for an element")
    parser.add_argument("--page-load-timeout", type=float, default=120.0, help="max seconds for a page load")
    parser.add_argument("--stable-checks", type=int, default=3, help="identical polls before an answer is done")
    parser.add_argument("--stable-hold", type=float, default=4.0,
                        help="seconds to re-read a finished answer before trusting it - a reply that "
                             "changed in that window is waited out (default: 4)")
    parser.add_argument("--stop-on-error", action="store_true", help="stop the batch on the first failed page")
    parser.add_argument("--keep-headings", action="store_true",
                        help="send the unit exactly as it is on disk, keeping the legacy 第N章 headings")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)

    out_dir = Path(args.out)
    every_page = load_pages(out_dir, count_sources=args.count_sources)
    # data/outline.json only describes the retired page scrape, so it is loaded
    # (and its char offsets used) only while page_XXXX folders are still around
    _, chapters = load_outline() if any(p["kind"] == "page" for p in every_page) else ({}, {})
    done = [p for p in every_page if p["translated"]]
    missing = [p for p in every_page if not p["translated"]]
    kinds = [
        f"{sum(1 for p in every_page if p['kind'] == kind)} {kind}_XXXX"
        for kind in ("chapter", "page")
        if any(p["kind"] == kind for p in every_page)
    ]
    log(f"sources: {len(every_page)} unit(s) with original.zh.txt "
        f"({', '.join(kinds) if kinds else 'none'})")
    in_result = sum(1 for p in every_page if p["in_result"])
    in_sources = sum(1 for p in every_page if p["in_sources"])
    if args.count_sources:
        log(f"already translated: {len(done)} unit(s) - {in_sources} in sources/, "
            f"{sum(1 for p in done if p['in_result'] and not p['in_sources'])} only in {out_dir.name}/")
    else:
        log(f"{out_dir.name}/ is the progress marker: {in_result} result(s) there, "
            f"{in_sources} translation(s) in sources/ (those get redone)")
    if missing:
        log(f"resume point: {missing[0]['name']} is the first unit that is not done yet "
            f"({len(missing)} unit(s) left)")
    else:
        log("every unit already has a translation - nothing left to do")

    todo = select_pages(every_page, args)
    if not todo:
        log("nothing to do with these options - use --all to redo units that are already done")
        return 0
    preview = ", ".join(p["name"] for p in todo[:10]) + (" ..." if len(todo) > 10 else "")
    log(f"queued {len(todo)} unit(s), in order: {preview}")

    if args.dry_run:
        page = todo[0]
        page["breaks"], page["prompt_text"] = mark_breaks(page, chapters, args.keep_headings)
        prompt = build_prompt(page)
        print("-" * 72)
        print(prompt)
        print("-" * 72)
        for brk in page["breaks"]:
            where = "starts this unit" if brk["at_start"] else "mid unit"
            line = f"chapter break: {brk['key']} at char {brk['offset']} ({where})"
            # an at_start break never becomes a divider: the reader draws it
            log(line if brk["at_start"] else f"{line} -> {divider_line(brk, page['name'])}")
            if brk["at_start"] and page.get("one_chapter"):
                chapter = brk["chapter"] or {}
                title_en = chapter.get("headingEn") or f"Chapter {chapter.get('num')}"
                log(f"  heading: {chapter.get('headingZh')} -> {title_en}")
        log(f"dry run only: the prompt for {page['name']} is {len(prompt)} characters")
        return 0

    cookies = load_account(Path(args.account))
    if args.fresh_profile:
        shutil.rmtree(args.profile, ignore_errors=True)

    driver = make_driver(args)
    failures: list[str] = []
    try:
        inject_cookies(driver, cookies)
        gem = Gemini(driver, args)
        gem.open()

        for index, page in enumerate(todo, 1):
            page["breaks"], page["prompt_text"] = mark_breaks(page, chapters, args.keep_headings)
            break_note = "".join(
                f"\n      {brk['key']} starts this unit" if brk["at_start"]
                else f"\n      {brk['key']} starts mid unit"
                for brk in page["breaks"]
            )
            log(f"[{index}/{len(todo)}] {page['name']} - chapter {page['chapter']} - "
                f"{len(page['zh'])} Chinese characters - {len(page['breaks'])} chapter break(s){break_note}")
            for attempt in range(1, args.retries + 2):
                try:
                    rounds = 0
                    while True:
                        rounds += 1
                        # a fresh conversation per round, swapped in place - the
                        # page is never reloaded, and the chat open() showed is
                        # already fresh, so the very first try does not need it
                        if index > 1 or attempt > 1 or rounds > 1:
                            gem.new_chat()
                        box = gem.wait_ready()
                        prompt = build_prompt(page)
                        pasted = gem.paste(box, prompt)
                        if pasted < len(prompt) * 0.9:
                            log(f"  ! prompt box holds {pasted}/{len(prompt)} characters, sending anyway")
                        selector, before = gem.count_blocks()
                        gem.send(box)
                        raw = gem.wait_answer(selector, before)
                        # a reply that lost its "Answer:" marker is asked for again
                        # by Redo -> "Try again" on that answer, three times
                        for retry in range(1, args.redo_retries + 1):
                            if has_answer_marker(raw):
                                break
                            log(f"  ! no 'Answer:' in the reply - clicking Redo and "
                                f"'Try again' (try {retry}/{args.redo_retries})")
                            raw = gem.redo(selector, raw)
                        if has_answer_marker(raw):
                            break
                        # the redos are spent: click New chat, paste the very same
                        # prompt again and try the three redos again, until a reply
                        # carries its marker (--max-rounds caps this, 0 = no cap)
                        if args.max_rounds and rounds >= args.max_rounds:
                            raise RuntimeError(f"the reply never contained 'Answer:' "
                                               f"after {rounds} round(s) of the same prompt")
                        log(f"  ! still no 'Answer:' after {args.redo_retries} redo(s) - "
                            f"New chat and the same prompt again (round {rounds + 1})")
                    body = extract_answer(raw)
                    if not body:
                        raise RuntimeError("Gemini answered with nothing usable")
                    out_file, paragraphs, cjk = write_page(page, body, raw, args)
                    log(f"  wrote {out_file} ({paragraphs} paragraphs, {cjk} Chinese characters left)")
                    if cjk:
                        log("  ! the answer still holds Chinese, give it a read")
                    break
                except KeyboardInterrupt:
                    raise
                except Exception as exc:
                    debug_dump(driver, args, page, exc)
                    if attempt > args.retries:
                        failures.append(page["name"])
                        log(f"  ! {page['name']} failed: {exc}")
                        if args.stop_on_error:
                            raise
                    else:
                        log(f"  ! {page['name']} attempt {attempt} failed ({exc}), trying again")
                        time.sleep(5)
            if index < len(todo):
                time.sleep(args.delay)
    finally:
        if args.keep_open:
            log("--keep-open: leaving Chrome running")
        else:
            driver.quit()

    if failures:
        log(f"pages that failed: {', '.join(failures)}")
        return 1
    log("all done")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        log("stopped by the user")
        sys.exit(130)
