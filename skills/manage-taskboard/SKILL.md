---
name: manage-taskboard
description: Manage taskboard projects, issues, issue relations, and comments through the taskctl CLI. Use when Codex needs to track a new requirement, inspect project work, create or update issues, relate dependent work, add progress notes, begin work on an issue, record completion, or coordinate concurrent updates.
---

# Manage Taskboard

Use `taskctl` for all taskboard operations and consume its JSON output. Read [references/cli.md](references/cli.md) only when command syntax is needed.

## Execute An Issue

1. Run `issue get <id>` and `comment list <id>`. Download and inspect every file in `task.attachments` before deciding implementation. Download an inline attachment only when needed.
2. If the prompt says the scheduler already claimed the issue, require `in_progress` and do not rewrite its status. Otherwise claim one `todo` with its latest version; stop on conflict.
3. Work in the issue's bound branch or worktree, implement the request directly, and verify the requested result.
4. Add one concise comment with changes, verification, result, and remaining risk. Re-read the issue, then move it to `in_review` with its latest version.
5. Use `done` only after explicit user acceptance. Use `blocked` or `canceled` only when work cannot or will not continue.

## Manage Issues

- Search the current project's issues before creating or relating durable work; skip tracking trivial requests.
- Read immediately before every write and pass `--if-version`. Reconcile conflicts from the latest state.
- Preserve existing scope when appending requirements. Use `parent`, `blocks`, `blocked_by`, or `related` only when the relationship matters.
- Let Codex provide `CODEX_THREAD_ID`; outside Codex, pass `--thread-id` explicitly.
