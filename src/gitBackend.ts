export type SyncMode = "startup" | "full";

export type SyncResult = {
  pulled: boolean;
  committed: boolean;
  pushed: boolean;
  message: string;
};

export interface GitBackend {
  sync(mode: SyncMode, trigger: string): Promise<SyncResult>;
}

export function createNoopResult(message: string): SyncResult {
  return {
    pulled: false,
    committed: false,
    pushed: false,
    message,
  };
}
