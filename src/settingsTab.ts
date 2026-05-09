import { PluginSettingTab, Setting } from "obsidian";
import type AutoGitSyncPlugin from "./main";

export class AutoGitSyncSettingTab extends PluginSettingTab {
  private readonly plugin: AutoGitSyncPlugin;

  constructor(plugin: AutoGitSyncPlugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Git Sync" });

    new Setting(containerEl)
      .setName("Remote name")
      .setDesc("Git remote name, usually origin.")
      .addText((text) =>
        text
          .setPlaceholder("origin")
          .setValue(this.plugin.settings.remoteName)
          .onChange(async (value) => {
            this.plugin.settings.remoteName = value.trim() || "origin";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Branch")
      .setDesc("Branch to sync.")
      .addText((text) =>
        text
          .setPlaceholder("main")
          .setValue(this.plugin.settings.branch)
          .onChange(async (value) => {
            this.plugin.settings.branch = value.trim() || "main";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Remote URL")
      .setDesc("Required on mobile. Desktop can use the remote already configured in local Git.")
      .addText((text) =>
        text
          .setPlaceholder("https://github.com/user/repo.git")
          .setValue(this.plugin.settings.remoteUrl)
          .onChange(async (value) => {
            this.plugin.settings.remoteUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Remote username")
      .setDesc("Used only on mobile for HTTPS GitHub sync.")
      .addText((text) =>
        text.setValue(this.plugin.settings.username).onChange(async (value) => {
          this.plugin.settings.username = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Remote access token")
      .setDesc("Used only on mobile. Desktop uses your local Git credentials.")
      .addText((text) =>
        text.setValue(this.plugin.settings.passwordOrToken).onChange(async (value) => {
          this.plugin.settings.passwordOrToken = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Sync debounce (ms)")
      .setDesc("Wait this long after file changes before syncing.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.syncDebounceMs)).onChange(async (value) => {
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed >= 500) {
            this.plugin.settings.syncDebounceMs = parsed;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Run one manual sync to verify credentials and remote.")
      .addButton((button) =>
        button
          .setButtonText("Run")
          .setCta()
          .onClick(async () => {
            await this.plugin.syncNow("manual");
          }),
      );
  }
}
