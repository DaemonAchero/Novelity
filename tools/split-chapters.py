#!/usr/bin/env python3
"""tools/split-chapters.py
---------------------------------------------------------------------------
Splits the clean full-text edition of 十方武圣 into ONE FOLDER PER CHAPTER:

    sources/chapter_0001/original.zh.txt   <- raw Chinese, no translation

Input : D:/Novel/《十方武圣》（校对版全本）作者_滚开_txt -- ... -- Anna’s Archive.txt
        (GB18030, ~3.38 M chars, 884 `第N章 …` headings, CRLF)

Output: sources/chapter_NNNN/original.zh.txt   UTF-8, CRLF, one paragraph per line
        sources/_front_matter/original.zh.txt  title / author / 内容简介
        sources/index.json                     chapter index + stats (machine readable)

The source file was produced by a proof-reading group, not by a scraper, so
unlike the old page scrape (D:/Novel/十方武圣_pages.txt) it has no duplicated
pages, no missing pages and no torn chapters:

  * every paragraph is one line, indented with two ideographic spaces (\u3000\u3000)
    which are stripped here so a paragraph is one clean line (the shape
    Doer/doer.py and tools/build-data.mjs expect);
  * chapter headings sit between two blank lines - blank lines never occur
    inside a chapter, so a chapter body is simply "the lines up to the next
    heading";
  * download-site furniture (===== rules, "更多精校小说尽在知轩藏书下载…") is
    dropped and reported;
  * chapter numbers 766-785 do not exist in this edition: the file jumps from
    第765章 to 第786章 with exactly one chapter's worth of prose in between
    (see this script's report), i.e. the numbering skips, the story does not.
    Folder ids therefore keep the SOURCE numbers, so there are gaps
    (chapter_0765 then chapter_0786) exactly like the old page_NNNN layout.

Usage:
    py tools/split-chapters.py --report          # parse + stats only, write nothing
    py tools/split-chapters.py                   # wipe sources/page_* and write chapters
    py tools/split-chapters.py --keep-existing   # do not wipe anything first
---------------------------------------------------------------------------
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
NOVELITY = HERE.parent
SOURCES = NOVELITY / "sources"
RAW_DIR = NOVELITY.parent                       # D:/Novel
RAW_GLOB = "*Anna*Archive*.txt"
RAW_ENCODING = "gb18030"

HEADING_RE = re.compile(r"^\s*第([0-9]+)章[ \u3000]*(.*)$")
INDENT_CHARS = " \t\u3000\u300b\u2002\u2003"
# download-site furniture, never part of the novel
ARTIFACT_RE = re.compile(
    r"^(=+"
    r"|更多精校小说尽在知轩藏书下载[：:].*"
    r"|知轩藏书.*"
    r")$"
)
# 上/下/中 and 一/二/三 are part markers in this novel (安定 上 / 安定 下)
PART_CHARS = {"上", "下", "中", "一", "二", "三", "四"}
OLD_UNIT_RE = re.compile(r"^page_\d{4}$")

RULE = "-" * 75
warnings: list[str] = []


def find_raw() -> Path:
    """The one Anna's Archive .txt in D:/Novel (its name has odd quotes in it)."""
    hits = sorted(RAW_DIR.glob(RAW_GLOB))
    if not hits:
        sys.exit(f"! no file matching {RAW_GLOB} in {RAW_DIR}")
    if len(hits) > 1:
        sys.exit("! several candidates, pass the file explicitly:\n  " + "\n  ".join(str(h) for h in hits))
    return hits[0]


def clean_lines(lines: list[str], where: str) -> list[str]:
    """Paragraph-per-line, indents stripped, blank lines and site furniture dropped."""
    out: list[str] = []
    for line in lines:
        text = line.strip(INDENT_CHARS).rstrip()
        if not text:
            continue
        if ARTIFACT_RE.match(text.strip()):
            warnings.append(f"{where}: dropped download-site line: {text.strip()[:48]}")
            continue
        out.append(text)
    return out


def split_part(title: str) -> tuple[str, str]:
    """'安定 上' -> ('安定', '上'); '乱世' -> ('乱世', '')."""
    parts = title.split()
    if len(parts) > 1 and parts[-1] in PART_CHARS:
        return " ".join(parts[:-1]), parts[-1]
    return title, ""


def parse(raw: str) -> tuple[dict, list[dict], dict]:
    """Split the decoded file into front matter + chapter bodies."""
    lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    front: list[str] = []
    chapters: list[dict] = []
    heading_no = 0
    seen: set[int] = set()
    for line in lines:
        m = HEADING_RE.match(line)
        if m:
            heading_no += 1
            num = int(m.group(1))
            heading = line.strip(INDENT_CHARS).rstrip()
            title, part = split_part(m.group(2).strip())
            if chapters and num <= chapters[-1]["num"]:
                warnings.append(f"chapter {num}: heading out of order after {chapters[-1]['num']}")
            if num in seen:
                sys.exit(f"! chapter {num} appears twice - refusing to guess")
            seen.add(num)
            chapters.append({"num": num, "heading": heading, "title": title, "part": part, "lines": []})
            continue
        (chapters[-1]["lines"] if chapters else front).append(line)
    numbers = [c["num"] for c in chapters]
    missing = [n for n in range(numbers[0], numbers[-1] + 1) if n not in seen]
    stats = {
        "headingLines": heading_no,
        "first": numbers[0],
        "last": numbers[-1],
        "missingNumbers": missing,
        "inputLines": len(lines),
    }
    return {"lines": front}, chapters, stats


def write_unit(path: Path, header: list[str], body: list[str]) -> None:
    """Write one source unit: `#` comment header, then one paragraph per line (CRLF)."""
    text = "\r\n".join(header + body) + "\r\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="")


def verify(raw: str, chapters: list[dict]) -> bool:
    """Re-read every written file and prove no prose char was lost or duplicated.

    Source side: drop heading lines, blank lines and site furniture, strip the
    paragraph indents, then remove all whitespace.
    Written side: same treatment of every written original.zh.txt (minus the `#`
    header comments).  The two strings must be identical.
    """
    kept: list[str] = []
    for line in raw.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if HEADING_RE.match(line):
            continue
        text = line.strip(INDENT_CHARS).rstrip()
        if not text or ARTIFACT_RE.match(text.strip()):
            continue
        kept.append(text)
    expected = "".join("".join(kept).split())

    units = [SOURCES / "_front_matter"] + [SOURCES / f"chapter_{c['num']:04d}" for c in chapters]
    written: list[str] = []
    for d in units:
        for line in (d / "original.zh.txt").read_text(encoding="utf-8").replace("\r\n", "\n").split("\n"):
            t = line.rstrip()
            if t and not t.startswith("#"):
                written.append(t)
    actual = "".join("".join(written).split())

    ok = expected == actual
    print(f"verify        : {'PASS' if ok else 'FAIL'} - {len(actual):,} written prose chars "
          f"vs {len(expected):,} in the source ({len(units)} files)")
    if not ok:
        for i, (a, b) in enumerate(zip(expected, actual)):
            if a != b:
                print(f"  ! first difference at char {i}: source {a!r} vs written {b!r}")
                break
        else:
            print(f"  ! one side is a prefix of the other (source {len(expected):,} vs written {len(actual):,})")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description="split the clean 十方武圣 text into sources/chapter_NNNN/")
    ap.add_argument("--report", action="store_true", help="parse + print stats, write nothing")
    ap.add_argument("--keep-existing", action="store_true", help="do not wipe existing sources/ subfolders")
    args = ap.parse_args()

    raw_path = find_raw()
    raw = raw_path.read_bytes().decode(RAW_ENCODING)
    front, chapters, stats = parse(raw)

    front_body = clean_lines(front["lines"], "front matter")
    total_chars = 0
    total_paras = 0
    for ch in chapters:
        body = clean_lines(ch["lines"], f"chapter {ch['num']}")
        ch["body"] = body
        ch["chars"] = sum(len(p) for p in body)
        ch["paragraphs"] = len(body)
        total_chars += ch["chars"]
        total_paras += ch["paragraphs"]
        if not body:
            warnings.append(f"chapter {ch['num']} ({ch['heading']}) has an empty body")

    front_chars = sum(len(p) for p in front_body)
    empty = [c["num"] for c in chapters if not c["paragraphs"]]
    by_chars = sorted(chapters, key=lambda c: c["chars"])
    by_paras = sorted(chapters, key=lambda c: c["paragraphs"])

    def median(values: list[int]) -> int:
        return sorted(values)[len(values) // 2]

    gaps = stats["missingNumbers"]
    print(RULE)
    print(f"raw file      : {raw_path.name}")
    print(f"decoded       : {len(raw):,} chars from {raw_path.stat().st_size:,} bytes ({RAW_ENCODING})")
    print(f"lines         : {stats['inputLines']:,}")
    print(f"headings      : {stats['headingLines']} (第{stats['first']}章 … 第{stats['last']}章)")
    print(f"number gaps   : {len(gaps)}" + (f" -> 第{gaps[0]}章…第{gaps[-1]}章" if gaps else ""))
    print(f"chapters      : {len(chapters)} (folder ids keep the source numbers, so they have these gaps)")
    print(f"front matter  : {len(front_body)} line(s), {front_chars:,} chars")
    print(f"chapter text  : {total_chars:,} chars, {total_paras:,} paragraphs")
    print(f"char account  : {total_chars + front_chars:,} kept of {len(raw):,} decoded "
          f"({len(raw) - total_chars - front_chars:,} blank / heading / furniture chars)")
    print(f"paragraphs    : min {by_paras[0]['paragraphs']} (ch{by_paras[0]['num']}), "
          f"median {median([c['paragraphs'] for c in chapters])}, "
          f"max {by_paras[-1]['paragraphs']} (ch{by_paras[-1]['num']})")
    print(f"chapter chars : min {by_chars[0]['chars']:,} (ch{by_chars[0]['num']} {by_chars[0]['title']}), "
          f"median {median([c['chars'] for c in chapters]):,}, "
          f"max {by_chars[-1]['chars']:,} (ch{by_chars[-1]['num']} {by_chars[-1]['title']})")
    if empty:
        print(f"empty bodies  : {empty}")
    for w in warnings[:12]:
        print(f"  ! {w}")
    if len(warnings) > 12:
        print(f"  ! … {len(warnings) - 12} more (all of them land in sources/index.json)")
    print(RULE)

    if args.report:
        print("report only - nothing written")
        return 0


    # ---- clear the old layout ---------------------------------------------
    dirs = [d for d in SOURCES.iterdir() if d.is_dir()] if SOURCES.is_dir() else []
    old = [d for d in dirs if OLD_UNIT_RE.match(d.name)]
    new = [d for d in dirs if d.name.startswith("chapter_")]
    other = [d for d in dirs if d not in old and d not in new]
    if args.keep_existing:
        print(f"keeping existing folders ({len(old)} page_*, {len(new)} chapter_*, {len(other)} other)")
    else:
        for d in old + new + other:
            shutil.rmtree(d)
        print(f"removed {len(old)} page_* folder(s), {len(new)} chapter_* folder(s), {len(other)} other folder(s)")

    # ---- write the chapter units ------------------------------------------
    for ch in chapters:
        write_unit(
            SOURCES / f"chapter_{ch['num']:04d}" / "original.zh.txt",
            [
                f"# source chapter {ch['num']}",
                f"# raw file: {raw_path.name}",
                f"# heading: {ch['heading']}",
                f"# chapters on this page: ch{ch['num']}",
                f"# paragraphs: {ch['paragraphs']}",
            ],
            ch["body"],
        )
    write_unit(
        SOURCES / "_front_matter" / "original.zh.txt",
        [
            "# source: front matter (title / author / 内容简介) - the text before 第1章",
            f"# raw file: {raw_path.name}",
            f"# paragraphs: {len(front_body)}",
        ],
        front_body,
    )

    index = {
        "source": raw_path.name,
        "encoding": RAW_ENCODING,
        "decodedChars": len(raw),
        "unit": "chapter",
        "dirPattern": "sources/chapter_NNNN/original.zh.txt",
        "frontMatter": {"dir": "sources/_front_matter", "paragraphs": len(front_body), "chars": front_chars},
        "stats": {
            "chapters": len(chapters),
            "first": stats["first"],
            "last": stats["last"],
            "missingNumbers": gaps,
            "bodyChars": total_chars,
            "paragraphs": total_paras,
            "emptyBodies": empty,
        },
        "headers": {
            "commentLines": [
                "# source chapter N",
                "# raw file: …",
                "# heading: 第N章 …",
                "# chapters on this page: chN",
                "# paragraphs: N",
            ],
            "note": "body is one paragraph per line, source ideographic indents stripped, CRLF",
        },
        "chapters": [
            {
                "id": f"ch{c['num']}",
                "num": c["num"],
                "dir": f"chapter_{c['num']:04d}",
                "headingZh": c["heading"],
                "titleZh": c["title"],
                "partZh": c["part"],
                "paragraphs": c["paragraphs"],
                "chars": c["chars"],
            }
            for c in chapters
        ],
        "warnings": warnings,
    }
    (SOURCES / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline=""
    )
    print(f"wrote {len(chapters)} chapter folder(s) + _front_matter/ + index.json under {SOURCES}")
    return 0 if verify(raw, chapters) else 1


if __name__ == "__main__":
    raise SystemExit(main())

