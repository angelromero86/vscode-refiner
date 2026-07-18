import * as vscode from 'vscode';
import { Anchor, StoreData, StoredComment, StoredThread, ThreadStatus } from './types';

/** A range/anchor correction the extension computed while re-anchoring. */
export interface ThreadPatch {
  id: string;
  range?: { start: number; end: number };
  anchor?: Anchor;
}

const DIR = '.refiner';
const FILE = 'comments.json';

/**
 * Owns `.refiner/comments.json`: reads it, writes it, and watches it for external
 * changes (e.g. Claude Code replying). Fires `onDidChange` whenever the in-memory
 * data changes, so the UI layer can reconcile.
 */
export class RefinerStore implements vscode.Disposable {
  private data: StoreData = { version: 1, threads: [] };
  private lastWritten = '';
  private seq = 0;
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly folder: vscode.WorkspaceFolder) {
    const pattern = new vscode.RelativePattern(folder, `${DIR}/${FILE}`);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange(() => void this.reload());
    this.watcher.onDidCreate(() => void this.reload());
    this.watcher.onDidDelete(() => {
      this.data = { version: 1, threads: [] };
      this.lastWritten = '';
      this._onDidChange.fire();
    });
  }

  get uri(): vscode.Uri {
    return vscode.Uri.joinPath(this.folder.uri, DIR, FILE);
  }

  get threads(): StoredThread[] {
    return this.data.threads;
  }

  /** Read the file for the first time (or on manual refresh). */
  async init(): Promise<void> {
    await this.reload(true);
  }

  /** Generate a short, unique id with a readable prefix. */
  id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${Date.now().toString(36)}-${this.seq.toString(36)}`;
  }

  private async reload(initial = false): Promise<void> {
    let text: string;
    try {
      const buf = await vscode.workspace.fs.readFile(this.uri);
      text = Buffer.from(buf).toString('utf8');
    } catch {
      // File doesn't exist yet — treat as empty.
      this.data = { version: 1, threads: [] };
      this._onDidChange.fire();
      return;
    }
    // Ignore the change event triggered by our own write.
    if (!initial && text === this.lastWritten) {
      return;
    }
    try {
      const obj = JSON.parse(text) as Partial<StoreData>;
      this.data = {
        version: obj.version ?? 1,
        threads: Array.isArray(obj.threads) ? (obj.threads as StoredThread[]) : [],
      };
      this.lastWritten = text;
    } catch (err) {
      vscode.window.showErrorMessage(`Refiner: could not parse ${DIR}/${FILE}: ${err}`);
      return;
    }
    this._onDidChange.fire();
  }

  private async persist(): Promise<void> {
    const text = JSON.stringify(this.data, null, 2) + '\n';
    this.lastWritten = text;
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.folder.uri, DIR));
    await vscode.workspace.fs.writeFile(this.uri, Buffer.from(text, 'utf8'));
    this._onDidChange.fire();
  }

  async addThread(thread: StoredThread): Promise<void> {
    this.data.threads.push(thread);
    await this.persist();
  }

  async addComment(threadId: string, comment: StoredComment): Promise<void> {
    const thread = this.data.threads.find((t) => t.id === threadId);
    if (!thread) {
      return;
    }
    thread.comments.push(comment);
    await this.persist();
  }

  async setStatus(threadId: string, status: ThreadStatus): Promise<void> {
    const thread = this.data.threads.find((t) => t.id === threadId);
    if (!thread) {
      return;
    }
    thread.status = status;
    await this.persist();
  }

  async deleteThread(threadId: string): Promise<void> {
    this.data.threads = this.data.threads.filter((t) => t.id !== threadId);
    await this.persist();
  }

  async updateComment(threadId: string, commentId: string, body: string): Promise<void> {
    const thread = this.data.threads.find((t) => t.id === threadId);
    const comment = thread?.comments.find((c) => c.id === commentId);
    if (!comment) {
      return;
    }
    comment.body = body;
    await this.persist();
  }

  /** Apply re-anchoring corrections (range and/or anchor snapshots) in one write. */
  async patchThreads(patches: ThreadPatch[]): Promise<void> {
    let changed = false;
    for (const patch of patches) {
      const thread = this.data.threads.find((t) => t.id === patch.id);
      if (!thread) {
        continue;
      }
      if (patch.range) {
        thread.range = patch.range;
        changed = true;
      }
      if (patch.anchor) {
        thread.anchor = patch.anchor;
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
    }
  }

  async deleteComment(threadId: string, commentId: string): Promise<void> {
    const thread = this.data.threads.find((t) => t.id === threadId);
    if (!thread) {
      return;
    }
    thread.comments = thread.comments.filter((c) => c.id !== commentId);
    // A thread with no comments is meaningless — drop it.
    if (thread.comments.length === 0) {
      this.data.threads = this.data.threads.filter((t) => t.id !== threadId);
    }
    await this.persist();
  }

  dispose(): void {
    this.watcher.dispose();
    this._onDidChange.dispose();
  }
}
