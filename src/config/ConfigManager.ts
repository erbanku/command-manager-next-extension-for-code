import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CommandConfig, TimeTrackerConfig } from '../types';
import { getDefaultConfig, validateConfig, getDefaultTimeTrackerConfig, validateTimeTrackerConfig } from './schema';

export class ConfigManager {
  private static instance: ConfigManager | undefined;
  private config: CommandConfig;
  private configPath: string;
  private watcher?: vscode.FileSystemWatcher;
  private onConfigChangeCallbacks: Array<() => void> = [];
  private timeTrackerConfig: TimeTrackerConfig;
  private timeTrackerConfigPath: string;
  private timeTrackerWatcher?: vscode.FileSystemWatcher;
  private onTimeTrackerChangeCallbacks: Array<() => void> = [];
  private pendingMigratedTimeTracker?: TimeTrackerConfig;
  private legacyConfigPath: string;
  private legacyTimeTrackerPath: string;

  private constructor() {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const overrideRoot = process.env.COMMAND_MANAGER_CONFIG_ROOT;
    const baseDir = overrideRoot ? path.resolve(overrideRoot) : path.join(workspaceRoot, '.vscode');
    const commandsDir = path.join(baseDir, 'commands');
    this.configPath = path.join(commandsDir, 'commands.json');
    this.timeTrackerConfigPath = path.join(commandsDir, 'commands-timer.json');
    this.legacyConfigPath = path.join(baseDir, 'commands.json');
    this.legacyTimeTrackerPath = path.join(baseDir, 'commands-timer.json');
    this.config = getDefaultConfig();
    this.timeTrackerConfig = getDefaultTimeTrackerConfig();
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  public async initialize(): Promise<void> {
    // Prime in-memory caches from disk so downstream consumers have data immediately.
    await this.loadConfig();
    await this.loadTimeTrackerConfig();
    // Watch the files so live edits stay in sync without manual reloads.
    this.setupFileWatcher();
    this.setupTimeTrackerFileWatcher();
    // Ensure initial consumers refresh with loaded config
    this.notifyConfigChange();
    this.notifyTimeTrackerChange();
  }

  public getConfig(): CommandConfig {
    return this.config;
  }

  public async saveConfig(config: CommandConfig): Promise<void> {
    const validation = validateConfig(config);
    if (!validation.valid) {
      throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
    }

    // Update version and timestamp
    const version = (this.config.version || 0) + 1;
    config.version = version;
    config.lastModified = new Date().toISOString();

    await this.writeCommandsConfigToDisk(config);
    this.config = config;
    this.notifyConfigChange();
  }

  public async loadConfig(): Promise<void> {
    try {
      await this.ensureCommandsDirectoryExists();
      await this.migrateLegacyConfigIfNeeded();
      if (fs.existsSync(this.configPath)) {
        const configData = await fs.promises.readFile(this.configPath, 'utf8');
        const parsedConfig = JSON.parse(configData);

        let extractedTimeTracker: TimeTrackerConfig | undefined;
        if (parsedConfig.timeTracker) {
          extractedTimeTracker = parsedConfig.timeTracker;
          delete parsedConfig.timeTracker;
        }

        const validation = validateConfig(parsedConfig);
        
        if (validation.valid) {
          // Success path: keep the parsed data and normalise optional arrays.
          this.config = parsedConfig;
          // Ensure testRunners array exists (empty array is valid - user can delete default config)
          if (!this.config.testRunners) {
            this.config.testRunners = [];
          }
          // Ensure pinnedCommands array exists
          if (!this.config.pinnedCommands) {
            this.config.pinnedCommands = [];
          }

          if (extractedTimeTracker) {
            // Stash migrated data so the time-tracker loader can persist it into the new file.
            this.pendingMigratedTimeTracker = extractedTimeTracker;
            await this.writeCommandsConfigToDisk(this.config);
          }
        } else {
          // Validation failure: surface a warning and revert to a safe default config.
          vscode.window.showWarningMessage(
            `Invalid configuration file: ${validation.errors.join(', ')}. Using default configuration.`
          );
          this.config = getDefaultConfig();
          await this.writeCommandsConfigToDisk(this.config);
        }
      } else {
        // Create default config file
        this.config = getDefaultConfig();
        await this.writeCommandsConfigToDisk(this.config);
      }
    } catch (error) {
      // Parse/IO errors: notify the user, reset to defaults, and rewrite the file so the next load succeeds.
      vscode.window.showErrorMessage(`Failed to load configuration: ${error}`);
      this.config = getDefaultConfig();
      await this.writeCommandsConfigToDisk(this.config);
    }
  }

  private async loadTimeTrackerConfig(): Promise<void> {
    try {
      if (this.pendingMigratedTimeTracker) {
        // First activation after migration: merge and persist into the dedicated file.
        this.timeTrackerConfig = this.mergeWithDefaultTimeTracker(this.pendingMigratedTimeTracker);
        this.pendingMigratedTimeTracker = undefined;
        await this.saveTimeTrackerConfig(this.timeTrackerConfig, { suppressNotification: true });
        await this.writeTimeTrackerBackup();
        return;
      }

      await this.ensureCommandsDirectoryExists();
      await this.migrateLegacyTimeTrackerIfNeeded();

      const fileExists = fs.existsSync(this.timeTrackerConfigPath);
      
      if (!fileExists) {
        // Only create file if it doesn't exist at all - never recreate on failure
        this.timeTrackerConfig = getDefaultTimeTrackerConfig();
        await this.saveTimeTrackerConfig(this.timeTrackerConfig, { suppressNotification: true });
        await this.writeTimeTrackerBackup();
        return;
      }

      // File exists - try to load it
      const configData = await fs.promises.readFile(this.timeTrackerConfigPath, 'utf8');

      if (!configData.trim()) {
        // Empty file usually means a crash or interrupted save; attempt recovery from backup.
        if (await this.attemptRestoreTimeTrackerConfigFromBackup('Time tracker configuration file was empty. Restored from backup file.')) {
          return;
        }
        vscode.window.showWarningMessage('Time tracker configuration file is empty and no backup was found. Using defaults in memory; the file was left untouched so you can recover it manually.');
        this.timeTrackerConfig = getDefaultTimeTrackerConfig();
        return;
      }

      let parsedConfig: TimeTrackerConfig;
      try {
        parsedConfig = JSON.parse(configData);
      } catch (parseError) {
        // Corrupted JSON: try the backup before falling back.
        if (await this.attemptRestoreTimeTrackerConfigFromBackup('Time tracker configuration file was corrupted. Restored from backup file.')) {
          return;
        }
        vscode.window.showErrorMessage('Failed to parse time tracker configuration and no backup was found. Using defaults in memory; the file was left untouched so you can recover it manually.');
        this.timeTrackerConfig = getDefaultTimeTrackerConfig();
        return;
      }

      const validation = validateTimeTrackerConfig(parsedConfig);

      if (validation.valid) {
        // Success: ensure optional properties exist and keep the results.
        this.timeTrackerConfig = this.mergeWithDefaultTimeTracker(parsedConfig);
        await this.writeTimeTrackerBackup();
        return;
      }

      // Invalid structure: prefer backup recovery; otherwise fall back without touching disk.
      if (await this.attemptRestoreTimeTrackerConfigFromBackup('Invalid time tracker configuration detected. Restored from backup file.')) {
        return;
      }
      vscode.window.showWarningMessage(
        `Invalid time tracker configuration file: ${validation.errors.join(', ')}. No backup found. Using defaults in memory; the file was left untouched so you can repair it.`
      );
      this.timeTrackerConfig = getDefaultTimeTrackerConfig();
    } catch (error) {
      // On any error, try backup first
      if (await this.attemptRestoreTimeTrackerConfigFromBackup('Failed to load time tracker configuration. Restored from backup file.')) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to load time tracker configuration (${message}). No backup found. Using defaults in memory; the file was left untouched.`);
      this.timeTrackerConfig = getDefaultTimeTrackerConfig();
    }
  }

  public getTimeTrackerConfig(): TimeTrackerConfig {
    return this.timeTrackerConfig;
  }

  public getTimeTrackerConfigPath(): string {
    return this.timeTrackerConfigPath;
  }

  public setOnTimeTrackerChange(callback: () => void): void {
    this.onTimeTrackerChangeCallbacks.push(callback);
  }

  public async saveTimeTrackerConfig(config: TimeTrackerConfig, options?: { suppressNotification?: boolean; skipBackup?: boolean }): Promise<void> {
    const validation = validateTimeTrackerConfig(config);
    if (!validation.valid) {
      throw new Error(`Invalid time tracker configuration: ${validation.errors.join(', ')}`);
    }

    this.timeTrackerConfig = this.mergeWithDefaultTimeTracker(config);
    await this.writeTimeTrackerConfigToDisk(this.timeTrackerConfig, { skipBackup: options?.skipBackup });

    if (!options?.suppressNotification) {
      this.notifyTimeTrackerChange();
    }
  }

  public async reloadTimeTrackerConfig(): Promise<void> {
    await this.loadTimeTrackerConfig();
    this.notifyTimeTrackerChange();
  }

  public getConfigPath(): string {
    return this.configPath;
  }

  public setOnConfigChange(callback: () => void): void {
    this.onConfigChangeCallbacks.push(callback);
  }

  private setupFileWatcher(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher(this.configPath);
    this.watcher.onDidChange(async () => {
      await this.loadConfig();
      this.notifyConfigChange();
    });
    this.watcher.onDidCreate(async () => {
      await this.loadConfig();
      this.notifyConfigChange();
    });
    this.watcher.onDidDelete(async () => {
      this.config = getDefaultConfig();
      this.notifyConfigChange();
    });
  }

  public dispose(): void {
    this.watcher?.dispose();
    this.timeTrackerWatcher?.dispose();
  }

  public async openConfigFile(): Promise<void> {
    const uri = vscode.Uri.file(this.configPath);
    await vscode.window.showTextDocument(uri);
  }

  public async createBackup(): Promise<string> {
    const backupPath = `${this.configPath}.backup.${Date.now()}`;
    await fs.promises.copyFile(this.configPath, backupPath);
    return backupPath;
  }

  public async restoreFromBackup(backupPath: string): Promise<void> {
    const backupData = await fs.promises.readFile(backupPath, 'utf8');
    const parsedConfig = JSON.parse(backupData);
    await this.saveConfig(parsedConfig);
  }

  private notifyConfigChange(): void {
    for (const callback of this.onConfigChangeCallbacks) {
      try {
        callback();
      } catch (error) {
        // Silent fail
      }
    }
  }

  private notifyTimeTrackerChange(): void {
    for (const callback of this.onTimeTrackerChangeCallbacks) {
      try {
        callback();
      } catch (error) {
        // Silent fail
      }
    }
  }

  private setupTimeTrackerFileWatcher(): void {
    this.timeTrackerWatcher = vscode.workspace.createFileSystemWatcher(this.timeTrackerConfigPath);
    this.timeTrackerWatcher.onDidChange(async () => {
      await this.loadTimeTrackerConfig();
      this.notifyTimeTrackerChange();
    });
    this.timeTrackerWatcher.onDidCreate(async () => {
      await this.loadTimeTrackerConfig();
      this.notifyTimeTrackerChange();
    });
    this.timeTrackerWatcher.onDidDelete(async () => {
      // Don't auto-recreate on deletion - only create if file doesn't exist at all during load
      // This prevents overwriting files that might have been temporarily cleared
      this.timeTrackerConfig = getDefaultTimeTrackerConfig();
      this.notifyTimeTrackerChange();
    });
  }

  private mergeWithDefaultTimeTracker(config: TimeTrackerConfig): TimeTrackerConfig {
    return {
      folders: Array.isArray(config.folders) ? config.folders : [],
      ignoredBranches: Array.isArray(config.ignoredBranches) ? config.ignoredBranches : [],
      autoCreateOnBranchCheckout: config.autoCreateOnBranchCheckout !== undefined ? config.autoCreateOnBranchCheckout : true,
      enabled: config.enabled !== undefined ? config.enabled : true
    };
  }

  private getTimeTrackerBackupPath(): string {
    const dir = path.dirname(this.timeTrackerConfigPath);
    return path.join(dir, 'commands-timer-backup.json');
  }

  private async attemptRestoreTimeTrackerConfigFromBackup(message?: string): Promise<boolean> {
    const candidates: string[] = [
      this.getTimeTrackerBackupPath(),
      `${this.timeTrackerConfigPath}.backup`,
      path.join(path.dirname(this.legacyTimeTrackerPath), 'commands-timer-backup.json'),
      `${this.legacyTimeTrackerPath}.backup`
    ];

    const sourcePath = candidates.find(candidate => candidate && fs.existsSync(candidate));
    if (!sourcePath) {
      return false;
    }

    try {
      const backupData = await fs.promises.readFile(sourcePath, 'utf8');
      if (!backupData.trim()) {
        return false;
      }

      const parsedConfig = JSON.parse(backupData);
      const validation = validateTimeTrackerConfig(parsedConfig);

      if (!validation.valid) {
        return false;
      }

      this.timeTrackerConfig = this.mergeWithDefaultTimeTracker(parsedConfig);
      await this.writeTimeTrackerConfigToDisk(this.timeTrackerConfig, { skipBackup: true });
      await this.writeTimeTrackerBackup();

      // Always show a message when restoring from backup
      const displayMessage = message || 'Time tracker configuration restored from backup file.';
      vscode.window.showInformationMessage(displayMessage);

      this.notifyTimeTrackerChange();
      return true;
    } catch (restoreError) {
      return false;
    }
  }

  private async writeTimeTrackerConfigToDisk(config: TimeTrackerConfig, options?: { skipBackup?: boolean }): Promise<void> {
    await this.ensureCommandsDirectoryExists();

    const jsonContent = JSON.stringify(config, null, 2);
    const tempPath = `${this.timeTrackerConfigPath}.tmp`;

    if (!options?.skipBackup && fs.existsSync(this.timeTrackerConfigPath)) {
      try {
        await fs.promises.copyFile(this.timeTrackerConfigPath, this.getTimeTrackerBackupPath());
      } catch {
        // Best-effort backup. Ignore failures but do not stop save.
      }
    }

    await fs.promises.writeFile(tempPath, jsonContent, 'utf8');

    if (fs.existsSync(this.timeTrackerConfigPath)) {
      try {
        await fs.promises.unlink(this.timeTrackerConfigPath);
      } catch {
        // If unlink fails, attempt to overwrite via rename anyway.
      }
    }

    try {
      await fs.promises.rename(tempPath, this.timeTrackerConfigPath);
    } catch {
      // Fallback: attempt direct write and clean up temp file.
      await fs.promises.writeFile(this.timeTrackerConfigPath, jsonContent, 'utf8');
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // ignore cleanup failure
      }
    }
  }

  private async writeTimeTrackerBackup(): Promise<void> {
    try {
      if (!fs.existsSync(this.timeTrackerConfigPath)) {
        return;
      }
      await this.ensureCommandsDirectoryExists();
      const backupPath = this.getTimeTrackerBackupPath();
      await fs.promises.copyFile(this.timeTrackerConfigPath, backupPath);
    } catch {
      // Ignore backup failures to avoid interrupting load flow.
    }
  }

  private async ensureCommandsDirectoryExists(): Promise<void> {
    const commandsDir = path.dirname(this.configPath);
    if (!fs.existsSync(commandsDir)) {
      await fs.promises.mkdir(commandsDir, { recursive: true });
    }
  }

  private async writeCommandsConfigToDisk(config: CommandConfig): Promise<void> {
    await this.ensureCommandsDirectoryExists();
    const configJson = JSON.stringify(config, null, 2);
    await fs.promises.writeFile(this.configPath, configJson, 'utf8');
  }

  private async migrateLegacyConfigIfNeeded(): Promise<void> {
    if (fs.existsSync(this.configPath) || !fs.existsSync(this.legacyConfigPath)) {
      return;
    }

    try {
      await this.ensureCommandsDirectoryExists();
      await fs.promises.copyFile(this.legacyConfigPath, this.configPath);
      await fs.promises.unlink(this.legacyConfigPath);
    } catch {
      // Best effort migration; ignore failures.
    }
  }

  private async migrateLegacyTimeTrackerIfNeeded(): Promise<void> {
    if (fs.existsSync(this.timeTrackerConfigPath) || !fs.existsSync(this.legacyTimeTrackerPath)) {
      return;
    }

    try {
      await this.ensureCommandsDirectoryExists();
      await fs.promises.copyFile(this.legacyTimeTrackerPath, this.timeTrackerConfigPath);
      await fs.promises.unlink(this.legacyTimeTrackerPath);
    } catch {
      // Best effort migration; ignore failures.
    }
  }

  public async importCommands(filePath: string): Promise<void> {
    const importData = await fs.promises.readFile(filePath, 'utf8');
    const parsedConfig = JSON.parse(importData);
    const validation = validateConfig(parsedConfig);
    
    if (!validation.valid) {
      throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
    }
    
    await this.saveConfig(parsedConfig);
  }

  public async exportCommands(filePath: string): Promise<void> {
    const configJson = JSON.stringify(this.config, null, 2);
    await fs.promises.writeFile(filePath, configJson, 'utf8');
  }

  public static resetForTests(): void {
    if (ConfigManager.instance) {
      ConfigManager.instance.dispose();
      ConfigManager.instance = undefined;
    }
  }
}
