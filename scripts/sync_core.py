#!/usr/bin/env python3
"""Copy the lorebook's core from Raven into grimoire, and grimoire's shared modules into the ports; or check the copies.

    python scripts/sync_core.py                    # from origin/main of ../raven, after a fetch
    python scripts/sync_core.py --ref <commit>     # from a given commit, tag or branch
    python scripts/sync_core.py --check            # compare against Raven at the recorded commit

The files are read out of Raven's git history, never its working tree, and the commit they came from is
recorded in `core/RAVEN_COMMIT`. grimoire's own modules shared between ports, in `lib/`, are copied from the
working tree. The TypeScript core's table of math symbols is regenerated from the synced Python core's. `--check`
exits 1 if any copy differs from its source, or the table from the Python one, which is how CI holds the copies
to being copies.
"""

import argparse
import importlib.util
import pathlib
import re
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
CORE = REPO / "core"
RECORD = CORE / "RAVEN_COMMIT"
LIB = REPO / "lib"
CLAUDE_CODE = REPO / "claude-code" / "scripts"
TS_CORE = REPO / "ts" / "core" / "src" / "lorebookcore.ts"

# Raven's path → the copies in grimoire. The runner imports the core as `from .. import lorebookcore`, so the
# layout under `core/` mirrors Raven's under `raven/librarian/`. A port that is installed by copying its own
# directory, as a Claude Code plugin is, carries a copy of the core inside it.
FILES = {
    "raven/librarian/lorebookcore.py": [CORE / "lorebookcore.py",
                                        CLAUDE_CODE / "lorebookcore.py"],
    "raven/librarian/tests/lorebook_conformance.json": [CORE / "tests" / "lorebook_conformance.json"],
    "raven/librarian/tests/test_lorebookcore.py": [CORE / "tests" / "test_lorebookcore.py"],
    "raven/librarian/prompts/lorebook_expansion.md": [CORE / "prompts" / "lorebook_expansion.md"],
}

# grimoire's own modules shared between ports → the copies inside the ports that need one.
LOCAL_FILES = {
    LIB / "ledger.py": [CLAUDE_CODE / "ledger.py"],
}


def git(raven: pathlib.Path, *args: str) -> bytes:
    """Run git in the Raven checkout and return its stdout; exit with git's message if it fails."""
    result = subprocess.run(["git", "-C", str(raven), *args], capture_output=True)
    if result.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed in {raven}:\n{result.stderr.decode(errors='replace').strip()}")
    return result.stdout


def resolve(raven: pathlib.Path, ref: str) -> str:
    """The full commit hash `ref` names in the Raven checkout."""
    return git(raven, "rev-parse", "--verify", f"{ref}^{{commit}}").decode().strip()


def read(raven: pathlib.Path, commit: str, path: str) -> bytes:
    """The bytes of `path` as committed in `commit`."""
    return git(raven, "show", f"{commit}:{path}")


_TS_TABLE = re.compile(r"export const MATH_SYMBOLS =\n.*?;\n", re.S)
_BACKSLASH = "\\"


def ts_math_symbols() -> str:
    """The TypeScript core's `MATH_SYMBOLS` declaration, made from the Python core's `_MATH_SYMBOLS`: the same code
    point ranges, as `\\u{...}` escapes for a `u`-flag class, in lines of a hundred columns or so."""
    spec = importlib.util.spec_from_file_location("synced_lorebookcore", CORE / "lorebookcore.py")
    core = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(core)
    chars, ranges, i = core._MATH_SYMBOLS, [], 0
    while i < len(chars):
        if i + 2 < len(chars) and chars[i + 1] == "-":
            ranges.append((ord(chars[i]), ord(chars[i + 2])))
            i += 3
        else:
            ranges.append((ord(chars[i]), ord(chars[i])))
            i += 1

    def escape(c: int) -> str:
        return f"{_BACKSLASH}u{{{c:x}}}"
    parts = [escape(a) if a == b else f"{escape(a)}-{escape(b)}" for a, b in ranges]
    lines, line = [], ""
    for part in parts:
        if len(line) + len(part) > 100:
            lines.append(line)
            line = ""
        line += part
    lines.append(line)
    return "export const MATH_SYMBOLS =\n" + " +\n".join(f"  String.raw`{line}`" for line in lines) + ";\n"

def _ts_with_table(text: str) -> str:
    new, count = _TS_TABLE.subn(lambda _: ts_math_symbols(), text)
    if count != 1:
        sys.exit(f"{TS_CORE.relative_to(REPO)}: no `export const MATH_SYMBOLS = ...;` to regenerate")
    return new


def sync(raven: pathlib.Path, *, ref: str, fetch: bool) -> None:
    if fetch:
        git(raven, "fetch", "--quiet", "origin")
    commit = resolve(raven, ref)
    for source, targets in FILES.items():
        _write(read(raven, commit, source), targets)
    RECORD.write_text(commit + "\n", encoding="utf-8")
    for source, targets in LOCAL_FILES.items():
        _write(source.read_bytes(), targets)
    before = TS_CORE.read_text(encoding="utf-8")
    after = _ts_with_table(before)
    TS_CORE.write_text(after, encoding="utf-8")
    print(f"{'unchanged' if after == before else 'updated':>9}  {TS_CORE.relative_to(REPO)} (its math symbol table)")
    print(f"Synced from Raven {commit} ({ref}), and from lib/.")

def _write(content: bytes, targets: list[pathlib.Path]) -> None:
    for target in targets:
        before = target.read_bytes() if target.exists() else None
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        status = "added" if before is None else ("unchanged" if before == content else "updated")
        print(f"{status:>9}  {target.relative_to(REPO)}")


def check(raven: pathlib.Path) -> bool:
    """Whether every copy matches its source: Raven at the recorded commit, or `lib/`. Reports each one."""
    commit = RECORD.read_text(encoding="utf-8").strip()
    ok = True
    for source, targets in FILES.items():
        ok &= _compare(read(raven, commit, source), targets, f"{source} at {commit}")
    for source, targets in LOCAL_FILES.items():
        ok &= _compare(source.read_bytes(), targets, str(source.relative_to(REPO)))
    current = TS_CORE.read_text(encoding="utf-8")
    if _ts_with_table(current) == current:
        print(f"       ok  {TS_CORE.relative_to(REPO)} (its math symbol table)")
    else:
        print(f"    stale  {TS_CORE.relative_to(REPO)}: its math symbol table differs from the Python core's")
        ok = False
    print(f"{'Matches' if ok else 'Does not match'} Raven {commit}, and lib/.")
    return ok

def _compare(content: bytes, targets: list[pathlib.Path], source: str) -> bool:
    ok = True
    for target in targets:
        if not target.exists():
            print(f"  missing  {target.relative_to(REPO)}")
            ok = False
        elif target.read_bytes() != content:
            print(f"   edited  {target.relative_to(REPO)}: differs from {source}")
            ok = False
        else:
            print(f"       ok  {target.relative_to(REPO)}")
    return ok


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--raven", type=pathlib.Path, default=REPO.parent / "raven",
                        help="a Raven checkout (default: %(default)s)")
    parser.add_argument("--ref", default="origin/main", help="what to sync from (default: %(default)s)")
    parser.add_argument("--no-fetch", dest="fetch", action="store_false", help="don't fetch Raven first")
    parser.add_argument("--check", action="store_true",
                        help="compare the copies against their sources, and change nothing")
    args = parser.parse_args()

    if args.check:
        sys.exit(0 if check(args.raven) else 1)
    sync(args.raven, ref=args.ref, fetch=args.fetch)


if __name__ == "__main__":
    main()
