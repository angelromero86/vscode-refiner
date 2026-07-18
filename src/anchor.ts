/**
 * Content-based anchoring: keep comment threads attached to the *code* they were
 * written against, even after lines shift around.
 *
 * When a thread is created we snapshot the exact text of the anchored lines plus a
 * few lines of context. Later, `relocate()` searches the current file for that
 * snippet and reports where it moved to — or that it can no longer be found.
 */

import { Anchor } from './types';

/** How many lines of leading/trailing context to keep for disambiguation. */
const CTX = 3;

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Compare ignoring trailing whitespace, so a stray space doesn't break anchoring. */
function norm(line: string): string {
  return line.replace(/\s+$/, '');
}

function blockEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (norm(a[i]) !== norm(b[i])) {
      return false;
    }
  }
  return true;
}

/** Snapshot the anchor for a 1-based, inclusive line range. */
export function captureAnchor(lines: string[], start1: number, end1: number): Anchor {
  const s = Math.max(0, start1 - 1);
  const e = Math.min(lines.length - 1, end1 - 1);
  return {
    lines: lines.slice(s, e + 1),
    before: lines.slice(Math.max(0, s - CTX), s),
    after: lines.slice(e + 1, Math.min(lines.length, e + 1 + CTX)),
  };
}

export type RelocateStatus = 'exact' | 'moved' | 'lost';

export interface RelocateResult {
  /** 1-based, inclusive. */
  start: number;
  end: number;
  status: RelocateStatus;
}

/**
 * Find where `anchor` now lives in `lines`.
 * - `exact`: still at its previous position.
 * - `moved`: found elsewhere; start/end updated.
 * - `lost`: the anchored text no longer exists; start/end left at the previous spot.
 */
export function relocate(lines: string[], anchor: Anchor, prevStart1: number): RelocateResult {
  const len = anchor.lines.length;
  if (len === 0) {
    return { start: prevStart1, end: prevStart1, status: 'lost' };
  }
  const prev0 = Math.max(0, prevStart1 - 1);

  // Fast path: unchanged at its old position.
  if (prev0 + len <= lines.length && blockEquals(lines.slice(prev0, prev0 + len), anchor.lines)) {
    return { start: prevStart1, end: prevStart1 + len - 1, status: 'exact' };
  }

  // Otherwise scan for the best matching occurrence.
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i + len <= lines.length; i++) {
    if (!blockEquals(lines.slice(i, i + len), anchor.lines)) {
      continue;
    }
    // Prefer occurrences whose surrounding context also matches, then the closest
    // one to where the thread used to be.
    const score = contextScore(lines, i, len, anchor) * 1000 - Math.abs(i - prev0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }

  if (best < 0) {
    return { start: prevStart1, end: prevStart1 + len - 1, status: 'lost' };
  }
  return { start: best + 1, end: best + len, status: 'moved' };
}

function contextScore(lines: string[], i: number, len: number, anchor: Anchor): number {
  let score = 0;
  for (let k = 0; k < anchor.before.length; k++) {
    const li = i - 1 - k;
    const ai = anchor.before.length - 1 - k;
    if (li >= 0 && norm(lines[li]) === norm(anchor.before[ai])) {
      score++;
    }
  }
  for (let k = 0; k < anchor.after.length; k++) {
    const li = i + len + k;
    if (li < lines.length && norm(lines[li]) === norm(anchor.after[k])) {
      score++;
    }
  }
  return score;
}
