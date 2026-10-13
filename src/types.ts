export interface AutoGitSyncSettings {
  remoteName: string;
  remoteUrl: string;
  branch: string;
  username: string;
  passwordOrToken: string;
  syncDebounceMs: number;
  /** Periodic pull interval in minutes. 0 disables it. */
  pullIntervalMinutes: number;
}

export const DEFAULT_SETTINGS: AutoGitSyncSettings = {
  remoteName: "origin",
  remoteUrl: "",
  branch: "main",
  username: "",
  passwordOrToken: "",
  syncDebounceMs: 1000 * 30,
  pullIntervalMinutes: 5,
};
