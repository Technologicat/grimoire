#!/usr/bin/env python3
"""Copy the lorebook's core from Raven into grimoire, or check that the copy is unedited.

    python scripts/sync_core.py                    # from origin/main of ../raven, after a fetch
    python scripts/sync_core.py --ref <commit>     # from a given commit, tag or branch
    python scripts/sync_core.py --check            # compare against Raven at the recorded commit

The files are read out of Raven's git history, never its working tree, and the commit they came from is
recorded in `core/RAVEN_COMMIT`. `--check` exits 1 if any file differs from that commit, which is how CI
holds the copies to being copies.
"""

import argparse
import pathlib
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
CORE = REPO / "core"
RECORD = CORE / "RAVEN_COMMIT"

# Raven's path → grimoire's. The runner imports the core as `from .. import lorebookcore`, so the
# layout under `core/` mirrors Raven's under `raven/librarian/`.
FILES = {
    "raven/librarian/lorebookcore.py": CORE / "lorebookcore.py",
    "raven/librarian/tests/lorebook_conformance.json": CORE / "tests" / "lorebook_conformance.json",
    "raven/librarian/tests/test_lorebookcore.py": CORE / "tests" / "test_lorebookcore.py",
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


def sync(raven: pathlib.Path, *, ref: str, fetch: bool) -> None:
    if fetch:
        git(raven, "fetch", "--quiet", "origin")
    commit = resolve(raven, ref)
    for source, target in FILES.items():
        content = read(raven, commit, source)
        before = target.read_bytes() if target.exists() else None
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        status = "added" if before is None else ("unchanged" if before == content else "updated")
        print(f"{status:>9}  {target.relative_to(REPO)}")
    RECORD.write_text(commit + "\n", encoding="utf-8")
    print(f"Synced from Raven {commit} ({ref}).")


def check(raven: pathlib.Path) -> bool:
    """Whether every copied file matches Raven at the recorded commit. Reports each one."""
    commit = RECORD.read_text(encoding="utf-8").strip()
    ok = True
    for source, target in FILES.items():
        if not target.exists():
            print(f"  missing  {target.relative_to(REPO)}")
            ok = False
        elif target.read_bytes() != read(raven, commit, source):
            print(f"   edited  {target.relative_to(REPO)}: differs from {source} at {commit}")
            ok = False
        else:
            print(f"       ok  {target.relative_to(REPO)}")
    print(f"{'Matches' if ok else 'Does not match'} Raven {commit}.")
    return ok


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--raven", type=pathlib.Path, default=REPO.parent / "raven",
                        help="a Raven checkout (default: %(default)s)")
    parser.add_argument("--ref", default="origin/main", help="what to sync from (default: %(default)s)")
    parser.add_argument("--no-fetch", dest="fetch", action="store_false", help="don't fetch Raven first")
    parser.add_argument("--check", action="store_true",
                        help="compare the copies against Raven at the recorded commit, and change nothing")
    args = parser.parse_args()

    if args.check:
        sys.exit(0 if check(args.raven) else 1)
    sync(args.raven, ref=args.ref, fetch=args.fetch)


if __name__ == "__main__":
    main()
