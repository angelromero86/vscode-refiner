---
name: refine-review
description: Review the current diff and leave inline comment threads in .refiner/comments.json for the Refiner VSCode extension
user-invocable: true
---

# refine-review skill

You are reviewing a diff and leaving inline comment threads by writing them to
`.refiner/comments.json` at the repo root. The human opens the **Refiner** VSCode
extension and sees your threads as comment bubbles anchored to the code.

## Arguments

- `ref` (optional): Git ref to review. Defaults to working-tree changes.
  Examples: `main`, `HEAD~3`, `origin/main..feature`.
- `focus` (optional): Concentrate the review on one area. One of: `security`,
  `performance`, `naming`, `errors`, `types`, `logic`. If omitted, review
  everything.

## Storage format

Threads live in `.refiner/comments.json` at the repo root — plain JSON. The whole
file is one object: `{ "version": 1, "threads": [ ... ] }`. Read it (or treat it as
empty if missing), **append** your new threads to the `threads` array, and write the
whole file back. Never rewrite, reorder, or drop existing threads or comments.

A thread you create looks like this:

```json
{
  "id": "t-a3f9c1b8",
  "file": "src/foo.ts",
  "range": { "start": 42, "end": 45 },
  "status": "open",
  "comments": [
    {
      "id": "c-91b2e4d0",
      "author": "Claude Code",
      "role": "assistant",
      "body": "[must-fix] Lead with the problem. Be specific and actionable.",
      "createdAt": "2026-07-17T10:30:00.000Z"
    }
  ]
}
```

Field rules:
- `id` — unique within the file. Use `t-` + 8 hex chars for threads, `c-` + 8 hex
  for comments. Sample with `python3 -c "import secrets; print(secrets.token_hex(4))"`.
- `range` — **1-based, inclusive** line numbers in the working tree (the NEW side of
  the diff). Match the gutter numbers a human sees.
- `role` — always `"assistant"` for threads you create.
- `createdAt` — ISO-8601 UTC (current time).
- **Do NOT write an `anchor` field.** The extension captures it automatically the
  first time the human opens the file. Leaving it out is correct.

Severity prefix in `body` (use exactly one, in brackets, at the start):
- `[must-fix]` — bug, security issue, data loss
- `[suggestion]` — concrete improvement with a clear reason
- `[question]` — something genuinely unclear that needs author input
- `[nit]` — minor but actionable

## Prerequisites

1. Confirm you're inside a git repo: `git rev-parse --show-toplevel`. If it fails,
   tell the user to run the skill from inside their repo.
2. Locate (or be ready to create) `.refiner/comments.json` at that path.

## Instructions

### Step 1 — Read the diff

1. Get the unified diff for the requested scope:
   - No `ref`: `git diff HEAD` (working tree + index). For untracked files:
     `git ls-files --others --exclude-standard`, then read each — no diff vs HEAD.
   - `ref` given: `git diff <ref>...HEAD` (three-dot, merge-base).

2. Read every `CLAUDE.md` you find — the repo root, plus any in directories with
   changed files. They define project-specific rules the diff must follow.

3. **Gauge size and plan**:
   - **Small** (< ~100 changed lines, 1–3 files): review file by file.
   - **Medium** (100–500 lines, 3–10 files): group by area (core logic, tests,
     config). Read core logic first.
   - **Large** (500+ lines or 10+ files): group by area, core logic first, then
     sweep every other file. For mechanical repetition, verify the pattern on the
     first few then check the rest for deviations — don't skip any.

   **Read every changed file. Do not spot-check.**

### Step 2 — Understand intent first, then look for problems

1. Build a mental model before flagging anything: what is the change trying to do?
   Which files are structural (renames/moves) vs. core logic? Check commit messages
   with `git log --oneline <range>` if a ref was given.
2. For each changed file, read the **entire file**, not just the hunks.
3. **Cross-reference callers**. For any changed signature, renamed export, or
   modified return type: grep for usages across the repo. Code correct in isolation
   can still break callers.

### Step 3 — Analysis passes

Apply these, scoped to `focus` if given:

- **Data flow** — trace values through changed code. Null/undefined where not
  expected? All branches handled? Callers updated for a new return shape?
- **State and lifecycle** — transactions, streams, listeners, React state:
  unreachable states, leaked resources, concurrent-access bugs, ordering invariants.
- **Contracts** — does the changed function still satisfy what callers expect?
- **Boundaries** — user input, network, file I/O, IPC: validation, injection
  vectors (SQL/shell/path/XSS), malformed external data.
- **Edge cases** (real, not theoretical) — empty arrays, zero, negatives,
  off-by-one, divide-by-zero on user input.
- **Completeness** — missing tests (flag `[suggestion]`, or `[must-fix]` if
  CLAUDE.md requires them), schema change without migration, new env var without
  docs, removed feature leaving dead imports/tests.

### Step 4 — Validate each finding

Before writing a thread, verify it's real:
- Re-read surrounding code — many "bugs" disappear in full context.
- For "missing import" claims, grep to confirm.
- For "broken caller" claims, read the actual call sites.
- For CLAUDE.md violations, quote the exact rule.

If a pattern repeats across files, comment on the first occurrence and mention the
pattern once, rather than duplicating.

### Step 5 — Write threads to `.refiner/comments.json`

1. **Read the existing file first** if it exists. Parse the JSON. You will append to
   `threads`, preserving every existing thread and comment exactly.
2. For each finding, build a thread object using the shape above. Generate fresh
   unique ids. Pick the line range from the NEW side of the diff.
3. **Order the threads you append by severity**: all `[must-fix]` first, then
   `[suggestion]`, then `[question]`, then `[nit]`. Within a level, follow diff
   order (top to bottom, first file then next).
4. Write the whole file back with the Write tool: valid JSON, 2-space indent,
   trailing newline. Double-check it parses (no trailing commas, quotes balanced) —
   the extension shows an error and stops loading if the JSON is invalid.
5. Summary thread:
   - **No findings** → append one thread on any sensible file: "No issues found.
     Checked for bugs and CLAUDE.md compliance."
   - **1–2 findings** → skip the summary.
   - **3+ findings or large diff** → append one summary thread grouping findings by
     area. No severity prefix. Lead with the verdict, no filler.

### Step 6 — Hand off

Tell the user:

> Review complete. Wrote N threads to `.refiner/comments.json`.
> Found: X must-fix, Y suggestions, Z questions.
>
> Open them in VSCode (the Refiner bubbles appear inline). Reply in a thread, or run
> `/refine-resolve` to have me apply the fixes. Resolve a thread with its ✓ button
> once you're happy.

## Do NOT

- Do **not** modify code. This skill only writes review threads — fixes are
  `/refine-resolve`'s job.
- Do **not** set `status` to `"resolved"`. Always `"open"`.
- Do **not** write an `anchor` field — the extension manages it.
- Do **not** rewrite, reorder, or delete existing threads/comments. Append only.
- Do **not** flag style/linter issues or pre-existing problems in unchanged code.
  Focus on the diff.
- Do **not** leave the JSON invalid. Re-read your write and confirm it parses.
