import "./bufferGlobal";
import { debounce, Notice, Platform, Plugin } from "obsidian";
import { DesktopGitBackend } from "./desktopGitBackend";
import type { GitBackend, SyncMode } from "./gitBackend";
import { MobileGitBackend } from "./mobileGitBackend";
import { AutoGitSyncSettingTab } from "./settingsTab";
import { DEFAULT_SETTINGS, type AutoGitSyncSettings } from "./types";

export default class AutoGitSyncPlugin extends Plugin {
  public settings: AutoGitSyncSettings = DEFAULT_SETTINGS;

  private gitBackend: GitBackend | null = null;
  private isSyncing = false;
  private pendingSync: { mode: SyncMode; trigger: string } | null = null;
  private skipEventsUntil = 0;
  private debouncedSync: () => void = () => undefined;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.gitBackend = this.createGitBackend();
    this.rebuildDebouncer();

    this.addSettingTab(new AutoGitSyncSettingTab(this));
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void this.syncNow("command");
      },
    });

    void this.queueSync("startup", "startup");

    const onVaultChange = () => {
      if (Date.now() < this.skipEventsUntil) {
        return;
      }
      this.debouncedSync();
    };

    this.registerEvent(this.app.vault.on("create", onVaultChange));
    this.registerEvent(this.app.vault.on("modify", onVaultChange));
    this.registerEvent(this.app.vault.on("delete", onVaultChange));
    this.registerEvent(this.app.vault.on("rename", onVaultChange));
  }

  onunload(): void {
    this.debouncedSync = () => undefined;
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<AutoGitSyncSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...data };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.gitBackend = this.createGitBackend();
    this.rebuildDebouncer();
  }

  async syncNow(trigger: string): Promise<void> {
    await this.queueSync("full", trigger);
  }

  private rebuildDebouncer(): void {
    const wait = Math.max(500, this.settings.syncDebounceMs);
    this.debouncedSync = debounce(
      () => {
        void this.queueSync("full", "vault-change");
      },
      wait,
      true,
    );
  }

  private createGitBackend(): GitBackend {
    if (Platform.isDesktopApp) {
      return new DesktopGitBackend(this.app, this.settings);
    }
    return new MobileGitBackend(this.app, this.settings);
  }

  private async queueSync(mode: SyncMode, trigger: string): Promise<void> {
    this.pendingSync = this.mergePendingSync(this.pendingSync, { mode, trigger });
    await this.runSyncLoop();
  }

  private mergePendingSync(
    current: { mode: SyncMode; trigger: string } | null,
    next: { mode: SyncMode; trigger: string },
  ): { mode: SyncMode; trigger: string } {
    if (!current) {
      return next;
    }

    return {
      mode: current.mode === "full" || next.mode === "full" ? "full" : "startup",
      trigger: next.trigger,
    };
  }

  private async runSyncLoop(): Promise<void> {
    if (this.isSyncing) {
      return;
    }

    this.isSyncing = true;
    try {
      while (this.pendingSync) {
        const syncRequest = this.pendingSync;
        this.pendingSync = null;
        await this.syncOnce(syncRequest.mode, syncRequest.trigger);
      }
    } finally {
      this.isSyncing = false;
    }
  }

  private async syncOnce(mode: SyncMode, trigger: string): Promise<void> {
    try {
      if (!this.gitBackend) {
        this.gitBackend = this.createGitBackend();
      }

      this.skipEventsUntil = Date.now() + Math.max(1500, this.settings.syncDebounceMs / 2);
      const result = await this.gitBackend.sync(mode, trigger);
      this.skipEventsUntil = Date.now() + Math.max(1500, this.settings.syncDebounceMs / 2);
      if (this.isManualSuccessNoticeTrigger(trigger)) {
        new Notice(`Git Sync: ${result.message}`);
      }
    } catch (error) {
      console.error("Git Sync failed", error);
      new Notice(`Git Sync failed: ${this.getErrorMessage(error)}`);
    }
  }

  /** Success toasts only for explicit user actions (command palette / settings). */
  private isManualSuccessNoticeTrigger(trigger: string): boolean {
    return trigger === "command" || trigger === "manual";
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
