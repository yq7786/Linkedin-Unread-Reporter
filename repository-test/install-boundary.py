#!/usr/bin/env python3
"""Exercise the installed Codex skill helper against this local committed repo."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile


SKILL_NAME = "linkedin-unread-reporter"


def load_installer():
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    script = (
        codex_home
        / "skills"
        / ".system"
        / "skill-installer"
        / "scripts"
        / "install-skill-from-github.py"
    )
    if not script.is_file():
        raise RuntimeError("Codex skill-installer helper is unavailable")
    sys.path.insert(0, str(script.parent))
    spec = importlib.util.spec_from_file_location("codex_skill_installer", script)
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load Codex skill-installer helper")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    if len(sys.argv) != 4 or sys.argv[1] not in {"download", "git"}:
        raise SystemExit(
            "usage: install-boundary.py {download|git} REPOSITORY_ROOT DESTINATION_ROOT"
        )
    method = sys.argv[1]
    repository_root = Path(sys.argv[2]).resolve()
    destination_root = Path(sys.argv[3]).resolve()
    installer = load_installer()

    with tempfile.TemporaryDirectory(prefix="linkedin-installer-source-") as temporary:
        if method == "git":
            checked_out = installer._git_sparse_checkout(
                repository_root.as_uri(),
                "main",
                [SKILL_NAME],
                temporary,
            )
        else:
            archive = Path(temporary) / "fixture.zip"
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(repository_root),
                    "archive",
                    "--format=zip",
                    "--prefix=repo-main/",
                    f"--output={archive}",
                    "HEAD",
                ],
                check=True,
            )
            payload = archive.read_bytes()
            installer._request = lambda _url: payload
            download_root = Path(temporary) / "download"
            download_root.mkdir()
            checked_out = installer._download_repo_zip(
                "local",
                "repository",
                "main",
                str(download_root),
            )
        source = Path(checked_out) / SKILL_NAME
        destination = destination_root / SKILL_NAME
        installer._validate_skill(str(source))
        installer._copy_skill(str(source), str(destination))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
