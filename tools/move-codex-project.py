#!/usr/bin/env python3
"""Move a local Kodex/Codex project path across gateway and app-server state.

This is intentionally a local maintenance tool. It updates:
- the Kodex gateway projects table
- Codex app-server thread cwd rows
- rollout JSONL path metadata for affected threads
- optionally the project folder on disk

Run without --apply first. Keep Kodex/Codex stopped while applying when possible.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import stat
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


DEFAULT_STATE_DB = Path("~/.codex/state_5.sqlite").expanduser()
DEFAULT_GATEWAY_DB = Path("~/.kodex/gateway.db").expanduser()
DEFAULT_BACKUP_ROOT = Path("/private/tmp/kodex-thread-move-backups")


@dataclass(frozen=True)
class RolloutReport:
    thread_id: str
    path: Path
    changed_lines: int
    parse_errors: list[tuple[int, str]]
    rewritten: str
    original: str


def resolve_existing_style(path: str) -> str:
    return str(Path(path).expanduser().resolve())


def resolve_target_style(path: str) -> str:
    expanded = Path(path).expanduser()
    if expanded.is_absolute():
        return str(expanded)
    return str(expanded.resolve())


def replace_path(value: Any, old: str, new: str) -> tuple[Any, bool]:
    if not isinstance(value, str):
        return value, False
    if value == old:
        return new, True
    if value.startswith(old + "/"):
        return new + value[len(old) :], True
    return value, False


def replace_targeted_payload(value: Any, old: str, new: str, parent_key: str | None = None) -> tuple[Any, bool]:
    changed = False

    if isinstance(value, dict):
        output = {}
        for key, item in value.items():
            if key in {"cwd", "path"}:
                next_item, item_changed = replace_path(item, old, new)
            else:
                next_item, item_changed = replace_targeted_payload(item, old, new, key)
            output[key] = next_item
            changed = changed or item_changed
        return output, changed

    if isinstance(value, list):
        output = []
        for item in value:
            if parent_key in {"workspace_roots", "writable_roots"}:
                next_item, item_changed = replace_path(item, old, new)
            else:
                next_item, item_changed = replace_targeted_payload(item, old, new, parent_key)
            output.append(next_item)
            changed = changed or item_changed
        return output, changed

    return value, False


def rewrite_rollout_lines(path: Path, old: str, new: str) -> RolloutReport:
    original = path.read_text(encoding="utf-8")
    had_trailing_newline = original.endswith("\n")
    output: list[str] = []
    changed_lines = 0
    parse_errors: list[tuple[int, str]] = []

    for line_number, line in enumerate(original.splitlines(), start=1):
        if not line.strip():
            output.append(line)
            continue

        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            parse_errors.append((line_number, str(exc)))
            output.append(line)
            continue

        changed = False
        if isinstance(obj, dict) and obj.get("type") in {"session_meta", "turn_context"}:
            payload = obj.get("payload")
            if isinstance(payload, dict):
                next_payload, changed = replace_targeted_payload(payload, old, new)
                if changed:
                    obj["payload"] = next_payload

        if changed:
            changed_lines += 1
            output.append(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))
        else:
            output.append(line)

    rewritten = "\n".join(output)
    if had_trailing_newline:
        rewritten += "\n"

    return RolloutReport(
        thread_id="",
        path=path,
        changed_lines=changed_lines,
        parse_errors=parse_errors,
        rewritten=rewritten,
        original=original,
    )


def query_all(db: Path, sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
    with sqlite3.connect(db) as conn:
        return conn.execute(sql, params).fetchall()


def copy_if_exists(src: Path, backup_dir: Path) -> Path | None:
    if not src.exists():
        return None
    dest = backup_dir / src.name
    shutil.copy2(src, dest)
    return dest


def backup_rollout(path: Path, backup_dir: Path) -> Path:
    digest = hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:12]
    dest = backup_dir / "rollouts" / digest / path.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)
    return dest


def remove_existing(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def recreate_symlink(src: Path, dest: Path) -> None:
    if dest.exists() or dest.is_symlink():
        remove_existing(dest)
    os.symlink(os.readlink(src), dest)


def copy_tree_skipping_special(src: Path, dest: Path) -> list[str]:
    skipped: list[str] = []
    dest.mkdir(parents=True, exist_ok=True)

    for root, dirs, files in os.walk(src, topdown=True, followlinks=False):
        root_path = Path(root)
        rel_root = root_path.relative_to(src)
        dest_root = dest / rel_root
        dest_root.mkdir(parents=True, exist_ok=True)

        for dirname in list(dirs):
            src_child = root_path / dirname
            dest_child = dest_root / dirname
            if src_child.is_symlink():
                recreate_symlink(src_child, dest_child)
                dirs.remove(dirname)
                continue
            dest_child.mkdir(exist_ok=True)

        for filename in files:
            src_file = root_path / filename
            dest_file = dest_root / filename
            mode = os.lstat(src_file).st_mode

            if src_file.is_symlink():
                recreate_symlink(src_file, dest_file)
            elif stat.S_ISREG(mode):
                if dest_file.exists() or dest_file.is_symlink():
                    remove_existing(dest_file)
                shutil.copy2(src_file, dest_file)
            else:
                skipped.append(str(src_file))

    return skipped


def cleanup_source(path: Path) -> str | None:
    try:
        shutil.rmtree(path)
        return None
    except OSError as exc:
        return str(exc)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Move Kodex gateway and Codex app-server project/thread path metadata."
    )
    parser.add_argument("--old", required=True, help="Current project path, for example ~/repo")
    parser.add_argument("--new", required=True, help="Target project path, for example ~/projects/repo")
    parser.add_argument("--state-db", default=str(DEFAULT_STATE_DB), help="Codex app-server state DB")
    parser.add_argument("--gateway-db", default=str(DEFAULT_GATEWAY_DB), help="Kodex gateway DB")
    parser.add_argument("--backup-root", default=str(DEFAULT_BACKUP_ROOT), help="Directory for DB and rollout backups")
    parser.add_argument("--apply", action="store_true", help="Apply changes. Omit for a dry run.")
    parser.add_argument(
        "--move-folder",
        action="store_true",
        help="Copy the project folder to --new and remove --old after metadata updates commit.",
    )
    parser.add_argument(
        "--resume-existing-target",
        action="store_true",
        help="Allow --new to exist when resuming a previously interrupted --move-folder copy.",
    )
    parser.add_argument(
        "--allow-parse-errors",
        action="store_true",
        help="Apply even if affected rollout JSONL files contain malformed lines.",
    )
    parser.add_argument(
        "--allow-missing-rollouts",
        action="store_true",
        help="Apply even if affected thread rows point at missing rollout JSONL files.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    old = resolve_existing_style(args.old)
    new = resolve_target_style(args.new)
    state_db = Path(args.state_db).expanduser()
    gateway_db = Path(args.gateway_db).expanduser()
    backup_root = Path(args.backup_root).expanduser()
    old_dir = Path(old)
    new_dir = Path(new)

    errors: list[str] = []
    if old == new:
        errors.append("--old and --new resolve to the same path")
    if not state_db.exists():
        errors.append(f"missing Codex state DB: {state_db}")
    if not gateway_db.exists():
        errors.append(f"missing Kodex gateway DB: {gateway_db}")
    if args.move_folder:
        if not old_dir.exists():
            errors.append(f"old folder does not exist: {old_dir}")
        if not new_dir.parent.exists():
            errors.append(f"target parent does not exist: {new_dir.parent}")
        if new_dir.exists() and not args.resume_existing_target:
            errors.append(f"target folder already exists: {new_dir}")

    gateway_projects = (
        query_all(
            gateway_db,
            "select id, name, cwd from projects where cwd = ? order by created_at desc",
            (old,),
        )
        if gateway_db.exists()
        else []
    )
    threads = (
        query_all(
            state_db,
            "select id, rollout_path, title from threads where cwd = ? order by updated_at desc",
            (old,),
        )
        if state_db.exists()
        else []
    )

    rollout_reports: list[RolloutReport] = []
    missing_rollouts: list[tuple[str, str]] = []
    for thread_id, rollout_path, _title in threads:
        path = Path(rollout_path)
        if not path.exists():
            missing_rollouts.append((thread_id, rollout_path))
            continue
        report = rewrite_rollout_lines(path, old, new)
        rollout_reports.append(
            RolloutReport(
                thread_id=thread_id,
                path=report.path,
                changed_lines=report.changed_lines,
                parse_errors=report.parse_errors,
                rewritten=report.rewritten,
                original=report.original,
            )
        )

    parse_error_count = sum(len(report.parse_errors) for report in rollout_reports)
    changed_rollouts = [report for report in rollout_reports if report.changed_lines > 0]

    print(f"old: {old}")
    print(f"new: {new}")
    print(f"gateway projects with exact cwd: {len(gateway_projects)}")
    for project_id, name, _cwd in gateway_projects:
        print(f"  project {project_id} name={name!r}")
    print(f"app-server threads with exact cwd: {len(threads)}")
    print(f"rollout files present: {len(rollout_reports)}")
    print(f"rollout files missing: {len(missing_rollouts)}")
    print(
        "rollout files with JSON parse errors: "
        f"{sum(1 for report in rollout_reports if report.parse_errors)}"
    )
    print(f"total JSON parse errors: {parse_error_count}")
    print(f"rollout lines that would change: {sum(report.changed_lines for report in rollout_reports)}")
    print(f"rollout files that would change: {len(changed_rollouts)}")
    for report in changed_rollouts[:20]:
        print(f"  {report.thread_id} changed_lines={report.changed_lines} file={report.path}")
    if len(changed_rollouts) > 20:
        print(f"  ... {len(changed_rollouts) - 20} more")

    if missing_rollouts:
        print("missing rollout examples:")
        for thread_id, rollout_path in missing_rollouts[:10]:
            print(f"  {thread_id} file={rollout_path}")

    if parse_error_count and not args.allow_parse_errors:
        errors.append("refusing to apply because affected rollout JSONL files contain parse errors")
    if missing_rollouts and not args.allow_missing_rollouts:
        errors.append("refusing to apply because affected thread rows point at missing rollout files")
    if not gateway_projects:
        errors.append("no Kodex gateway project row matched --old")
    if not threads:
        errors.append("no Codex app-server thread rows matched --old")

    if errors:
        print("preflight errors:")
        for error in errors:
            print(f"  {error}")
        return 2

    if not args.apply:
        print("dry run only; no files or databases changed")
        return 0

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_dir = backup_root / f"{old_dir.name}-{timestamp}"
    backup_dir.mkdir(parents=True, exist_ok=False)
    for db in (state_db, gateway_db):
        copy_if_exists(db, backup_dir)
        copy_if_exists(Path(str(db) + "-wal"), backup_dir)
        copy_if_exists(Path(str(db) + "-shm"), backup_dir)
    for report in changed_rollouts:
        backup_rollout(report.path, backup_dir)

    skipped_special: list[str] = []
    cleanup_error: str | None = None
    gateway_conn = sqlite3.connect(gateway_db)
    state_conn = sqlite3.connect(state_db)
    written_rollouts: list[RolloutReport] = []
    try:
        gateway_conn.execute("begin immediate")
        state_conn.execute("begin immediate")

        if args.move_folder:
            skipped_special = copy_tree_skipping_special(old_dir, new_dir)

        for report in changed_rollouts:
            report.path.write_text(report.rewritten, encoding="utf-8")
            written_rollouts.append(report)

        gateway_conn.execute("update projects set cwd = ? where cwd = ?", (new, old))
        state_conn.execute("update threads set cwd = ? where cwd = ?", (new, old))
        gateway_conn.commit()
        state_conn.commit()
    except Exception:
        for report in written_rollouts:
            report.path.write_text(report.original, encoding="utf-8")
        gateway_conn.rollback()
        state_conn.rollback()
        raise
    finally:
        gateway_conn.close()
        state_conn.close()

    if args.move_folder:
        cleanup_error = cleanup_source(old_dir)

    print("applied migration")
    print(f"backup dir: {backup_dir}")
    print(f"moved folder: {args.move_folder}")
    if args.move_folder:
        print(f"skipped special files during folder copy: {len(skipped_special)}")
        for path in skipped_special[:10]:
            print(f"  skipped {path}")
        if cleanup_error:
            print(f"warning: old folder cleanup failed: {cleanup_error}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
