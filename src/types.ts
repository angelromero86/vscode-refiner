/**
 * The on-disk data model for Refiner. This file (`.refiner/comments.json`) is the
 * contract shared between the VSCode extension and Claude Code — keep it simple and
 * human-readable so it can be edited by either side.
 *
 * Line numbers are 1-based (matching the editor gutter) to stay friendly for humans
 * and for Claude Code reading the file.
 */

export type CommentRole = 'user' | 'assistant';
export type ThreadStatus = 'open' | 'resolved';

export interface StoredComment {
  id: string;
  /** Display name of who wrote the comment. */
  author: string;
  /** "user" = a human; "assistant" = Claude Code. Drives styling and permissions. */
  role: CommentRole;
  /** Markdown body of the comment. */
  body: string;
  /** ISO-8601 timestamp. */
  createdAt: string;
}

/**
 * A content snapshot used to keep a thread attached to its code as lines shift.
 * Managed automatically by the extension — external tools (Claude Code) can ignore
 * it; the extension backfills it from the current file when missing.
 */
export interface Anchor {
  /** Exact text of the anchored lines when captured. */
  lines: string[];
  /** Up to a few lines immediately above, for disambiguation. */
  before: string[];
  /** Up to a few lines immediately below, for disambiguation. */
  after: string[];
}

export interface StoredThread {
  id: string;
  /** Workspace-relative path, using forward slashes. */
  file: string;
  /** 1-based, inclusive line range the thread is anchored to. */
  range: { start: number; end: number };
  status: ThreadStatus;
  comments: StoredComment[];
  /** Content anchor for drift tracking. Optional; the extension fills it in. */
  anchor?: Anchor;
}

export interface StoreData {
  version: number;
  threads: StoredThread[];
}
