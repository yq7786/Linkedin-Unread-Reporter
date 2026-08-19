#!/usr/bin/env python3
"""Exercise the installed Codex skill helper against this local committed repo."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


SKILL_NAME = "linkedin-unread-reporter"


def build_current_worktree_repository(repository_root: Path, destination: Path) -> Path:
    source_repository = destination / "repository"
    source_repository.mkdir()
    result = subprocess.run(
        [
            "git",
            "-C",
            str(repository_root),
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            SKILL_NAME,
        ],
        check=True,
        capture_output=True,
    )
    for encoded_path in result.stdout.split(b"\0"):
        if not encoded_path:
            continue
        relative_path = Path(encoded_path.decode("utf-8"))
        source = repository_root / relative_path
        if not source.is_file():
            continue
        destination_file = source_repository / relative_path
        destination_file.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination_file)

    subprocess.run(
        ["git", "init", "--initial-branch=main", str(source_repository)],
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "-C", str(source_repository), "add", "--", SKILL_NAME],
        check=True,
    )
    subprocess.run(
        [
            "git",
            "-C",
            str(source_repository),
            "-c",
            "user.name=Installer Boundary",
            "-c",
            "user.email=installer-boundary@example.invalid",
            "commit",
            "-m",
            "test fixture",
        ],
        check=True,
        capture_output=True,
    )
    return source_repository


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
        temporary_root = Path(temporary)
        source_repository = build_current_worktree_repository(
            repository_root,
            temporary_root,
        )
        if method == "git":
            checked_out = installer._git_sparse_checkout(
                source_repository.as_uri(),
                "main",
                [SKILL_NAME],
                str(temporary_root / "checkout"),
            )
        else:
            archive = temporary_root / "fixture.zip"
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(source_repository),
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
            download_root = temporary_root / "download"
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
