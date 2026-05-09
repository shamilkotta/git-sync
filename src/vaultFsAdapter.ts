import type { DataAdapter, Vault } from "obsidian";
import { TFile, normalizePath } from "obsidian";

type GitStat = {
  ctimeMs: number;
  mtimeMs: number;
  size: number;
  type: "file" | "directory";
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
};

export class VaultFsAdapter {
  public readonly promises: Record<string, (...args: any[]) => any>;
  private readonly adapter: DataAdapter;
  private readonly vault: Vault;

  constructor(vault: Vault) {
    this.vault = vault;
    this.adapter = vault.adapter;
    this.promises = {
      readFile: this.readFile.bind(this),
      writeFile: this.writeFile.bind(this),
      readdir: this.readdir.bind(this),
      mkdir: this.mkdir.bind(this),
      rmdir: this.rmdir.bind(this),
      stat: this.stat.bind(this),
      unlink: this.unlink.bind(this),
      lstat: this.lstat.bind(this),
      readlink: this.readlink.bind(this),
      symlink: this.symlink.bind(this),
    };
  }

  async readFile(
    path: string,
    options?: { encoding?: string } | string,
  ): Promise<string | ArrayBuffer> {
    const wantsUtf8 =
      options === "utf8" ||
      (typeof options === "object" && options !== null && options.encoding === "utf8");
    const file = this.vault.getAbstractFileByPath(path);

    if (wantsUtf8) {
      return file instanceof TFile ? this.vault.read(file) : this.adapter.read(path);
    }

    return file instanceof TFile ? this.vault.readBinary(file) : this.adapter.readBinary(path);
  }

  async writeFile(path: string, data: string | ArrayBuffer): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (typeof data === "string") {
      if (file instanceof TFile) {
        await this.vault.modify(file, data);
      } else {
        await this.adapter.write(path, data);
      }
      return;
    }

    if (file instanceof TFile) {
      await this.vault.modifyBinary(file, data);
    } else {
      await this.adapter.writeBinary(path, data);
    }
  }

  async readdir(path: string): Promise<string[]> {
    const targetPath = path === "." ? "/" : path;
    const list = await this.adapter.list(targetPath);
    const all = [...list.files, ...list.folders];
    if (targetPath === "/") {
      return all;
    }
    return all.map((entry) => normalizePath(entry.substring(targetPath.length)));
  }

  async mkdir(path: string): Promise<void> {
    await this.adapter.mkdir(path);
  }

  async rmdir(
    path: string,
    options?: { recursive?: boolean; options?: { recursive?: boolean } },
  ): Promise<void> {
    const recursive = options?.recursive ?? options?.options?.recursive ?? false;
    await this.adapter.rmdir(path, recursive);
  }

  async stat(path: string): Promise<GitStat> {
    const targetPath = path === "." ? "/" : path;
    const file = this.vault.getAbstractFileByPath(targetPath);
    if (file instanceof TFile) {
      return {
        ctimeMs: file.stat.ctime,
        mtimeMs: file.stat.mtime,
        size: file.stat.size,
        type: "file",
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      };
    }

    const stat = await this.adapter.stat(targetPath);
    if (!stat) {
      throw { code: "ENOENT" };
    }

    const isDirectory = stat.type === "folder";
    return {
      ctimeMs: stat.ctime,
      mtimeMs: stat.mtime,
      size: stat.size,
      type: isDirectory ? "directory" : "file",
      isFile: () => !isDirectory,
      isDirectory: () => isDirectory,
      isSymbolicLink: () => false,
    };
  }

  async unlink(path: string): Promise<void> {
    await this.adapter.remove(path);
  }

  async lstat(path: string): Promise<GitStat> {
    return this.stat(path);
  }

  async readlink(path: string): Promise<string> {
    throw new Error(`readlink not implemented for ${path}`);
  }

  async symlink(path: string): Promise<void> {
    throw new Error(`symlink not implemented for ${path}`);
  }
}
