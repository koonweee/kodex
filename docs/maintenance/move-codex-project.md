# Move a Codex Project Path

This playbook covers the local maintenance workflow for moving a Kodex project
folder after threads already exist. It updates both Kodex gateway state and
Codex app-server state.

Use this only for local development machines. It edits SQLite databases and
rollout JSONL files directly because Codex app-server does not currently expose
a supported thread cwd migration API.

## What Must Move

Kodex and Codex store the project path in several places:

- `~/.kodex/gateway.db`, table `projects`, column `cwd`
- `~/.codex/state_5.sqlite`, table `threads`, column `cwd`
- affected rollout JSONL files referenced by `threads.rollout_path`
- the project directory on disk, if the repo is physically moving

The rollout JSONL rewrite is intentionally targeted. It updates path metadata in
`session_meta` and `turn_context` payloads, including `cwd`, workspace roots,
writable roots, and nested path fields. It does not rewrite transcript text,
command strings, tool output, or other historical content.

## Before Applying

Close Kodex, Codex CLI sessions, and any gateway/app-server process that may be
using the project or writing `~/.codex/state_5.sqlite`. A live process can keep
stale in-memory state or append new rollout lines while the migration is
running.

Confirm the target parent exists and the target folder does not already exist:

```bash
mkdir -p ~/projects
test ! -e ~/projects/my-repo
```

Run a dry run first:

```bash
python3 tools/move-codex-project.py \
  --old ~/my-repo \
  --new ~/projects/my-repo \
  --move-folder
```

Review the counts:

- exactly one gateway project should usually match
- all expected app-server threads should match
- rollout files should be present
- JSON parse errors should be zero

By default the script refuses to apply when an affected rollout file is missing
or malformed. Override only when you have inspected the affected rows and accept
that those rollout files will not be rewritten.

## Apply

After the dry run looks right, apply the migration:

```bash
python3 tools/move-codex-project.py \
  --old ~/my-repo \
  --new ~/projects/my-repo \
  --move-folder \
  --apply
```

The script creates a timestamped backup directory under
`/private/tmp/kodex-thread-move-backups` before changing anything. The backup
contains the gateway DB, the Codex state DB, WAL/SHM files when present, and
copies of each touched rollout JSONL file.

If a previous copy failed and left a partial target directory, retry with:

```bash
python3 tools/move-codex-project.py \
  --old ~/my-repo \
  --new ~/projects/my-repo \
  --move-folder \
  --resume-existing-target \
  --apply
```

This resumes by replacing regular destination files and skipping special files
such as Git fsmonitor sockets. Skipped special files are reported at the end.

## Verify

Check the physical path:

```bash
ls -ld ~/my-repo ~/projects/my-repo 2>/dev/null
git -C ~/projects/my-repo status --short
```

Check the Kodex gateway project row:

```bash
sqlite3 ~/.kodex/gateway.db \
  "select id, name, cwd from projects where cwd like '%my-repo%' or name='my-repo'"
```

Check Codex app-server thread rows:

```bash
sqlite3 ~/.codex/state_5.sqlite \
  "select cwd, count(*) from threads where cwd in ('$HOME/my-repo','$HOME/projects/my-repo') group by cwd"
```

Then run a reverse dry run to confirm the new path is now the active source of
truth:

```bash
python3 tools/move-codex-project.py \
  --old ~/projects/my-repo \
  --new ~/my-repo
```

Restart Kodex or refresh the web client after applying so any cached project or
thread lists reload from the updated state.

## Recovery

If the script fails before `applied migration`, inspect the error and rerun a
dry run. The script opens SQLite write transactions before applying metadata
changes, so DB updates should roll back on pre-commit failures. It also restores
any rollout JSONL files it rewrote before the failure was raised.

If folder copy fails across filesystems, use `--resume-existing-target` for the
retry. Cross-filesystem moves are implemented as copy plus cleanup. Git
fsmonitor sockets and other special files cannot be copied and are skipped.

If cleanup of the old folder fails after metadata commits, the migration still
points Kodex and Codex at the new path. Inspect the leftover old directory and
remove stale cache files manually.

To restore from backup, stop Kodex/Codex first, then copy the saved DB and
rollout files from the timestamped backup directory back to their original
locations. If the folder was moved, move it back separately.
