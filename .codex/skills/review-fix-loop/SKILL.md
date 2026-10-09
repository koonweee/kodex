---
name: review-fix-loop
description: Run an independent review subagent loop with fixes applied by the main agent. Use when the user asks to review an implementation against a plan, spec, milestone list, AGENTS.md, or acceptance criteria, or to continue looping until no major issues remain.
---

# Review Fix Loop

## Overview

Run an explicit review/fix loop: a read-only review subagent audits for major blockers, and the main agent applies fixes and verifies them. Commit accepted fixes once the reviewer reports no major issues remain; push when authorized.

## Workflow

1. Start from a clean baseline:
   - Check `git status --short --branch`.
   - Read the relevant plan, spec, or acceptance criteria.
   - Use GPT-5.6 Sol with high reasoning for review subagents; fall back to GPT-6.1 Sol with high reasoning if GPT-5.6 Sol is unavailable. Follow any explicit user override.

2. Spawn the review subagent:
   - Use a read-only prompt.
   - Ask it to review implementation against the concrete spec.
   - Tell it to report only major issues: unmet exit conditions, behavior bugs, schema mismatches, production risks, missing durable docs/scripts, or tests that hide likely failures.
   - Require file/line references, expected behavior, whether fixes are required, and a verification checklist.

3. If major issues are found, the main agent applies fixes:
   - Address only the reviewer’s major findings within the relevant scope.
   - Preserve unrelated edits and run focused tests.

4. Verify each fix pass:
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
You are the REVIEW subagent for <repo>. Do not edit files. Review <implementation> against <spec>. Focus on major issues only: unmet exit conditions, behavior bugs, schema mismatches, production risks, missing durable docs/scripts, or tests that hide likely failures. Ignore minor style/nits. Output: major findings ordered by severity with file/line refs and expected behavior; whether fixes are required; verification checklist. If no major issues remain, say exactly: "No major issues remain."
```
