import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CommandConfig, TimeTrackerConfig } from '../types';
import { getDefaultConfig, validateConfig, getDefaultTimeTrackerConfig, validateTimeTrackerConfig } from './schema';

type StorageLocation = 'workspace' | 'global' | 'both';

export class ConfigManager {
  private static instance: ConfigManager | undefined;
  private config: CommandConfig;
  private configPath: string;
  private globalConfigPath: string;
  private watcher?: vscode.FileSystemWatcher;
  private globalWatcher?: vscode.FileSystemWatcher;
  private onConfigChangeCallbacks: Array<() => void> = [];
  private timeTrackerConfig: TimeTrackerConfig;
  private timeTrackerConfigPath: string;
  private globalTimeTrackerConfigPath: string;
  private timeTrackerWatcher?: vscode.FileSystemWatcher;
  private globalTimeTrackerWatcher?: vscode.FileSystemWatcher;
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

    // Global paths
    const globalBaseDir = path.join(os.homedir(), '.vscode', 'commands');
    this.globalConfigPath = path.join(globalBaseDir, 'commands.json');
    this.globalTimeTrackerConfigPath = path.join(globalBaseDir, 'commands-timer.json');

    this.config = getDefaultConfig();
    this.timeTrackerConfig = getDefaultTimeTrackerConfig();
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  private getStorageLocation(): StorageLocation {
    const config = vscode.workspace.getConfiguration('commandManager');
    return config.get<StorageLocation>('storageLocation', 'workspace');
  }

  private shouldPreferGlobalCommands(): boolean {
    const config = vscode.workspace.getConfiguration('commandManager');
    return config.get<boolean>('preferGlobalCommands', false);
  }

  private shouldAutoCreateDirectory(): boolean {
    const config = vscode.workspace.getConfiguration('commandManager');
    return config.get<boolean>('autoCreateCommandsDirectory', true);
  }

  private shouldAddToGitignore(): boolean {
    const config = vscode.workspace.getConfiguration('commandManager');
    return config.get<boolean>('addCommandsToGitignore', false);
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

    const storageLocation = this.getStorageLocation();

    // Save to appropriate location(s)
    if (storageLocation === 'workspace') {
      await this.writeCommandsConfigToDisk(config);
    } else if (storageLocation === 'global') {
      await this.writeGlobalCommandsConfigToDisk(config);
    } else if (storageLocation === 'both') {
      // When in 'both' mode, save to workspace by default
      // User can manually edit global config if needed
      await this.writeCommandsConfigToDisk(config);
    }

    this.config = config;
    this.notifyConfigChange();
  }

  public async loadConfig(): Promise<void> {
    try {
      const storageLocation = this.getStorageLocation();
      const preferGlobal = this.shouldPreferGlobalCommands();

      let workspaceConfig: CommandConfig | undefined;
      let globalConfig: CommandConfig | undefined;

      // Load workspace config if needed
      if (storageLocation === 'workspace' || storageLocation === 'both') {
        await this.ensureCommandsDirectoryExists();
        await this.migrateLegacyConfigIfNeeded();

        if (fs.existsSync(this.configPath)) {
          const configData = await fs.promises.readFile(this.configPath, 'utf8');
          const parsedConfig = JSON.parse(configData);

          // Handle time tracker migration before validation
          let extractedTimeTracker: TimeTrackerConfig | undefined;
          if (parsedConfig.timeTracker) {
            extractedTimeTracker = parsedConfig.timeTracker;
            delete parsedConfig.timeTracker;
          }

          const validation = validateConfig(parsedConfig);

          if (validation.valid) {
            workspaceConfig = parsedConfig;

            if (extractedTimeTracker) {
              this.pendingMigratedTimeTracker = extractedTimeTracker;
            }
          } else {
            vscode.window.showWarningMessage(
              `Invalid workspace configuration file: ${validation.errors.join(', ')}. Using default configuration.`
            );
          }
        }
      }

      // Load global config if needed
      if (storageLocation === 'global' || storageLocation === 'both') {
        // Ensure global directory exists without creating workspace directory
        const globalDir = path.dirname(this.globalConfigPath);
        if (!fs.existsSync(globalDir)) {
          await fs.promises.mkdir(globalDir, { recursive: true });
        }

        if (fs.existsSync(this.globalConfigPath)) {
          try {
            const configData = await fs.promises.readFile(this.globalConfigPath, 'utf8');
            const parsedConfig = JSON.parse(configData);

            const validation = validateConfig(parsedConfig);

            if (validation.valid) {
              globalConfig = parsedConfig;
            } else {
              vscode.window.showWarningMessage(
                `Invalid global configuration file: ${validation.errors.join(', ')}.`
              );
            }
          } catch (error) {
            // Global config might not exist yet - that's okay
          }
        }
      }

      // Ensure testRunners and pinnedCommands arrays exist
      if (workspaceConfig) {
        if (!workspaceConfig.testRunners) {
          workspaceConfig.testRunners = [];
        }
        if (!workspaceConfig.pinnedCommands) {
          workspaceConfig.pinnedCommands = [];
        }
      }
      if (globalConfig) {
        if (!globalConfig.testRunners) {
          globalConfig.testRunners = [];
        }
        if (!globalConfig.pinnedCommands) {
          globalConfig.pinnedCommands = [];
        }
      }

      // Merge configs based on storage location and preferences
      if (storageLocation === 'workspace') {
        this.config = workspaceConfig || getDefaultConfig();
        if (!workspaceConfig) {
          await this.writeCommandsConfigToDisk(this.config);
        }
      } else if (storageLocation === 'global') {
        this.config = globalConfig || getDefaultConfig();
        if (!globalConfig) {
          await this.writeGlobalCommandsConfigToDisk(this.config);
        }
      } else if (storageLocation === 'both') {
        // Merge both configs
        if (preferGlobal && globalConfig) {
          // Global commands as base, workspace commands added
          this.config = this.mergeConfigs(globalConfig, workspaceConfig);
        } else if (workspaceConfig) {
          // Workspace commands as base, global commands added
          this.config = this.mergeConfigs(workspaceConfig, globalConfig);
        } else if (globalConfig) {
          this.config = globalConfig;
        } else {
          this.config = getDefaultConfig();
          await this.writeCommandsConfigToDisk(this.config);
        }
      }

      // Ensure essential arrays exist
      if (!this.config.testRunners) {
        this.config.testRunners = [];
      }
      if (!this.config.pinnedCommands) {
        this.config.pinnedCommands = [];
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to load configuration: ${error}`);
      this.config = getDefaultConfig();

      // Save to appropriate location based on storage setting
      const storageLocation = this.getStorageLocation();
      try {
        if (storageLocation === 'global') {
          await this.writeGlobalCommandsConfigToDisk(this.config);
        } else {
          await this.writeCommandsConfigToDisk(this.config);
        }
      } catch (saveError) {
        // If save fails, at least we have the default config in memory
        console.error('Failed to save default config:', saveError);
      }
    }
  }

  private mergeConfigs(baseConfig: CommandConfig, additionalConfig?: CommandConfig): CommandConfig {
    if (!additionalConfig) {
      return baseConfig;
    }

    // Create a deep copy of base config
    const merged: CommandConfig = JSON.parse(JSON.stringify(baseConfig));

    // Merge folders - add additional folders with distinct names
    if (additionalConfig.folders && additionalConfig.folders.length > 0) {
      const baseFolderNames = new Set(merged.folders.map(f => f.name));
      for (const folder of additionalConfig.folders) {
        if (!baseFolderNames.has(folder.name)) {
          merged.folders.push(folder);
        }
      }
    }

    // Merge test runners - add additional test runners with distinct IDs
    if (additionalConfig.testRunners && additionalConfig.testRunners.length > 0) {
      if (!merged.testRunners) {
        merged.testRunners = [];
      }
      const baseRunnerIds = new Set(merged.testRunners.map(r => r.id));
      for (const runner of additionalConfig.testRunners) {
        if (!baseRunnerIds.has(runner.id)) {
          merged.testRunners.push(runner);
        }
      }
    }

    // Merge pinned commands
    if (additionalConfig.pinnedCommands && additionalConfig.pinnedCommands.length > 0) {
      if (!merged.pinnedCommands) {
        merged.pinnedCommands = [];
      }
      const basePinnedIds = new Set(merged.pinnedCommands);
      for (const pinnedId of additionalConfig.pinnedCommands) {
        if (!basePinnedIds.has(pinnedId)) {
          merged.pinnedCommands.push(pinnedId);
        }
      }
    }

    // Merge shared variables
    if (additionalConfig.sharedVariables && additionalConfig.sharedVariables.length > 0) {
      if (!merged.sharedVariables) {
        merged.sharedVariables = [];
      }
      const baseVarKeys = new Set(merged.sharedVariables.map(v => v.key));
      for (const variable of additionalConfig.sharedVariables) {
        if (!baseVarKeys.has(variable.key)) {
          merged.sharedVariables.push(variable);
        }
      }
    }

    // Merge shared lists
    if (additionalConfig.sharedLists && additionalConfig.sharedLists.length > 0) {
      if (!merged.sharedLists) {
        merged.sharedLists = [];
      }
      const baseListKeys = new Set(merged.sharedLists.map(l => l.key));
      for (const list of additionalConfig.sharedLists) {
        if (!baseListKeys.has(list.key)) {
          merged.sharedLists.push(list);
        }
      }
    }

    return merged;
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

      await this.ensureCommandsDirectoryExists(true);
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
    const storageLocation = this.getStorageLocation();

    // Watch workspace config
    if (storageLocation === 'workspace' || storageLocation === 'both') {
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
        await this.loadConfig();
        this.notifyConfigChange();
      });
    }

    // Watch global config
    if (storageLocation === 'global' || storageLocation === 'both') {
      this.globalWatcher = vscode.workspace.createFileSystemWatcher(this.globalConfigPath);
      this.globalWatcher.onDidChange(async () => {
        await this.loadConfig();
        this.notifyConfigChange();
      });
      this.globalWatcher.onDidCreate(async () => {
        await this.loadConfig();
        this.notifyConfigChange();
      });
      this.globalWatcher.onDidDelete(async () => {
        await this.loadConfig();
        this.notifyConfigChange();
      });
    }
  }

  public dispose(): void {
    this.watcher?.dispose();
    this.globalWatcher?.dispose();
    this.timeTrackerWatcher?.dispose();
    this.globalTimeTrackerWatcher?.dispose();
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
    await this.ensureCommandsDirectoryExists(true);

    // Ensure the directory exists before writing
    const timerDir = path.dirname(this.timeTrackerConfigPath);
    if (!fs.existsSync(timerDir)) {
      await fs.promises.mkdir(timerDir, { recursive: true });
    }

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
      await this.ensureCommandsDirectoryExists(true);
      const backupPath = this.getTimeTrackerBackupPath();
      await fs.promises.copyFile(this.timeTrackerConfigPath, backupPath);
    } catch {
      // Ignore backup failures to avoid interrupting load flow.
    }
  }

  private async ensureCommandsDirectoryExists(force: boolean = false): Promise<void> {
    const storageLocation = this.getStorageLocation();
    const shouldAutoCreate = this.shouldAutoCreateDirectory() || force;

    // Handle workspace directory
    if (storageLocation === 'workspace' || storageLocation === 'both') {
      const commandsDir = path.dirname(this.configPath);
      if (!fs.existsSync(commandsDir) && shouldAutoCreate) {
        await fs.promises.mkdir(commandsDir, { recursive: true });
      }

      // Check if we should add to .gitignore after directory is created or if it already exists
      if (fs.existsSync(commandsDir)) {
        await this.addCommandsToGitignoreIfNeeded();
      }
    }

    // Handle global directory - always create if needed
    if (storageLocation === 'global' || storageLocation === 'both') {
      await this.ensureGlobalDirectoryExists();
    }
  }

  private async ensureGlobalDirectoryExists(): Promise<void> {
    const globalDir = path.dirname(this.globalConfigPath);
    if (!fs.existsSync(globalDir)) {
      await fs.promises.mkdir(globalDir, { recursive: true });
    }
  }

  private async addCommandsToGitignoreIfNeeded(): Promise<void> {
    if (!this.shouldAddToGitignore()) {
      return;
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return;
    }

    // Check if workspace is a git repository
    const gitDir = path.join(workspaceRoot, '.git');
    if (!fs.existsSync(gitDir)) {
      return;
    }

    const gitignorePath = path.join(workspaceRoot, '.gitignore');
    const commandsPattern = '.vscode/commands/';

    try {
      let gitignoreContent = '';
      if (fs.existsSync(gitignorePath)) {
        gitignoreContent = await fs.promises.readFile(gitignorePath, 'utf8');
      }

      // Check if the pattern already exists
      const lines = gitignoreContent.split('\n');
      const patternExists = lines.some(line => line.trim() === commandsPattern.trim());

      if (!patternExists) {
        // Add the pattern
        const newContent = gitignoreContent + (gitignoreContent && !gitignoreContent.endsWith('\n') ? '\n' : '') + commandsPattern + '\n';

        await fs.promises.writeFile(gitignorePath, newContent, 'utf8');
      }
    } catch (error) {
      // Silently fail - don't interrupt the flow if gitignore update fails
      console.error('Failed to update .gitignore:', error);
    }
  }

  private async writeCommandsConfigToDisk(config: CommandConfig): Promise<void> {
    await this.ensureCommandsDirectoryExists();

    // Ensure the directory exists before writing
    const commandsDir = path.dirname(this.configPath);
    if (!fs.existsSync(commandsDir)) {
      await fs.promises.mkdir(commandsDir, { recursive: true });
    }

    const configJson = JSON.stringify(config, null, 2);
    await fs.promises.writeFile(this.configPath, configJson, 'utf8');
  }

  private async writeGlobalCommandsConfigToDisk(config: CommandConfig): Promise<void> {
    await this.ensureGlobalDirectoryExists();

    // Ensure the directory exists before writing
    const globalDir = path.dirname(this.globalConfigPath);
    if (!fs.existsSync(globalDir)) {
      await fs.promises.mkdir(globalDir, { recursive: true });
    }

    const configJson = JSON.stringify(config, null, 2);
    await fs.promises.writeFile(this.globalConfigPath, configJson, 'utf8');
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
      await this.ensureCommandsDirectoryExists(true);
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
