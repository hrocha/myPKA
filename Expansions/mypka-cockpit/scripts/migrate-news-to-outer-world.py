#!/usr/bin/env python3
"""migrate-news-to-outer-world.py — carry a scaffold's legacy News notes into the
Outer World concept, NON-DESTRUCTIVELY.

WHAT THIS IS
  The Outer World module generalizes the old scaffold "News" entity: news is no
  longer a top-level entity, it is one value of `source_type`. This script migrates
  any existing `PKM/News/**` note carrying `doc_type: news` into the new home —
  `PKM/Outer World/YYYY/MM/<slug>.md` with `doc_type: outer-world` and
  `source_type: news` — preserving every byte of body, every wikilink, and every
  frontmatter field. Legacy field names are mapped onto the new schema (below); any
  field that has no mapping is KEPT VERBATIM (never dropped).

  This is the migration the EXPANSION INSTALL FLOW runs on a user's folder when it
  detects a PKM/News/ folder. It is shipped here so that step is auditable. It is
  also a worked example a downstream LLM can adapt for a non-myPKA source.

NON-DESTRUCTIVE BY DEFAULT (the hard rule)
  * DRY-RUN is the default. With no flag it prints the plan and writes NOTHING.
  * --apply COPIES each note to the new location. It does NOT delete the original
    by default — the legacy PKM/News/ note survives so the move is reversible. The
    new PKM/Outer World/ note is the canonical one going forward; once the user has
    verified the result + regenerated, they can delete PKM/News/ themselves (or pass
    --archive-originals to move the originals aside into PKM/News/_migrated/).
  * It NEVER overwrites an existing PKM/Outer World/ note. A slug collision is
    reported and SKIPPED (rename-never-overwrite — WS-002 default conflict policy).
  * Date-nesting is preserved/derived: the YYYY/MM comes from `captured_on` (or the
    legacy `captured_date` / `published_date`), else the YYYY-MM-DD filename prefix,
    else today. The folders are created if missing.

FIELD MAPPING (legacy News → Outer World schema; see DATA-CONTRACT §14)
    doc_type: news            -> doc_type: outer-world
    (no source_type)          -> source_type: news        (only if absent)
    captured_date             -> captured_on              (kept if captured_on exists)
    author                    -> source_author
    channel                   -> embed_site_name          (publication / channel)
    published_date            -> source_published
    related_topics            -> linked_topics
    related_key_elements      -> linked_key_elements
    related_projects          -> linked_projects
    related_people            -> linked_people
    related_organizations     -> linked_organizations
    key_element (singular)    -> merged INTO linked_key_elements (de-duplicated)
    og_title/description/image/site_name/favicon  -> embed_title/embed_description/
                              embed_image/embed_site_name/embed_favicon  (if a legacy
                              nested or flat OG block existed)
    embed_fetched_at          -> embed_captured_at
  Everything else (tom_context, tags, source_url, urgency, title, status, …) is
  carried through UNCHANGED. Unmapped legacy keys are preserved verbatim so no data
  is ever lost; the regen simply ignores columns it doesn't read.

REQUIREMENTS
  Python 3.9+ and PyYAML (pip3 install --user pyyaml).

USAGE
  python3 migrate-news-to-outer-world.py /path/to/scaffold              # dry-run (default)
  python3 migrate-news-to-outer-world.py /path/to/scaffold --apply      # copy notes
  python3 migrate-news-to-outer-world.py /path/to/scaffold --apply --archive-originals
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import date, datetime
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required.  pip3 install --user pyyaml  then re-run.")

FM_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
DATE_PREFIX_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")
SKIP_NAMES = {"index.md", "readme.md"}

# Simple scalar renames (old key -> new key). Applied only when the new key is absent.
SCALAR_RENAMES = {
    "captured_date": "captured_on",
    "author": "source_author",
    "channel": "embed_site_name",
    "published_date": "source_published",
    "embed_fetched_at": "embed_captured_at",
}
# List renames (old key -> new key). Values carried verbatim.
LIST_RENAMES = {
    "related_topics": "linked_topics",
    "related_key_elements": "linked_key_elements",
    "related_projects": "linked_projects",
    "related_people": "linked_people",
    "related_organizations": "linked_organizations",
}
# Legacy OG fields (flat or nested under `embed:`) -> the flat embed_* schema.
OG_RENAMES = {
    "og_title": "embed_title",
    "og_description": "embed_description",
    "og_image": "embed_image",
    "site_name": "embed_site_name",
    "favicon": "embed_favicon",
}


def read_note(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    m = FM_RE.match(text)
    if not m:
        return {}, text, False
    body = text[m.end():]
    try:
        fm = yaml.safe_load(m.group(1)) or {}
    except yaml.YAMLError:
        return {}, text, False
    return (fm if isinstance(fm, dict) else {}), body, True


def jsonable(v):
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, list):
        return [jsonable(x) for x in v]
    if isinstance(v, dict):
        return {k: jsonable(x) for k, x in v.items()}
    return v


def date_for_nesting(fm: dict, stem: str) -> str:
    for k in ("captured_on", "captured_date", "published_date"):
        v = fm.get(k)
        if isinstance(v, (date, datetime)):
            return v.isoformat()[:10]
        if isinstance(v, str) and DATE_PREFIX_RE.match(v.strip()):
            return v.strip()[:10]
    m = DATE_PREFIX_RE.match(stem)
    return m.group(1) if m else date.today().isoformat()


def transform(fm: dict) -> dict:
    """Return the migrated frontmatter dict. Pure (no I/O). Loss-free: any key
    without a mapping is carried through unchanged."""
    out = dict(fm)  # start from a verbatim copy — nothing is dropped

    # 1) doc_type + source_type
    out["doc_type"] = "outer-world"
    if not out.get("source_type"):
        out["source_type"] = "news"

    # 2) lift a legacy nested `embed:` block to flat embed_*/og_* before mapping.
    nested = out.pop("embed", None)
    if isinstance(nested, dict):
        for k, v in nested.items():
            # nested keys may already be og_* or the flat embed_* names
            out.setdefault(k, v)

    # 3) OG -> flat embed_* (only when the target is absent).
    for old, new in OG_RENAMES.items():
        if old in out and new not in out:
            out[new] = out.pop(old)
        elif old in out:
            out.pop(old)  # target already set; drop the legacy duplicate key

    # 4) scalar renames (only when target absent).
    for old, new in SCALAR_RENAMES.items():
        if old in out and new not in out:
            out[new] = out.pop(old)
        elif old in out:
            out.pop(old)

    # 5) list renames (related_* -> linked_*), merging if the target already exists.
    for old, new in LIST_RENAMES.items():
        if old not in out:
            continue
        old_vals = out.pop(old) or []
        if not isinstance(old_vals, list):
            old_vals = [old_vals]
        existing = out.get(new) or []
        if not isinstance(existing, list):
            existing = [existing]
        merged = list(dict.fromkeys([*existing, *old_vals]))  # order-preserving dedupe
        if merged:
            out[new] = merged

    # 6) singular key_element -> merge INTO linked_key_elements, then drop singular.
    ke = out.pop("key_element", None)
    if ke:
        lst = out.get("linked_key_elements") or []
        if not isinstance(lst, list):
            lst = [lst]
        if ke not in lst:
            lst = [*lst, ke]
        out["linked_key_elements"] = lst

    return jsonable(out)


def dump_note(fm: dict, body: str) -> str:
    y = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True, default_flow_style=False)
    return f"---\n{y}---\n{body.lstrip(chr(10))}"


def main():
    ap = argparse.ArgumentParser(
        description="Non-destructively migrate PKM/News/ (doc_type: news) into "
                    "PKM/Outer World/ (doc_type: outer-world, source_type: news).")
    ap.add_argument("root", help="path to the myPKA scaffold root (contains PKM/)")
    ap.add_argument("--apply", action="store_true",
                    help="write the migrated notes (default: dry-run, write nothing)")
    ap.add_argument("--archive-originals", action="store_true",
                    help="after copying, move each original into PKM/News/_migrated/ "
                         "(default: leave the original in place)")
    args = ap.parse_args()

    root = Path(args.root).expanduser().resolve()
    news_dir = root / "PKM" / "News"
    if not (root / "PKM").is_dir():
        sys.exit(f"Not a myPKA root (no PKM/): {root}")
    if not news_dir.is_dir():
        print(f"\n  No PKM/News/ folder at {root} — nothing to migrate.\n")
        return

    out_root = root / "PKM" / "Outer World"
    sources = sorted(
        p for p in news_dir.glob("**/*.md")
        if p.name.lower() not in SKIP_NAMES and "_migrated" not in p.parts)

    print(f"\n  News → Outer World migration")
    print(f"  Root:  {root}")
    print(f"  Mode:  {'APPLY (writing)' if args.apply else 'DRY-RUN (no writes)'}\n")

    migrated = skipped = collisions = bad_yaml = 0
    for src in sources:
        fm, body, ok = read_note(src)
        if not ok:
            print(f"  ! skipped (no/invalid frontmatter): {src.relative_to(root)}")
            bad_yaml += 1
            continue
        if (str(fm.get("doc_type") or "")).lower() != "news":
            print(f"  · skipped (not doc_type: news): {src.relative_to(root)}")
            skipped += 1
            continue

        nest = date_for_nesting(fm, src.stem)
        yyyy, mm = nest[:4], nest[5:7]
        dest = out_root / yyyy / mm / src.name
        rel_dest = dest.relative_to(root)

        if dest.exists():
            print(f"  ⚠ COLLISION (exists, skipped — never overwrite): {rel_dest}")
            collisions += 1
            continue

        new_fm = transform(fm)
        print(f"  → {src.relative_to(root)}  ->  {rel_dest}")
        if args.apply:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(dump_note(new_fm, body), encoding="utf-8")
            if args.archive_originals:
                archive = news_dir / "_migrated" / src.relative_to(news_dir)
                archive.parent.mkdir(parents=True, exist_ok=True)
                src.rename(archive)
        migrated += 1

    print(f"\n  {migrated} note(s) {'migrated' if args.apply else 'would migrate'}; "
          f"{skipped} not-news skipped; {collisions} collision(s) skipped; "
          f"{bad_yaml} unparseable.")
    if args.apply:
        print("  Originals left in PKM/News/" + (" (archived to _migrated/)" if args.archive_originals else " (untouched)") + ".")
        print("  NEXT: run scripts/regen-mypka-db.py, then detect-gaps.py to confirm "
              "Outer World [ OK ]. Delete PKM/News/ yourself once you've verified.")
    else:
        print("  Re-run with --apply to write. Nothing was changed.")
    print()


if __name__ == "__main__":
    main()
