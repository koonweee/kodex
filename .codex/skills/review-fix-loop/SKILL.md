---
name: review-fix-loop
description: Orchestrate an independent review subagent and fixer subagent loop for repository work. Use when the user asks to review an implementation against a plan, spec, milestone list, AGENTS.md, or acceptance criteria; asks to delegate findings to a fixer; or asks to continue looping until no major issues remain.
---

# Review Fix Loop

## Overview

Run an explicit review/fix loop with separate subagents: one reviewer audits for major blockers, one fixer patches only those blockers, and the parent verifies, commits, and pushes once the reviewer reports no major issues remain.

## Workflow

1. Start from a clean baseline:
   - Check `git status --short --branch`.
   - Read the relevant plan, spec, or acceptance criteria.
   - If the user specified model or reasoning levels, use them. Otherwise prefer the current default model with high reasoning for review and normal/high reasoning for fixes.

2. Spawn the review subagent:
   - Use a read-only prompt.
   - Ask it to review implementation against the concrete spec.
   - Tell it to report only major issues: unmet exit conditions, behavior bugs, schema mismatches, production risks, missing durable docs/scripts, or tests that hide likely failures.
   - Require file/line references, expected behavior, whether a fixer should run, and a verification checklist.

3. If major issues are found, spawn the fixer subagent:
   - Use a worker prompt.
   - State that it is not alone in the codebase and must not revert unrelated edits.
   - Paste only the reviewer’s major findings and the relevant scope.
   - Tell it to edit files directly, run focused tests if possible, list changed files, and not commit or push.

4. Parent review after each fixer pass:
   - Inspect `git diff --stat` and the substantive diff.
   - Run the repo’s verification gate. For this repo’s Rust backend, use `CARGO_TARGET_DIR=/tmp/kodex-target cargo fmt --check`, `CARGO_TARGET_DIR=/tmp/kodex-target cargo clippy --all-targets -- -D warnings`, and `CARGO_TARGET_DIR=/tmp/kodex-target cargo test`.
   - Run any relevant smoke checks from the plan or scripts.

5. Repeat:
   - Spawn another review subagent against the current tree.
   - Continue review -> fix -> verify until the reviewer says no major issues remain.
   - Treat non-blocking residual risks as notes, not reasons to keep looping unless they contradict the spec.

6. Close the loop:
   - Commit the accepted fixes in a focused commit.
   - Push if the user asked for push/often or repo instructions require it.
   - Final response should include loop count, commit hash, verification commands, smoke results, and any residual non-blocking risks.

## Prompt Templates

Reviewer prompt shape:

```text
You are the REVIEW subagent for <repo>. Do not edit files. Review <implementation> against <spec>. Focus on major issues only: unmet exit conditions, behavior bugs, schema mismatches, production risks, missing durable docs/scripts, or tests that hide likely failures. Ignore minor style/nits. Output: major findings ordered by severity with file/line refs and expected behavior; whether a fixer should run; verification checklist. If no major issues remain, say exactly: "No major issues remain."
```

Fixer prompt shape:

```text
You are the FIXER subagent for <repo>. You are not alone in the codebase; do not revert or overwrite unrelated edits. Edit files directly to address these major review findings only: <findings>. Stay scoped. Run focused tests if possible and list changed files. Do not commit or push.
```
