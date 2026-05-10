import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import type { App } from "obsidian";
import type { GitBackend, SyncMode, SyncResult } from "./gitBackend";
import type { AutoGitSyncSettings } from "./types";
import { VaultFsAdapter } from "./vaultFsAdapter";

const DEFAULT_CORS_PROXY = "https://cors.isomorphic-git.org";

type GitRepoParams = {
  fs: VaultFsAdapter;
  dir: string;
  gitdir: string;
  http: typeof http;
  onAuth: () => { username?: string; password?: string };
};

export class MobileGitBackend implements GitBackend {
  private readonly fs: VaultFsAdapter;

  constructor(
    private readonly app: App,
    private readonly settings: AutoGitSyncSettings,
    private readonly onSetupComplete: () => Promise<void>,
  ) {
    this.fs = new VaultFsAdapter(app.vault);
  }

  async sync(_mode: SyncMode, trigger: string): Promise<SyncResult> {
    const repo = this.getRepoParams();

    if (!this.settings.mobileSetupComplete) {
      return this.initializeMobileRepository(repo, trigger);
    }

    await this.ensureRepository(repo);
    await this.ensureRemote(repo);

    const branch = await this.getOrCreateBranch(repo);
    await this.ensureRemoteCheckoutIfLocalIsEmpty(repo, branch);

    const hasChanges = await this.stageAll(repo);
    let committed = false;

    if (!hasChanges) {
      const pulled = await this.pull(repo, branch);
      return {
        pulled,
        committed: false,
        pushed: false,
        message: pulled ? "Pulled latest changes." : "Already up to date.",
      };
    }

    await git.commit({
      ...repo,
      message: this.createCommitMessage(trigger),
      author: this.syncAuthor(),
    });
    committed = true;

    const pulled = await this.pull(repo, branch);
    await this.pushWithRetry(repo, branch);

    return {
      pulled,
      committed,
      pushed: true,
      message: "Committed and pushed vault changes.",
    };
  }

  private async initializeMobileRepository(
    repo: GitRepoParams,
    trigger: string,
  ): Promise<SyncResult> {
    const hadLocalContent = await this.hasLocalContent();

    await this.ensureRepository(repo);
    await this.ensureRemote(repo);

    const branch = await this.getOrCreateBranch(repo);
    await this.fetch(repo);

    const hasRemoteBranch = await this.hasRemoteBranch(repo, branch);
    if (!hasRemoteBranch) {
      const committed = await this.commitLocalChanges(repo, trigger);
      if (committed) {
        await this.push(repo, branch);
      }
      await this.completeSetup();
      return {
        pulled: false,
        committed,
        pushed: committed,
        message: committed
          ? "Initialized mobile repo and published local vault."
          : "Initialized mobile repo. Add files to publish.",
      };
    }

    if (!hadLocalContent) {
      await this.checkoutRemoteBranch(repo, branch);
      await this.ensureRemoteFilesWereCheckedOut(repo, branch);
      await this.completeSetup();
      return {
        pulled: true,
        committed: false,
        pushed: false,
        message: "Initialized mobile repo from remote.",
      };
    }

    const committed = await this.commitLocalChanges(repo, trigger);
    const pulled = await this.mergeRemoteBranch(repo, branch);
    await this.pushWithRetry(repo, branch);
    await this.completeSetup();

    return {
      pulled,
      committed,
      pushed: true,
      message: "Initialized mobile repo by merging remote with local vault.",
    };
  }

  private getRepoParams(): GitRepoParams {
    return {
      fs: this.fs,
      dir: "/",
      gitdir: "/.git",
      http,
      onAuth: () => ({
        username: this.settings.username || undefined,
        password: this.settings.passwordOrToken || undefined,
      }),
    };
  }

  private async ensureRepository(repo: GitRepoParams): Promise<void> {
    const gitHeadExists = await this.app.vault.adapter.exists("/.git/HEAD");
    if (!gitHeadExists) {
      await git.init({
        fs: repo.fs,
        dir: repo.dir,
        gitdir: repo.gitdir,
        defaultBranch: this.settings.branch || "main",
      });
    }
  }

  private async ensureRemote(repo: GitRepoParams): Promise<void> {
    if (!this.settings.remoteUrl) {
      throw new Error("Set a remote URL before syncing on mobile.");
    }

    const remotes = await git.listRemotes(repo);
    const existing = remotes.find((remote) => remote.remote === this.settings.remoteName);
    if (!existing) {
      await git.addRemote({
        ...repo,
        remote: this.settings.remoteName,
        url: this.settings.remoteUrl,
        force: true,
      });
      return;
    }

    if (existing.url !== this.settings.remoteUrl) {
      await git.deleteRemote({ ...repo, remote: this.settings.remoteName });
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

  private async pull(repo: GitRepoParams, branch: string): Promise<boolean> {
    await this.fetch(repo);

    if (!(await this.hasRemoteBranch(repo, branch))) {
      return false;
    }

    return this.mergeRemoteBranch(repo, branch);
  }

  private async fetch(repo: GitRepoParams): Promise<void> {
    await git.fetch({
      ...repo,
      remote: this.settings.remoteName,
      corsProxy: DEFAULT_CORS_PROXY,
    });
  }

  private async hasRemoteBranch(repo: GitRepoParams, branch: string): Promise<boolean> {
    const remoteBranches = await git.listBranches({ ...repo, remote: this.settings.remoteName });
    return remoteBranches.includes(branch);
  }

  private async mergeRemoteBranch(repo: GitRepoParams, branch: string): Promise<boolean> {
    await git.merge({
      ...repo,
      ours: branch,
      theirs: `${this.settings.remoteName}/${branch}`,
      fastForwardOnly: false,
      allowUnrelatedHistories: true,
      author: this.syncAuthor(),
      committer: this.syncAuthor(),
    });
    return true;
  }

  private async checkoutRemoteBranch(repo: GitRepoParams, branch: string): Promise<void> {
    const remoteRef = `${this.settings.remoteName}/${branch}`;
    const remoteOid = await git.resolveRef({ ...repo, ref: remoteRef });

    await git.writeRef({
      ...repo,
      ref: `refs/heads/${branch}`,
      value: remoteOid,
      force: true,
    });
    await git.checkout({ ...repo, ref: branch, force: true });
  }

  private async ensureRemoteCheckoutIfLocalIsEmpty(
    repo: GitRepoParams,
    branch: string,
  ): Promise<void> {
    await this.fetch(repo);

    if (!(await this.hasRemoteBranch(repo, branch))) {
      return;
    }

    if (await this.hasLocalHeadCommit(repo)) {
      return;
    }

    if (await this.hasLocalContent()) {
      return;
    }

    await this.checkoutRemoteBranch(repo, branch);
    await this.ensureRemoteFilesWereCheckedOut(repo, branch);
    await this.completeSetup();
  }

  private async hasLocalHeadCommit(repo: GitRepoParams): Promise<boolean> {
    try {
      await git.resolveRef({ ...repo, ref: "HEAD" });
      return true;
    } catch {
      return false;
    }
  }

  private async ensureRemoteFilesWereCheckedOut(
    repo: GitRepoParams,
    branch: string,
  ): Promise<void> {
    const remoteFiles = await this.listRemoteFiles(repo, branch);
    if (remoteFiles.length === 0) {
      return;
    }

    const missingFiles = [];
    for (const filepath of remoteFiles) {
      if (!(await this.app.vault.adapter.exists(filepath))) {
        missingFiles.push(filepath);
      }
    }

    if (missingFiles.length > 0) {
      throw new Error(
        `Remote checkout did not write ${missingFiles.length} file(s). First missing file: ${missingFiles[0]}`,
      );
    }
  }

  private async listRemoteFiles(repo: GitRepoParams, branch: string): Promise<string[]> {
    const remoteRef = `${this.settings.remoteName}/${branch}`;
    const oid = await git.resolveRef({ ...repo, ref: remoteRef });
    const files: string[] = [];

    await git.walk({
      ...repo,
      trees: [git.TREE({ ref: oid })],
      map: async (filepath, [entry]) => {
        if (filepath === "." || !entry) {
          return;
        }

        if ((await entry.type()) === "blob") {
          files.push(filepath);
        }
      },
    });

    return files;
  }

  private async pushWithRetry(repo: GitRepoParams, branch: string): Promise<void> {
    try {
      await this.push(repo, branch);
    } catch {
      await this.pull(repo, branch);
      await this.push(repo, branch);
    }
  }

  private async push(repo: GitRepoParams, branch: string): Promise<void> {
    await git.push({
      ...repo,
      remote: this.settings.remoteName,
      ref: branch,
      corsProxy: DEFAULT_CORS_PROXY,
    });
  }

  private async stageAll(repo: GitRepoParams): Promise<boolean> {
    const matrix = await git.statusMatrix(repo);
    let changed = false;

    for (const [filepath, head, workdir] of matrix) {
      if (head === 1 && workdir === 0) {
        await git.remove({ ...repo, filepath });
        changed = true;
        continue;
      }

      if ((head === 1 && workdir === 2) || (head === 0 && workdir === 2)) {
        await git.add({ ...repo, filepath });
        changed = true;
      }
    }

    return changed;
  }

  private async commitLocalChanges(repo: GitRepoParams, trigger: string): Promise<boolean> {
    const hasChanges = await this.stageAll(repo);
    if (!hasChanges) {
      return false;
    }

    await git.commit({
      ...repo,
      message: this.createCommitMessage(trigger),
      author: this.syncAuthor(),
    });
    return true;
  }

  private async hasLocalContent(path = "/"): Promise<boolean> {
    const list = await this.app.vault.adapter.list(path);
    const entries = [...list.files, ...list.folders].filter(
      (entry) => !this.isIgnoredSetupPath(entry),
    );

    for (const entry of entries) {
      const stat = await this.app.vault.adapter.stat(entry);
      if (!stat) {
        continue;
      }

      if (stat.type === "file") {
        return true;
      }

      if (await this.hasLocalContent(entry)) {
        return true;
      }
    }

    return false;
  }

  private isIgnoredSetupPath(path: string): boolean {
    return path === "/.git" || path.startsWith("/.git/") || path === "/.obsidian";
  }

  private async completeSetup(): Promise<void> {
    this.settings.mobileSetupComplete = true;
    await this.onSetupComplete();
  }

  private createCommitMessage(trigger: string): string {
    return `vault sync: ${trigger} @ ${new Date().toISOString()}`;
  }

  private syncAuthor(): { name: string; email: string } {
    const name = this.settings.username || "obsidian-user";
    return {
      name,
      email: `${this.settings.username || "obsidian"}@users.noreply.github.com`,
    };
  }
}
