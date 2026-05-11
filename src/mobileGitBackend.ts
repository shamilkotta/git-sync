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
  ) {
    this.fs = new VaultFsAdapter(app.vault);
  }

  async sync(_mode: SyncMode, trigger: string): Promise<SyncResult> {
    const repo = this.getRepoParams();

    await this.ensureRepository(repo);

    const branch = await this.getOrCreateBranch(repo);

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
    const localCommits = await this.listCommitOids(repo, branch);
    if (localCommits.length === 0) {
      await this.createLocalBranchFromRemote(repo, branch);
      return true;
    }

    await git.merge({
      ...repo,
      ours: branch,
      theirs: `${this.settings.remoteName}/${branch}`,
      fastForwardOnly: false,
      allowUnrelatedHistories: true,
      author: this.syncAuthor(),
      committer: this.syncAuthor(),
    });

    await git.checkout({
      ...repo,
      ref: branch,
      force: true,
    });
    return true;
  }

  private async createLocalBranchFromRemote(repo: GitRepoParams, branch: string): Promise<void> {
    const remoteRef = `refs/remotes/${this.settings.remoteName}/${branch}`;
    const remoteOid = await git.resolveRef({
      ...repo,
      ref: remoteRef,
    });

    await git.writeRef({
      ...repo,
      ref: `refs/heads/${branch}`,
      value: remoteOid,
      force: true,
    });

    await git.checkout({
      ...repo,
      ref: branch,
      force: true,
    });
  }

  private async listCommitOids(repo: GitRepoParams, ref: string): Promise<string[]> {
    try {
      const commits = await git.log({ ...repo, ref });
      return commits.map((commit) => commit.oid);
    } catch {
      return [];
    }
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

    const FILE = 0;
    const WORKDIR = 2;
    const STAGE = 3;

    for (const row of matrix) {
      const filepath = row[FILE];
      if (this.isExcludedFromStaging(filepath)) {
        continue;
      }

      if (row[WORKDIR] === row[STAGE]) {
        continue;
      }

      if (row[WORKDIR] === 0) {
        await git.remove({ ...repo, filepath });
      } else {
        await git.add({ ...repo, filepath });
      }
      changed = true;
    }

    return changed;
  }

  private isExcludedFromStaging(filepath: string): boolean {
    const p = filepath.replace(/^\/+/, "").replace(/^\.\//, "");
    return (
      p === ".obsidian" || p.startsWith(".obsidian/") || p === ".trash" || p.startsWith(".trash/")
    );
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
