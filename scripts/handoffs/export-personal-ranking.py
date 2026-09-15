#!/usr/bin/env python3
"""Export the exact unpushed personal-ranking commit chain; no network or code execution.

The exporter never changes branches, files, commits, remotes or credentials. It
packages only an incremental Git bundle and a manifest in a new private folder.
Review ALL newly committed versions for sensitive content before confirming.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile

BASE = "5f175cb4b4ba7f8d603ee9a61b59c414ab983e0d"
COMMITS = (
    "4fda603bdcb0726d99b115e61796f85612d3c009",
    "14e43fa8a727758ec93046e3a2d41ed0e1ea5205",
    "bcef3abfb92aef95567e5949e70c8e7ba25ab6d4",
)
BRANCH = "development/personal-ranking"
MAX_BUNDLE_BYTES = 16 * 1024 * 1024


class ExportError(Exception):
    pass


def need(condition: bool, code: str) -> None:
    if not condition:
        raise ExportError(code)


def git(repo: Path, *arguments: str) -> bytes:
    env = dict(os.environ)
    # Object identity must not be altered by replace refs, optional index writes
    # are disabled, and a network prompt must never be attempted by this tool.
    env.update(GIT_NO_REPLACE_OBJECTS="1", GIT_OPTIONAL_LOCKS="0",
               GIT_TERMINAL_PROMPT="0", GIT_PAGER="cat")
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), *arguments], env=env, check=False,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise ExportError("git_unavailable_or_timeout") from None
    # Git errors can contain private paths/configuration. Never echo raw logs.
    need(result.returncode == 0, "git_command_failed")
    return result.stdout


def text(repo: Path, *arguments: str) -> str:
    return git(repo, *arguments).decode("utf-8", errors="strict").strip()


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def snapshot(repo: Path) -> tuple[str, str, bytes]:
    return (
        text(repo, "rev-parse", "--verify", "HEAD"),
        text(repo, "symbolic-ref", "--quiet", "--short", "HEAD"),
        git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all"),
    )


def inspect_chain(repo: Path) -> tuple[tuple[str, str, bytes], list[dict[str, object]]]:
    need(repo.is_dir(), "repository_missing")
    need(text(repo, "rev-parse", "--is-inside-work-tree") == "true", "worktree_required")
    root = Path(text(repo, "rev-parse", "--show-toplevel")).resolve()
    need(root == repo, "pass_repository_root")
    remote = text(repo, "remote", "get-url", "origin")
    need(remote in {
        "https://github.com/youq616/ultrabrain",
        "https://github.com/youq616/ultrabrain.git",
        "git@github.com:youq616/ultrabrain.git",
        "ssh://git@github.com/youq616/ultrabrain.git",
    }, "unexpected_origin")
    before = snapshot(repo)
    need(before[0] == COMMITS[-1], "unexpected_head")
    need(before[1] == BRANCH, "unexpected_branch")
    need(before[2] == b"", "worktree_not_clean_no_files_changed")
    need(text(repo, "rev-parse", "--verify", "refs/heads/" + BRANCH) == COMMITS[-1],
         "branch_head_mismatch")
    need(text(repo, "rev-parse", "--is-shallow-repository") == "false", "complete_clone_required")
    git_dir = Path(text(repo, "rev-parse", "--absolute-git-dir"))
    need(not (git_dir / "info" / "grafts").exists(), "legacy_grafts_refused")
    git(repo, "merge-base", "--is-ancestor", BASE, COMMITS[-1])
    chain = text(repo, "rev-list", "--reverse", BASE + ".." + COMMITS[-1]).splitlines()
    need(chain == list(COMMITS), "unexpected_commit_range")
    records: list[dict[str, object]] = []
    parent = BASE
    for sha in COMMITS:
        need(text(repo, "show", "-s", "--format=%P", sha) == parent, "unexpected_parent_chain")
        tree = text(repo, "show", "-s", "--format=%T", sha)
        need(re.fullmatch(r"[a-f0-9]{40}", tree) is not None, "unexpected_tree_id")
        # Filenames use NUL separation so a strange committed filename cannot
        # silently be interpreted as multiple records.
        raw_names = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", sha)
        names = [part.decode("utf-8", errors="strict") for part in raw_names.split(b"\0") if part]
        if sha == COMMITS[-1]:
            need(bool(names) and all(n.startswith("docs/") and Path(n).suffix in {".md", ".json", ".txt"}
                                    for n in names), "final_commit_not_documentation_only")
        records.append({"sha": sha, "parent": parent, "tree": tree, "changed_files": names})
        parent = sha
    return before, records


def export(repo: Path, output_parent: Path, reviewed_content: bool) -> dict[str, object]:
    need(reviewed_content is True, "review_committed_content_first")
    repo = repo.resolve(strict=True)
    parent = output_parent.resolve(strict=True)
    need(parent.is_dir(), "output_parent_missing")
    # Do not put pending code/evidence in the Agent's own worktree.
    need(parent != repo and repo not in parent.parents, "output_must_be_outside_worktree")
    before, records = inspect_chain(repo)
    # No existing output is reused or overwritten; mkdtemp creates mode 0700 on
    # POSIX. On Windows the operator must select an appropriate user-private ACL.
    folder = Path(tempfile.mkdtemp(prefix="personal-ranking-", dir=parent))
    incomplete = folder / "INCOMPLETE"
    incomplete.write_text("Do not upload: export has not completed.\n", encoding="utf-8")
    bundle = folder / "personal-ranking.bundle"
    git(repo, "bundle", "create", str(bundle), "refs/heads/" + BRANCH, "^" + BASE)
    need(bundle.stat().st_size <= MAX_BUNDLE_BYTES, "bundle_unexpectedly_large_review_before_sharing")
    git(repo, "bundle", "verify", str(bundle))
    heads = text(repo, "bundle", "list-heads", str(bundle)).splitlines()
    need(heads == [COMMITS[-1] + " refs/heads/" + BRANCH], "unexpected_bundle_refs")
    # A bundle header ends at its blank line; never decode or print the pack body.
    with bundle.open("rb") as stream:
        header = []
        for _ in range(32):
            line = stream.readline(8192)
            need(len(line) < 8192, "invalid_bundle_header")
            if line in (b"\n", b"\r\n"):
                break
            need(bool(line), "invalid_bundle_header")
            header.append(line.decode("utf-8", errors="replace").rstrip("\r\n"))
        else:
            raise ExportError("invalid_bundle_header")
    need(header[0] in ("# v2 git bundle", "# v3 git bundle"), "invalid_bundle_version")
    prerequisites = [line[1:].split(" ", 1)[0] for line in header if line.startswith("-")]
    need(prerequisites == [BASE], "unexpected_bundle_prerequisites")
    need(snapshot(repo) == before, "repository_changed_during_export")
    manifest = {
        "format": 1,
        "repository": "youq616/ultrabrain",
        "branch": BRANCH,
        "base_commit": BASE,
        "head_commit": COMMITS[-1],
        "reviewed_implementation_commit": COMMITS[-2],
        "head_tree": records[-1]["tree"],
        "commits": records,
        "bundle_filename": bundle.name,
        "bundle_sha256": digest(bundle),
        "bundle_bytes": bundle.stat().st_size,
        "bundle_verify": "passed_in_source_repository",
        "prerequisites": prerequisites,
        "security_review": "Operator confirmed review of every new committed version; exporter is not a secret detector.",
        "acceptance": "Transport artifact only. Linux CI and remote final review have not been asserted.",
    }
    manifest_file = folder / "handoff-manifest.json"
    with manifest_file.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(manifest, stream, ensure_ascii=True, indent=2)
        stream.write("\n")
    archive = folder / "ultrabrain-personal-ranking-handoff.zip"
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as zipped:
        zipped.write(bundle, bundle.name)
        zipped.write(manifest_file, manifest_file.name)
    with zipfile.ZipFile(archive) as zipped:
        need(zipped.namelist() == [bundle.name, manifest_file.name] and zipped.testzip() is None,
             "zip_verification_failed")
        need(hashlib.sha256(zipped.read(bundle.name)).hexdigest() == manifest["bundle_sha256"],
             "zip_bundle_hash_mismatch")
    need(snapshot(repo) == before, "repository_changed_during_export")
    incomplete.unlink()
    return {"ok": True, "zip_path": str(archive), "zip_sha256": digest(archive),
            "bundle_sha256": manifest["bundle_sha256"], "head_commit": COMMITS[-1],
            "head_tree": records[-1]["tree"], "bundle_verify": "passed",
            "required_user_action": "Attach the ZIP file to this conversation. A path or summary does not transmit its bytes."}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--output-parent", required=True,
                        help="Existing private directory outside the repository")
    parser.add_argument("--confirm-reviewed-content", action="store_true")
    args = parser.parse_args()
    try:
        result = export(Path(args.repo), Path(args.output_parent), args.confirm_reviewed_content)
    except Exception as error:
        result = {"ok": False, "error": str(error) if isinstance(error, ExportError) else "export_failed",
                  "note": "Do not upload incomplete output. No branch, commit, credentials or source files were changed by this exporter."}
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 1
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
