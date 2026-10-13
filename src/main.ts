import "./bufferGlobal";
import { debounce, type Debouncer, Notice, Platform, Plugin } from "obsidian";
import { DesktopGitBackend } from "./desktopGitBackend";
import type { GitBackend, SyncMode } from "./gitBackend";
import { MobileGitBackend } from "./mobileGitBackend";
import { AutoGitSyncSettingTab } from "./settingsTab";
import { DEFAULT_SETTINGS, type AutoGitSyncSettings } from "./types";

type SyncRequest = { mode: SyncMode; trigger: string };

/** Triggers initiated explicitly by the user: always report the outcome. */
const MANUAL_TRIGGERS = new Set(["command", "manual"]);

export default class AutoGitSyncPlugin extends Plugin {
  public settings: AutoGitSyncSettings = DEFAULT_SETTINGS;

  private gitBackend: GitBackend | null = null;
  private isSyncing = false;
  private pendingSync: SyncRequest | null = null;
  private debouncedSync: Debouncer<[], void> | null = null;
  private debounceWait = 0;
  private pullIntervalId: number | null = null;
  private lastErrorMessage: string | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.rebuildDebouncer();

    this.addSettingTab(new AutoGitSyncSettingTab(this));
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => {
        void this.syncNow("command");
      },
    });

    // Obsidian emits a `create` event for every file while indexing the vault on startup;
    // only start listening once the layout is ready.
    this.app.workspace.onLayoutReady(() => {
      const onVaultChange = () => this.debouncedSync?.();
      this.registerEvent(this.app.vault.on("create", onVaultChange));
      this.registerEvent(this.app.vault.on("modify", onVaultChange));
      this.registerEvent(this.app.vault.on("delete", onVaultChange));
      this.registerEvent(this.app.vault.on("rename", onVaultChange));

      this.registerDomEvent(document, "visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          // Mobile apps may be suspended in the background: push pending edits now.
          this.debouncedSync?.run();
        } else {
          void this.queueSync({ mode: "full", trigger: "resume" });
        }
      });

      this.restartPullInterval();
      void this.queueSync({ mode: "full", trigger: "startup" });
    });
  }

  onunload(): void {
    this.debouncedSync?.cancel();
    this.stopPullInterval();
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<AutoGitSyncSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...data };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    // Recreated lazily on the next sync so it picks up the new settings.
    this.gitBackend = null;
    this.rebuildDebouncer();
    if (this.app.workspace.layoutReady) {
      this.restartPullInterval();
    }
  }

  async syncNow(trigger: string): Promise<void> {
    await this.queueSync({ mode: "full", trigger });
  }

  private rebuildDebouncer(): void {
    const wait = Math.max(500, this.settings.syncDebounceMs);
    if (this.debouncedSync && wait === this.debounceWait) {
      return;
    }

    // Flush anything pending on the old debouncer rather than dropping it.
    this.debouncedSync?.run();
    this.debounceWait = wait;
    this.debouncedSync = debounce(
      () => {
        void this.queueSync({ mode: "local", trigger: "vault-change" });
      },
      wait,
      true,
    );
  }

  private restartPullInterval(): void {
    this.stopPullInterval();
    const minutes = this.settings.pullIntervalMinutes;
    if (minutes > 0) {
      this.pullIntervalId = window.setInterval(() => {
        void this.queueSync({ mode: "full", trigger: "interval" });
      }, minutes * 60_000);
    }
  }

  private stopPullInterval(): void {
    if (this.pullIntervalId !== null) {
      window.clearInterval(this.pullIntervalId);
      this.pullIntervalId = null;
    }
  }

  private createGitBackend(): GitBackend {
    if (Platform.isDesktopApp) {
      return new DesktopGitBackend(this.app, this.settings);
    }
    return new MobileGitBackend(this.app, this.settings);
  }

  /** Requests are coalesced: at most one sync runs, and at most one more is queued behind it. */
  private async queueSync(request: SyncRequest): Promise<void> {
    this.pendingSync = this.pendingSync
      ? {
          mode: this.pendingSync.mode === "full" || request.mode === "full" ? "full" : "local",
          trigger: MANUAL_TRIGGERS.has(this.pendingSync.trigger)
            ? this.pendingSync.trigger
            : request.trigger,
        }
      : request;

    if (this.isSyncing) {
      return;
    }

    this.isSyncing = true;
    try {
      while (this.pendingSync) {
        const next = this.pendingSync;
        this.pendingSync = null;
        await this.syncOnce(next);
      }
    } finally {
      this.isSyncing = false;
    }
  }

  private async syncOnce({ mode, trigger }: SyncRequest): Promise<void> {
    const manual = MANUAL_TRIGGERS.has(trigger);
    try {
      this.gitBackend ??= this.createGitBackend();
      const result = await this.gitBackend.sync(mode, trigger);
      this.lastErrorMessage = null;

      if (manual) {
        new Notice(`Git Sync: ${result.message}`);
      } else if (result.conflicts.length > 0) {
        new Notice(`Git Sync: ${result.message}\n${result.conflicts.join("\n")}`, 10_000);
      }
    } catch (error) {
      console.error("Git Sync failed", error);
      const message = error instanceof Error ? error.message : String(error);
      // Don't spam the same error on every automatic sync (e.g. while offline).
      if (manual || message !== this.lastErrorMessage) {
        new Notice(`Git Sync failed: ${message}`);
      }
      this.lastErrorMessage = message;
    }
  }
}
