export interface AutoGitSyncSettings {
  remoteName: string;
  remoteUrl: string;
  branch: string;
  username: string;
  passwordOrToken: string;
  syncDebounceMs: number;
}

export const DEFAULT_SETTINGS: AutoGitSyncSettings = {
  remoteName: "origin",
  remoteUrl: "",
  branch: "main",
  username: "",
  passwordOrToken: "",
  syncDebounceMs: 1000 * 30,
};
