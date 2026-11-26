"""The files generated from Python for the TypeScript tests are current."""

import pathlib
import subprocess
import sys

SCRIPTS = pathlib.Path(__file__).resolve().parent.parent / "scripts"


def test_the_difflib_cases_are_current():
    result = subprocess.run([sys.executable, str(SCRIPTS / "make_difflib_cases.py"), "--check"],
                            capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
