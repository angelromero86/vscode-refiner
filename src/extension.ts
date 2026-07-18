import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { captureAnchor, relocate, splitLines } from './anchor';
import { RefinerStore, ThreadPatch } from './store';
import { Anchor, CommentRole, StoredComment, StoredThread } from './types';

const CONTROLLER_ID = 'refiner.commentController';
const RECONCILE_DEBOUNCE_MS = 300;

/** A CommentThread we created, tagged with the id of its stored counterpart. */
interface ThreadWithId extends vscode.CommentThread {
  refinerId?: string;
}

/** Cached, re-anchored position for display (may differ from what's on disk). */
interface AnchorState {
  start: number;
  end: number;
  outdated: boolean;
}

/** Our implementation of a single comment shown inline in the editor. */
class RefinerComment implements vscode.Comment {
  body: string | vscode.MarkdownString;
  savedBody: string | vscode.MarkdownString;
  mode: vscode.CommentMode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation;
  contextValue: string;
  timestamp?: Date;
  label?: string;

  constructor(
    readonly storeId: string,
    readonly parentThreadId: string,
    readonly role: CommentRole,
    body: string,
    authorName: string,
    createdAt?: string,
  ) {
    this.body = new vscode.MarkdownString(body);
    this.savedBody = this.body;
    this.author = { name: authorName };
    // Used by menu `when` clauses (e.g. `comment == user`).
    this.contextValue = role;
    this.timestamp = createdAt ? new Date(createdAt) : undefined;
    if (role === 'assistant') {
      this.label = 'Claude Code';
    }
  }
}

function bodyToString(body: string | vscode.MarkdownString): string {
  return typeof body === 'string' ? body : body.value;
}

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    console.log('[Refiner] no workspace folder open — extension idle.');
    return;
  }
  console.log(`[Refiner] activated for ${folder.uri.fsPath}`);

  const store = new RefinerStore(folder);

  const controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Refiner');
  controller.options = {
    prompt: 'Comment…',
    placeHolder: 'Leave a comment for Claude Code',
  };
  // Allow commenting on any line of any file in the workspace (except the store itself).
  controller.commentingRangeProvider = {
    provideCommentingRanges: (document) => {
      if (document.uri.scheme !== 'file') {
        return [];
      }
      if (!document.uri.fsPath.startsWith(folder.uri.fsPath)) {
        return [];
      }
      if (document.uri.fsPath === store.uri.fsPath) {
        return [];
      }
      return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
    },
  };

  // Maps stored thread id -> the live CommentThread rendered in the editor.
  const threads = new Map<string, vscode.CommentThread>();
  // Re-anchored display positions, keyed by stored thread id.
  const anchors = new Map<string, AnchorState>();
  // Debounce timers for live re-anchoring while typing, keyed by file path.
  const debounce = new Map<string, ReturnType<typeof setTimeout>>();

  const relPath = (uri: vscode.Uri): string =>
    path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
  const absUri = (rel: string): vscode.Uri =>
    vscode.Uri.joinPath(folder.uri, ...rel.split('/'));
  const authorName = (): string => {
    const configured = vscode.workspace
      .getConfiguration('refiner')
      .get<string>('authorName')
      ?.trim();
    return configured || os.userInfo().username;
  };
  const getDocLines = (uri: vscode.Uri): string[] | undefined => {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    return doc ? splitLines(doc.getText()) : undefined;
  };

  /** Reconcile the live CommentThreads with what's stored on disk. */
  function sync(): void {
    const seen = new Set<string>();
    for (const st of store.threads) {
      seen.add(st.id);
      const pos = anchors.get(st.id);
      const startLine = pos?.start ?? st.range.start;
      const endLine = pos?.end ?? st.range.end;
      const outdated = pos?.outdated ?? false;
      const range = new vscode.Range(
        Math.max(0, startLine - 1),
        0,
        Math.max(0, endLine - 1),
        0,
      );
      let thread = threads.get(st.id) as ThreadWithId | undefined;
      if (!thread) {
        thread = controller.createCommentThread(absUri(st.file), range, []) as ThreadWithId;
        threads.set(st.id, thread);
      } else {
        thread.range = range;
      }
      thread.refinerId = st.id;
      thread.comments = st.comments.map(
        (c) => new RefinerComment(c.id, st.id, c.role, c.body, c.author, c.createdAt),
      );
      // contextValue drives the resolve/reopen menu buttons.
      thread.contextValue = st.status;
      thread.canReply = st.status !== 'resolved';
      thread.label =
        st.status === 'resolved'
          ? 'Resolved'
          : outdated
            ? 'Outdated · code changed'
            : undefined;
      thread.state =
        st.status === 'resolved'
          ? vscode.CommentThreadState.Resolved
          : vscode.CommentThreadState.Unresolved;
    }
    // Drop threads that no longer exist on disk.
    for (const [id, thread] of threads) {
      if (!seen.has(id)) {
        thread.dispose();
        threads.delete(id);
        anchors.delete(id);
      }
    }
  }

  /**
   * Re-anchor every thread that lives in `uri` against the file's current content.
   * Updates the in-memory display positions, and (when `persist`) writes corrected
   * ranges and backfilled anchors to disk.
   */
  async function reconcileDoc(uri: vscode.Uri, persist: boolean): Promise<void> {
    if (uri.scheme !== 'file') {
      return;
    }
    const lines = getDocLines(uri);
    if (!lines) {
      return;
    }
    const rel = relPath(uri);
    const patches: ThreadPatch[] = [];
    for (const st of store.threads) {
      if (st.file !== rel) {
        continue;
      }
      if (!st.anchor) {
        // First time we see this thread with the file open: snapshot its anchor.
        anchors.set(st.id, { start: st.range.start, end: st.range.end, outdated: false });
        if (persist) {
          patches.push({ id: st.id, anchor: captureAnchor(lines, st.range.start, st.range.end) });
        }
        continue;
      }
      const res = relocate(lines, st.anchor, st.range.start);
      anchors.set(st.id, { start: res.start, end: res.end, outdated: res.status === 'lost' });
      if (persist && res.status === 'moved' && (res.start !== st.range.start || res.end !== st.range.end)) {
        patches.push({ id: st.id, range: { start: res.start, end: res.end } });
      }
    }
    if (patches.length) {
      await store.patchThreads(patches); // -> onDidChange -> sync()
    } else {
      sync();
    }
  }

  function scheduleReconcile(uri: vscode.Uri): void {
    const key = uri.fsPath;
    const existing = debounce.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    debounce.set(
      key,
      setTimeout(() => {
        debounce.delete(key);
        void reconcileDoc(uri, false);
      }, RECONCILE_DEBOUNCE_MS),
    );
  }

  store.onDidChange(() => sync());

  // ---- Command handlers -------------------------------------------------

  // "+" on an empty commenting range: create a brand-new thread.
  async function createThread(reply: vscode.CommentReply): Promise<void> {
    const thread = reply.thread as ThreadWithId;
    const storedThreadId = store.id('t');
    const range = thread.range ?? new vscode.Range(0, 0, 0, 0);
    const start1 = range.start.line + 1;
    const end1 = range.end.line + 1;
    const lines = getDocLines(thread.uri);
    const stored: StoredThread = {
      id: storedThreadId,
      file: relPath(thread.uri),
      range: { start: start1, end: end1 },
      status: 'open',
      comments: [
        {
          id: store.id('c'),
          author: authorName(),
          role: 'user',
          body: reply.text,
          createdAt: new Date().toISOString(),
        },
      ],
      anchor: lines ? captureAnchor(lines, start1, end1) : undefined,
    };
    // Reuse the thread VSCode just created so sync() updates it in place
    // instead of creating a duplicate.
    thread.refinerId = storedThreadId;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    threads.set(storedThreadId, thread);
    anchors.set(storedThreadId, { start: start1, end: end1, outdated: false });
    await store.addThread(stored);
  }

  async function replyThread(reply: vscode.CommentReply): Promise<void> {
    const id = (reply.thread as ThreadWithId).refinerId;
    if (!id) {
      return;
    }
    const comment: StoredComment = {
      id: store.id('c'),
      author: authorName(),
      role: 'user',
      body: reply.text,
      createdAt: new Date().toISOString(),
    };
    await store.addComment(id, comment);
  }

  async function resolveThread(thread: vscode.CommentThread): Promise<void> {
    const id = (thread as ThreadWithId).refinerId;
    if (id) {
      await store.setStatus(id, 'resolved');
    }
  }

  async function reopenThread(thread: vscode.CommentThread): Promise<void> {
    const id = (thread as ThreadWithId).refinerId;
    if (id) {
      await store.setStatus(id, 'open');
    }
  }

  async function deleteThread(thread: vscode.CommentThread): Promise<void> {
    const id = (thread as ThreadWithId).refinerId;
    if (id) {
      await store.deleteThread(id);
    }
  }

  function editComment(comment: RefinerComment): void {
    const thread = threads.get(comment.parentThreadId);
    if (!thread) {
      return;
    }
    // Reassign to a new array so VSCode re-renders in edit mode.
    thread.comments = thread.comments.map((c) => {
      if ((c as RefinerComment).storeId === comment.storeId) {
        c.mode = vscode.CommentMode.Editing;
      }
      return c;
    });
  }

  async function saveComment(comment: RefinerComment): Promise<void> {
    const thread = threads.get(comment.parentThreadId);
    if (!thread) {
      return;
    }
    const live = thread.comments.find(
      (c) => (c as RefinerComment).storeId === comment.storeId,
    ) as RefinerComment | undefined;
    if (!live) {
      return;
    }
    // VSCode wrote the edited text into `live.body`; persist it. The resulting
    // store change re-renders the thread back in Preview mode via sync().
    await store.updateComment(comment.parentThreadId, comment.storeId, bodyToString(live.body));
  }

  function cancelEdit(): void {
    // Rebuild everything from disk, discarding any in-progress edit.
    sync();
  }

  async function deleteComment(comment: RefinerComment): Promise<void> {
    await store.deleteComment(comment.parentThreadId, comment.storeId);
  }

  async function refresh(): Promise<void> {
    await store.init();
  }

  async function reanchor(): Promise<void> {
    for (const doc of vscode.workspace.textDocuments) {
      await reconcileDoc(doc.uri, true);
    }
    void vscode.window.showInformationMessage('Refiner: re-anchored comments to current code.');
  }

  /**
   * Copy the bundled Claude Code skills into ~/.claude/skills so the review loop
   * works out of the box. The extension is only half the system — without the
   * skills, Claude Code has no `/refine-review` or `/refine-resolve`.
   */
  async function installSkills(): Promise<void> {
    const src = vscode.Uri.joinPath(context.extensionUri, 'skills');
    const dst = vscode.Uri.file(path.join(os.homedir(), '.claude', 'skills'));

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(src);
    } catch {
      void vscode.window.showErrorMessage('Refiner: no bundled skills found in this build.');
      return;
    }
    const names = entries.filter(([, type]) => type === vscode.FileType.Directory).map(([n]) => n);
    if (names.length === 0) {
      void vscode.window.showErrorMessage('Refiner: no bundled skills found in this build.');
      return;
    }

    // Warn before clobbering anything already there (e.g. a dev symlink).
    const existing: string[] = [];
    for (const name of names) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(dst, name));
        existing.push(name);
      } catch {
        // not present — nothing to overwrite
      }
    }
    const detail = `Installs ${names.join(', ')} into ~/.claude/skills.`;
    const answer = await vscode.window.showWarningMessage(
      existing.length
        ? `Refiner: overwrite existing ${existing.join(', ')} in ~/.claude/skills?`
        : 'Refiner: install Claude Code skills?',
      { modal: true, detail },
      'Install',
    );
    if (answer !== 'Install') {
      return;
    }

    await vscode.workspace.fs.createDirectory(dst);
    for (const name of names) {
      await vscode.workspace.fs.copy(
        vscode.Uri.joinPath(src, name),
        vscode.Uri.joinPath(dst, name),
        { overwrite: true },
      );
    }
    void vscode.window.showInformationMessage(
      `Refiner: installed ${names.join(', ')}. Restart Claude Code to pick them up.`,
    );
  }

  context.subscriptions.push(
    controller,
    store,
    vscode.commands.registerCommand('refiner.createThread', createThread),
    vscode.commands.registerCommand('refiner.replyThread', replyThread),
    vscode.commands.registerCommand('refiner.resolveThread', resolveThread),
    vscode.commands.registerCommand('refiner.reopenThread', reopenThread),
    vscode.commands.registerCommand('refiner.deleteThread', deleteThread),
    vscode.commands.registerCommand('refiner.editComment', editComment),
    vscode.commands.registerCommand('refiner.saveComment', saveComment),
    vscode.commands.registerCommand('refiner.cancelEdit', cancelEdit),
    vscode.commands.registerCommand('refiner.deleteComment', deleteComment),
    vscode.commands.registerCommand('refiner.refresh', refresh),
    vscode.commands.registerCommand('refiner.reanchor', reanchor),
    vscode.commands.registerCommand('refiner.installSkills', installSkills),
    // Track code changes so bubbles follow the code they were written against.
    vscode.workspace.onDidOpenTextDocument((doc) => void reconcileDoc(doc.uri, true)),
    vscode.workspace.onDidSaveTextDocument((doc) => void reconcileDoc(doc.uri, true)),
    vscode.workspace.onDidChangeTextDocument((e) => scheduleReconcile(e.document.uri)),
  );

  void store.init().then(() => {
    for (const doc of vscode.workspace.textDocuments) {
      void reconcileDoc(doc.uri, true);
    }
  });
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
