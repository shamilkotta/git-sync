import * as git from "isomorphic-git";
import type { App } from "obsidian";
import {
  conflictCopyPath,
  createCommitMessage,
  describeResult,
  type GitBackend,
  type SyncMode,
  type SyncResult,
} from "./gitBackend";
import { obsidianHttp } from "./obsidianHttp";
import type { AutoGitSyncSettings } from "./types";
import { VaultFsAdapter } from "./vaultFsAdapter";

type GitRepoParams = {
  fs: VaultFsAdapter;
  dir: string;
  gitdir: string;
  http: typeof obsidianHttp;
  cache: object;
  onAuth: () => { username?: string; password?: string };
};

type TreeEntryOids = { path: string; base?: string; ours?: string; theirs?: string };

export class MobileGitBackend implements GitBackend {
  private readonly fs: VaultFsAdapter;

  constructor(
    private readonly app: App,
    private readonly settings: AutoGitSyncSettings,
  ) {
    this.fs = new VaultFsAdapter(app.vault);
  }

  async sync(mode: SyncMode, trigger: string): Promise<SyncResult> {
    const repo = this.getRepoParams();

    await this.ensureRepository(repo);
    const branch = await this.getOrCreateBranch(repo);

    const committed = await this.commitAll(repo, createCommitMessage(trigger));

    if (mode === "local" && !(await this.isAheadOfRemote(repo, branch))) {
      return this.result({ pulled: false, committed, pushed: false, conflicts: [] });
    }

    const conflicts: string[] = [];
    const pulled = await this.pull(repo, branch, conflicts);
    let pushed = false;
    if (await this.isAheadOfRemote(repo, branch)) {
      await this.pushWithRetry(repo, branch, conflicts);
      pushed = true;
    }

    return this.result({ pulled, committed, pushed, conflicts });
  }

  private result(result: Omit<SyncResult, "message">): SyncResult {
    return { ...result, message: describeResult(result) };
  }

  private getRepoParams(): GitRepoParams {
    return {
      fs: this.fs,
      dir: "/",
      gitdir: "/.git",
      http: obsidianHttp,
      // Shared packfile/index cache for the duration of one sync: big speedup on mobile.
      cache: {},
      onAuth: () => ({
        username: this.settings.username || undefined,
        password: this.settings.passwordOrToken || undefined,
      }),
    };
  }

  private async ensureRepository(repo: GitRepoParams): Promise<void> {
    if (!this.settings.remoteUrl) {
      throw new Error("Set a remote URL before syncing on mobile.");
    }

    const gitHeadExists = await this.app.vault.adapter.exists("/.git/HEAD");
    if (!gitHeadExists) {
      await git.init({
        fs: repo.fs,
        dir: repo.dir,
        gitdir: repo.gitdir,
        defaultBranch: this.settings.branch || "main",
      });
    }

    const remotes = await git.listRemotes(repo);
    const existing = remotes.find((remote) => remote.remote === this.settings.remoteName);
    if (existing?.url !== this.settings.remoteUrl) {
      await git.addRemote({
        ...repo,
        remote: this.settings.remoteName,
        url: this.settings.remoteUrl,
        force: true,
      });
    }
  }

  private async getOrCreateBranch(repo: GitRepoParams): Promise<string> {
    const branch = this.settings.branch || "main";
    const current = await git.currentBranch({ ...repo, fullname: false });
    if (current === branch) {
      return branch;
    }

    const branches = await git.listBranches(repo);
    if (branches.includes(branch)) {
      await git.checkout({ ...repo, ref: branch });
      return branch;
    }

    await git.branch({ ...repo, ref: branch, checkout: true });
    return branch;
  }

  private remoteRef(branch: string): string {
    return `refs/remotes/${this.settings.remoteName}/${branch}`;
  }

  private async resolveOid(repo: GitRepoParams, ref: string): Promise<string | null> {
    try {
      return await git.resolveRef({ ...repo, ref });
    } catch {
      return null;
    }
  }

  /** Compares against the last fetched remote-tracking ref (no network). */
  private async isAheadOfRemote(repo: GitRepoParams, branch: string): Promise<boolean> {
    const local = await this.resolveOid(repo, `refs/heads/${branch}`);
    if (!local) return false;
    const remote = await this.resolveOid(repo, this.remoteRef(branch));
    return local !== remote;
  }

  private async pull(repo: GitRepoParams, branch: string, conflicts: string[]): Promise<boolean> {
    await git.fetch({
      ...repo,
      remote: this.settings.remoteName,
      ref: branch,
      singleBranch: true,
      tags: false,
      prune: true,
    });

    const theirs = await this.resolveOid(repo, this.remoteRef(branch));
    if (!theirs) {
      return false;
    }

    const ours = await this.resolveOid(repo, `refs/heads/${branch}`);
    if (ours === theirs) {
      return false;
    }

    if (!ours) {
      await this.moveBranch(repo, branch, theirs, conflicts);
      return true;
    }

    if (await git.isDescendent({ ...repo, oid: ours, ancestor: theirs, depth: -1 })) {
      // Only local commits; nothing to pull.
      return false;
    }

    try {
      await git.merge({
        ...repo,
        ours: branch,
        theirs: this.remoteRef(branch),
        allowUnrelatedHistories: true,
        abortOnConflict: true,
        author: this.syncAuthor(),
        committer: this.syncAuthor(),
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "MergeConflictError" && code !== "MergeNotSupportedError") {
        throw error;
      }
      // Line-level merge failed: keep remote versions, save local versions as conflict copies.
      await this.mergeKeepingBoth(repo, branch, ours, theirs, conflicts);
      return true;
    }

    await this.safeCheckout(repo, branch, conflicts);
    return true;
  }

  /**
   * Lossless fallback merge. The branch is moved to the remote commit, then every file we changed
   * locally since the merge base is re-applied on top: files only we touched are written back,
   * files both sides touched are saved as conflict copies. The result is committed.
   */
  private async mergeKeepingBoth(
    repo: GitRepoParams,
    branch: string,
    ours: string,
    theirs: string,
    conflicts: string[],
  ): Promise<void> {
    const [base] = await git.findMergeBase({ ...repo, oids: [ours, theirs] });
    const entries = await this.diffTrees(repo, base as string | undefined, ours, theirs);

    await this.moveBranch(repo, branch, theirs, conflicts);

    const stamp = new Date();
    for (const entry of entries) {
      if (entry.ours === entry.base || entry.ours === entry.theirs) continue;

      if (entry.theirs === entry.base) {
        // Only we changed it: re-apply our version.
        if (entry.ours) {
          await this.writeBlob(repo, entry.path, entry.ours);
        } else {
          await this.fs.unlink(entry.path).catch(() => undefined);
        }
      } else if (entry.ours) {
        // Both changed it: remote stays in place, ours goes next to it.
        await this.writeBlob(repo, conflictCopyPath(entry.path, stamp), entry.ours);
        conflicts.push(entry.path);
      }
      // Deleted by us, modified by them: keep theirs.
    }

    await this.commitAll(repo, createCommitMessage("resolve sync conflicts"));
  }

  private async diffTrees(
    repo: GitRepoParams,
    base: string | undefined,
    ours: string,
    theirs: string,
  ): Promise<TreeEntryOids[]> {
    const refs = base ? [base, ours, theirs] : [ours, theirs];
    return (await git.walk({
      ...repo,
      trees: refs.map((ref) => git.TREE({ ref })),
      map: async (filepath, walkerEntries) => {
        if (filepath === ".") return undefined;
        const entries = base ? walkerEntries : [null, ...walkerEntries];
        const oids: (string | undefined)[] = [];
        for (const entry of entries) {
          if (entry && (await entry.type()) === "blob") {
            oids.push(await entry.oid());
          } else {
            oids.push(undefined);
          }
        }
        if (oids.every((oid) => oid === undefined)) return undefined;
        return { path: filepath, base: oids[0], ours: oids[1], theirs: oids[2] };
      },
    })) as TreeEntryOids[];
  }

  private async writeBlob(repo: GitRepoParams, filepath: string, oid: string): Promise<void> {
    const { blob } = await git.readBlob({ ...repo, oid });
    const parent = filepath.slice(0, filepath.lastIndexOf("/"));
    if (parent && !(await this.app.vault.adapter.exists(parent))) {
      await this.app.vault.adapter.mkdir(parent);
    }
    await this.fs.writeFile(
      filepath,
      blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength) as ArrayBuffer,
    );
  }

  private async moveBranch(
    repo: GitRepoParams,
    branch: string,
    oid: string,
    conflicts: string[],
  ): Promise<void> {
    await git.writeRef({ ...repo, ref: `refs/heads/${branch}`, value: oid, force: true });
    await this.safeCheckout(repo, branch, conflicts);
  }

  /**
   * Update the working tree to the branch tip without clobbering edits made while syncing.
   * Files edited locally that the update also touches are saved as conflict copies first.
   */
  private async safeCheckout(
    repo: GitRepoParams,
    branch: string,
    conflicts: string[],
  ): Promise<void> {
    try {
      await git.checkout({ ...repo, ref: branch });
      return;
    } catch (error) {
      const { code, data } = error as { code?: string; data?: { filepaths?: string[] } };
      if (code !== "CheckoutConflictError" || !data?.filepaths) {
        throw error;
      }

      const stamp = new Date();
      for (const filepath of data.filepaths) {
        const local = await this.app.vault.adapter.readBinary(filepath);
        await this.app.vault.adapter.writeBinary(conflictCopyPath(filepath, stamp), local);
        conflicts.push(filepath);
      }
      // Only force the conflicting paths; everything else keeps its local edits.
      await git.checkout({ ...repo, ref: branch, force: true, filepaths: data.filepaths });
      await git.checkout({ ...repo, ref: branch });
    }
  }

  private async pushWithRetry(
    repo: GitRepoParams,
    branch: string,
    conflicts: string[],
  ): Promise<void> {
    try {
      await this.push(repo, branch);
    } catch {
      // Someone pushed in between; integrate and try once more.
      await this.pull(repo, branch, conflicts);
      await this.push(repo, branch);
    }
  }

  private async push(repo: GitRepoParams, branch: string): Promise<void> {
    const result = await git.push({
      ...repo,
      remote: this.settings.remoteName,
      ref: branch,
      remoteRef: branch,
    });
    if (!result.ok) {
      throw new Error(result.error || "Push was rejected.");
    }
  }

  /** Stages every change outside excluded folders and commits. Returns whether a commit was made. */
  private async commitAll(repo: GitRepoParams, message: string): Promise<boolean> {
    const FILE = 0;
    const HEAD = 1;
    const WORKDIR = 2;
    const STAGE = 3;

    const matrix = await git.statusMatrix({
      ...repo,
      filter: (filepath) => !this.isExcludedFromStaging(filepath),
    });

    const toAdd: string[] = [];
    const toRemove: string[] = [];
    let changed = false;
    for (const row of matrix) {
      const filepath = row[FILE];
      if (this.isExcludedFromStaging(filepath)) continue;

      if (row[WORKDIR] !== row[STAGE]) {
        if (row[WORKDIR] === 0) {
          toRemove.push(filepath);
        } else {
          toAdd.push(filepath);
        }
      }
      // After staging, the index matches the workdir; it differs from HEAD unless the file is
      // unchanged (1,1) or absent from both (0,0).
      const unchanged =
        (row[HEAD] === 1 && row[WORKDIR] === 1) || (row[HEAD] === 0 && row[WORKDIR] === 0);
      if (!unchanged) {
        changed = true;
      }
    }

    if (toAdd.length > 0) {
      await git.add({ ...repo, filepath: toAdd });
    }
    for (const filepath of toRemove) {
      await git.remove({ ...repo, filepath });
    }
    if (!changed) {
      return false;
    }

    await git.commit({ ...repo, message, author: this.syncAuthor() });
    return true;
  }

  private isExcludedFromStaging(filepath: string): boolean {
    const p = filepath.replace(/^\/+/, "").replace(/^\.\//, "");
    return (
      p === ".obsidian" || p.startsWith(".obsidian/") || p === ".trash" || p.startsWith(".trash/")
    );
  }

  private syncAuthor(): { name: string; email: string } {
    const name = this.settings.username || "obsidian-user";
    return {
      name,
      email: `${this.settings.username || "obsidian"}@users.noreply.github.com`,
    };
  }
}
