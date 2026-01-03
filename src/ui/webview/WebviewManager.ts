import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Command, CommandConfig, Folder, TestRunnerConfig, Timer, SubTimer } from '../../types';
import { ConfigManager } from '../../config/ConfigManager';
import { CommandTreeProvider } from '../../../apps/tasks/treeView/CommandTreeProvider';
import { VariableResolver } from '../../variables/VariableResolver';
import { TestRunnerManager } from '../../../apps/testRunner/TestRunnerManager';
import { TestRunnerTreeProvider } from '../../../apps/testRunner/TestRunnerTreeProvider';
import { TimeTrackerManager } from '../../../apps/timeTracker/TimeTrackerManager';

interface CommandEditorContext {
  folderPath?: number[];
  commandIndex?: number;
}

interface FolderEditorContext {
  path?: number[];
  parentPath?: number[];
}

export class WebviewManager {
  private static instance: WebviewManager;

  private commandPanel?: vscode.WebviewPanel;
  private folderPanel?: vscode.WebviewPanel;
  private configPanel?: vscode.WebviewPanel;
  private testRunnerPanel?: vscode.WebviewPanel;
  private timerPanel?: vscode.WebviewPanel;

  private readonly configManager = ConfigManager.getInstance();
  private readonly variableResolver = VariableResolver.getInstance();
  private readonly testRunnerManager = TestRunnerManager.getInstance();
  private readonly timeTrackerManager = TimeTrackerManager.getInstance();
  private testRunnerTreeProvider?: { cacheTests: (configId: string, tests: any[]) => void; setTestsStatus?: (tests: any[], status: 'idle' | 'running' | 'passed' | 'failed') => void; refresh?: (item?: any) => void };
  private timeTrackerTreeProvider?: { refresh: () => void };
  private treeProvider?: CommandTreeProvider;

  private constructor() {}

  public static getInstance(): WebviewManager {
    if (!WebviewManager.instance) {
      WebviewManager.instance = new WebviewManager();
    }
    return WebviewManager.instance;
  }

  public setTreeProvider(provider: CommandTreeProvider): void {
    this.treeProvider = provider;
  }

  public setTestRunnerTreeProvider(provider: { cacheTests: (configId: string, tests: any[]) => void; setTestsStatus?: (tests: any[], status: 'idle' | 'running' | 'passed' | 'failed') => void; refresh?: (item?: any) => void }): void {
    this.testRunnerTreeProvider = provider;
  }

  public setTimeTrackerTreeProvider(provider: { refresh: () => void }): void {
    this.timeTrackerTreeProvider = provider;
  }

  public showCommandEditor(command?: Command, context?: CommandEditorContext): void {
    const resolvedContext = this.resolveCommandContext(command, context);

    if (this.commandPanel) {
      this.commandPanel.reveal();
      this.commandPanel.title = command ? `Edit ${command.label}` : 'New Command';
      this.sendCommandEditorState(command, resolvedContext);
      return;
    }

    this.commandPanel = vscode.window.createWebviewPanel(
      'commandEditor',
      command ? `Edit ${command.label}` : 'New Command',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.getWebviewRoot()]
      }
    );

    this.commandPanel.webview.html = this.getHtmlContent('command-editor.html', this.commandPanel.webview);

    this.commandPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          this.sendCommandEditorState(command, resolvedContext);
          break;
        case 'requestGlobals':
          this.sendAvailableVariables();
          break;
        case 'saveCommand':
          await this.saveCommand(message.command as Command, message.context as CommandEditorContext | undefined);
          this.sendCommandEditorState(message.command as Command, this.resolveCommandContext(message.command as Command, message.context));
          break;
        case 'error':
          vscode.window.showErrorMessage(message.message);
          break;
        case 'cancel':
          this.commandPanel?.dispose();
          break;
      }
    });

    this.commandPanel.onDidDispose(() => {
      this.commandPanel = undefined;
    });
  }

  public showFolderEditor(folder?: Folder, context?: FolderEditorContext): void {
    const resolvedContext = this.resolveFolderContext(folder, context);

    if (this.folderPanel) {
      this.folderPanel.reveal();
      this.folderPanel.title = folder ? `Edit ${folder.name}` : 'New Folder';
      this.sendFolderEditorState(folder, resolvedContext);
      return;
    }

    this.folderPanel = vscode.window.createWebviewPanel(
      'folderEditor',
      folder ? `Edit ${folder.name}` : 'New Folder',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.getWebviewRoot()]
      }
    );

    this.folderPanel.webview.html = this.getHtmlContent('folder-editor.html', this.folderPanel.webview);

    this.folderPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          this.sendFolderEditorState(folder, resolvedContext);
          break;
        case 'saveFolder':
          await this.saveFolder(message.folder as Folder, message.context as FolderEditorContext | undefined);
          this.folderPanel?.dispose();
          break;
        case 'cancel':
          this.folderPanel?.dispose();
          break;
      }
    });

    this.folderPanel.onDidDispose(() => {
      this.folderPanel = undefined;
    });
  }

  public showConfigurationManager(): void {
    if (this.configPanel) {
      this.configPanel.reveal();
      this.sendConfigToConfigPanel();
      return;
    }

    this.configPanel = vscode.window.createWebviewPanel(
      'commandConfiguration',
      'Extension Configuration',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.getWebviewRoot()]
      }
    );

    this.configPanel.webview.html = this.getHtmlContent('configuration.html', this.configPanel.webview);

    this.configPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          this.sendConfigToConfigPanel();
          break;
        case 'saveSharedVariable':
          await this.saveSharedVariable(message.variable);
          break;
        case 'saveSharedList':
          await this.saveSharedList(message.list);
          break;
        case 'deleteSharedVariable':
          await this.deleteSharedVariable(message.key);
          break;
        case 'deleteSharedList':
          await this.deleteSharedList(message.key);
          break;
        case 'saveConfig':
          await this.saveConfigFromJson(message.configJson);
          break;
        case 'error':
          vscode.window.showErrorMessage(message.message);
          break;
        case 'info':
          vscode.window.showInformationMessage(message.message);
          break;
        case 'cancel':
          this.configPanel?.dispose();
          break;
      }
    });

    this.configPanel.onDidDispose(() => {
      this.configPanel = undefined;
    });
  }

  public showTestRunnerEditor(testRunnerId?: string): void {
    const existing = testRunnerId ? this.testRunnerManager.getConfigById(testRunnerId) : undefined;
    const initialConfig = existing ? { ...existing } : this.createEmptyTestRunner();

    if (this.testRunnerPanel) {
      this.testRunnerPanel.reveal();
      this.testRunnerPanel.title = existing ? `Edit ${existing.title}` : 'New Test Runner';
      this.sendTestRunnerState(initialConfig, existing !== undefined);
      return;
    }

    this.testRunnerPanel = vscode.window.createWebviewPanel(
      'testRunnerEditor',
      existing ? `Edit ${existing.title}` : 'New Test Runner',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.getWebviewRoot(), this.getResourceRoot()]
      }
    );

    this.testRunnerPanel.webview.html = this.getHtmlContent('test-runner-editor.html', this.testRunnerPanel.webview);

    this.testRunnerPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          // Load tests for existing configurations
          if (existing && existing.activated) {
            this.testRunnerManager.discoverTests(existing).then(tests => {
              const testsForDisplay = tests.map(test => ({
                label: test.label,
                file: test.file.fsPath,
                filePath: path.relative(
                  vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                  test.file.fsPath
                ),
                line: test.line
              }));
              this.sendTestRunnerState(initialConfig, existing !== undefined, testsForDisplay);
            }).catch(() => {
              this.sendTestRunnerState(initialConfig, existing !== undefined);
            });
          } else {
            this.sendTestRunnerState(initialConfig, existing !== undefined);
          }
          break;
        case 'runSingleTest':
          try {
            const currentId = typeof message.id === 'string' ? message.id : initialConfig.id;
            const runner = this.testRunnerManager.getConfigById(currentId);
            if (runner && typeof message.label === 'string') {
              const passed = await this.testRunnerManager.runTestWithResult(runner, message.label);
              this.testRunnerPanel?.webview.postMessage({ type: 'testRunResult', label: message.label, status: passed ? 'passed' : 'failed' });
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Test execution failed: ${errorMessage}`);
            this.testRunnerPanel?.webview.postMessage({ type: 'testRunResult', label: message?.label, status: 'failed' });
          }
          break;
        case 'saveTestRunner':
          try {
            const sanitized = this.sanitizeTestRunnerInput(message.config);
            
            await this.testRunnerManager.saveConfig(sanitized);
            // Update editor state
            this.sendTestRunnerState(sanitized, true);
            
            // Trigger test discovery after save
            if (sanitized.activated && this.testRunnerTreeProvider) {
              try {
                const tests = await this.testRunnerManager.discoverAndCacheTests(sanitized, this.testRunnerTreeProvider);
                // Send discovered tests to the editor
                this.testRunnerPanel?.webview.postMessage({ 
                  type: 'testsDiscovered', 
                  tests: tests.map(t => ({
                    label: t.label,
                    file: t.file.fsPath,
                    filePath: vscode.workspace.asRelativePath(t.file, false),
                    line: t.line
                  }))
                });
              } catch (discoveryError) {
                // Don't fail the save if discovery fails, just log it
                console.error('Test discovery failed after save:', discoveryError);
              }
            }
            
            vscode.window.showInformationMessage(`Saved test runner "${sanitized.title}".`);
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to save test runner: ${messageText}`);
          }
          break;
        case 'deleteTestRunner':
          try {
            const identifier = typeof message.id === 'string' && message.id ? message.id : initialConfig.id;
            if (!identifier) {
              vscode.window.showWarningMessage('Cannot delete: No test runner ID provided.');
              break;
            }
            await this.testRunnerManager.deleteConfig(identifier);
            vscode.window.showInformationMessage('Test runner deleted.');
            this.testRunnerPanel?.dispose();
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to delete test runner: ${messageText}`);
          }
          break;
        case 'requestDeleteTestRunner':
          try {
            const identifier = typeof message.id === 'string' && message.id ? message.id : initialConfig.id;
            if (!identifier) {
              vscode.window.showWarningMessage('Cannot delete: No test runner ID provided.');
              break;
            }
            
            // Show VS Code confirmation dialog
            const config = this.testRunnerManager.getConfigById(identifier);
            const configTitle = config?.title || 'this test runner';
            const confirmed = await vscode.window.showWarningMessage(
              `Are you sure you want to delete "${configTitle}"?`,
              { modal: true },
              'Delete'
            );
            
            if (confirmed === 'Delete') {
              await this.testRunnerManager.deleteConfig(identifier);
              vscode.window.showInformationMessage('Test runner deleted.');
              this.testRunnerPanel?.dispose();
            }
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to delete test runner: ${messageText}`);
          }
          break;
        case 'runAllTests':
          try {
            const currentId = typeof message.id === 'string' ? message.id : initialConfig.id;
            const runner = this.testRunnerManager.getConfigById(currentId);
            if (runner) {
              await this.testRunnerManager.runAll(runner, this.testRunnerTreeProvider as any);
            } else {
              vscode.window.showWarningMessage('Please save the test runner before running tests.');
            }
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to run tests: ${messageText}`);
          }
          break;
        case 'stopAllTests':
          try {
            this.testRunnerManager.cancelRunAll();
            vscode.window.showInformationMessage('Stopping all tests...');
          } catch {}
          break;
        case 'requestRefresh':
          {
            const currentId = typeof message.id === 'string' ? message.id : initialConfig.id;
            const runner = this.testRunnerManager.getConfigById(currentId);
            if (runner) {
              this.sendTestRunnerState(runner, true);
            }
          }
          break;
        case 'showError':
          if (typeof message.message === 'string') {
            vscode.window.showErrorMessage(message.message);
          }
          break;
        case 'showInfo':
          if (typeof message.message === 'string') {
            vscode.window.showInformationMessage(message.message);
          }
          break;
        case 'saveAndFindTests':
          try {
            const sanitized = this.sanitizeTestRunnerInput(message.config);
            await this.testRunnerManager.saveConfig(sanitized);
            const tests = await this.testRunnerManager.discoverAndCacheTests(sanitized, this.testRunnerTreeProvider);
            // Only trigger refresh after tests were actually found
            
            const testsForDisplay = tests.map(test => ({
              label: test.label,
              file: test.file.fsPath,
              filePath: path.relative(
                vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                test.file.fsPath
              ),
              line: test.line
            }));
            this.sendTestRunnerState(sanitized, true, testsForDisplay);
            vscode.window.showInformationMessage(`Found ${tests.length} test(s) for "${sanitized.title}".`);
            setTimeout(() => { void vscode.commands.executeCommand('commands-manager-next.tests.refresh'); }, 5000);
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to save and find tests: ${messageText}`);
          }
          break;
        case 'previewPattern':
          {
            try {
              const pattern = typeof message.pattern === 'string' ? message.pattern : '';
              const fileType = typeof message.fileType === 'string' ? message.fileType : 'javascript';
              const workingDirectory = typeof message.workingDirectory === 'string' ? message.workingDirectory : '';
              
              if (!pattern || !fileType) {
                this.testRunnerPanel?.webview.postMessage({
                  type: 'patternPreview',
                  count: 0,
                  files: []
                });
                break;
              }

              // Create a temporary config for pattern matching
              const tempConfig: TestRunnerConfig = {
                id: 'temp-preview',
                title: 'Preview',
                fileType: fileType as 'python' | 'javascript' | 'typescript',
                fileNamePattern: pattern,
                testNamePattern: '*',
                runTestCommand: '',
                activated: true,
                workingDirectory: workingDirectory || undefined
              };

              // Get matching files (not tests, just files)
              this.testRunnerManager.getMatchingFiles(tempConfig).then(files => {
                const relativeFiles = files.map(file => {
                  return vscode.workspace.asRelativePath(file, false).replace(/\\/g, '/');
                });
                
                this.testRunnerPanel?.webview.postMessage({
                  type: 'patternPreview',
                  count: relativeFiles.length,
                  files: relativeFiles.slice(0, 10) // First 10 files
                });
              }).catch(() => {
                this.testRunnerPanel?.webview.postMessage({
                  type: 'patternPreview',
                  count: 0,
                  files: []
                });
              });
            } catch (error) {
              this.testRunnerPanel?.webview.postMessage({
                type: 'patternPreview',
                count: 0,
                files: []
              });
            }
          }
          break;
        case 'cancel':
          this.testRunnerPanel?.dispose();
          break;
      }
    });

    this.testRunnerPanel.onDidDispose(() => {
      this.testRunnerPanel = undefined;
    });
  }

  private sendTestRunnerState(config: TestRunnerConfig, isExisting: boolean, tests?: Array<{ label: string; file: string; filePath: string; line: number }>): void {
    if (!this.testRunnerPanel) {
      return;
    }

    this.testRunnerPanel.title = isExisting ? `Edit ${config.title}` : 'New Test Runner';
    const passIcon = this.testRunnerPanel.webview.asWebviewUri(vscode.Uri.file(path.join(this.getResourceRoot().fsPath, '..', 'yes_9426997.png')));
    const failIcon = this.testRunnerPanel.webview.asWebviewUri(vscode.Uri.file(path.join(this.getResourceRoot().fsPath, '..', 'remove_16597122.png')));
    this.testRunnerPanel.webview.postMessage({
      type: 'load',
      config,
      isExisting,
      tests: tests || [],
      iconUris: { pass: passIcon.toString(), fail: failIcon.toString() }
    });
  }

  private createEmptyTestRunner(): TestRunnerConfig {
    const timestamp = Date.now();
    return {
      id: `test-runner-${timestamp}`,
      activated: true,
      title: '',
      fileType: 'javascript',
      workingDirectory: '',
      fileNamePattern: '',
      testNamePattern: '*',
      ignoreList: '',
      runTestCommand: '',
      terminalName: '',
      allowNonTest: false,
      autoFind: true,
      inlineButton: true
    };
  }

  private createDefaultTestRunner(): TestRunnerConfig {
    const timestamp = Date.now();
    return {
      id: `test-runner-${timestamp}`,
      activated: true,
      title: 'New Test Runner',
      fileType: 'javascript',
      workingDirectory: '',
      fileNamePattern: 'test_*',
      testNamePattern: '*',
      ignoreList: '',
      runTestCommand: 'npm test -- $test_name',
      terminalName: 'Test Runner'
    };
  }

  private sanitizeTestRunnerInput(data: any): TestRunnerConfig {
    const baseId = typeof data?.id === 'string' && data.id.trim() ? data.id.trim() : this.createDefaultTestRunner().id;
    const title = typeof data?.title === 'string' && data.title.trim() ? data.title.trim() : 'Untitled Test Runner';
    const fileType: TestRunnerConfig['fileType'] = ['javascript', 'typescript', 'python'].includes(data?.fileType)
      ? data.fileType
      : 'javascript';
    const fileNamePattern = typeof data?.fileNamePattern === 'string' ? data.fileNamePattern : '';
    const testNamePattern = typeof data?.testNamePattern === 'string' ? data.testNamePattern : '';
    const ignoreList = typeof data?.ignoreList === 'string' ? data.ignoreList : '';
    const workingDirectory = typeof data?.workingDirectory === 'string' ? data.workingDirectory.trim() : '';
    const runTestCommand = typeof data?.runTestCommand === 'string' ? data.runTestCommand.trim() : '';
    const terminalName = typeof data?.terminalName === 'string' ? data.terminalName.trim() : '';
    const activated = typeof data?.activated === 'boolean' ? data.activated : Boolean(data?.activated);
    const allowNonTest = typeof data?.allowNonTest === 'boolean' ? data.allowNonTest : false;
    const autoFind = typeof data?.autoFind === 'boolean' ? data.autoFind : true;
    const inlineButton = typeof data?.inlineButton === 'boolean' ? data.inlineButton : true;

    if (!runTestCommand) {
      throw new Error('Run test command is required. Use $test_name, $test_path, or other available variables.');
    }

    return {
      id: baseId,
      activated,
      title,
      fileType,
      workingDirectory,
      fileNamePattern,
      testNamePattern,
      ignoreList,
      runTestCommand,
      terminalName: terminalName || title,
      allowNonTest,
      autoFind,
      inlineButton
    };
  }

  public dispose(): void {
    this.commandPanel?.dispose();
    this.folderPanel?.dispose();
    this.configPanel?.dispose();
    this.testRunnerPanel?.dispose();
    this.treeProvider = undefined;
  }

  private getWebviewRoot(): vscode.Uri {
    return vscode.Uri.file(path.join(__dirname, '..', '..', '..', 'resources', 'webviews'));
  }

  private getResourceRoot(): vscode.Uri {
    return vscode.Uri.file(path.join(__dirname, '..', '..', '..', 'resources'));
  }

  private getHtmlContent(template: string, webview: vscode.Webview, replacements: Record<string, string> = {}): string {
    const templatePath = path.join(this.getWebviewRoot().fsPath, template);
    let content = fs.readFileSync(templatePath, 'utf8');
    const nonce = this.getNonce();

    const baseReplacements: Record<string, string> = {
      '{{cspSource}}': webview.cspSource,
      '{{nonce}}': nonce,
      ...replacements
    };

    Object.entries(baseReplacements).forEach(([key, value]) => {
      content = content.split(key).join(value);
    });

    return content;
  }

  private async saveCommand(command: Command, context?: CommandEditorContext): Promise<void> {
    try {
      const config = this.configManager.getConfig();

      if (!this.updateExistingCommand(config.folders, command)) {
        const targetFolder = context?.folderPath
          ? this.getFolderByPath(config.folders, context.folderPath)
          : config.folders[0];

        if (!targetFolder) {
          throw new Error('No folder available to store this command. Create a folder first.');
        }

        if (!targetFolder.commands) {
          targetFolder.commands = [];
        }

        targetFolder.commands.push(command);
      }

      await this.configManager.saveConfig(config);
      this.treeProvider?.refresh();
      vscode.window.showInformationMessage(`Command "${command.label}" saved successfully.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to save command: ${message}`);
    }
  }

  private async saveFolder(folder: Folder, context?: FolderEditorContext): Promise<void> {
    try {
      const config = this.configManager.getConfig();

      if (context?.path && context.path.length > 0) {
        this.replaceFolderAtPath(config.folders, context.path, folder);
      } else if (context?.parentPath && context.parentPath.length > 0) {
        const parent = this.getFolderByPath(config.folders, context.parentPath);
        if (!parent) {
          throw new Error('Unable to locate parent folder.');
        }
        if (!parent.subfolders) {
          parent.subfolders = [];
        }
        parent.subfolders.push(folder);
      } else {
        config.folders.push(folder);
      }

      await this.configManager.saveConfig(config);
      this.treeProvider?.refresh();
      vscode.window.showInformationMessage(`Folder "${folder.name}" saved successfully.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to save folder: ${message}`);
    }
  }

  private async saveSharedVariable(variable: any): Promise<void> {
    try {
      const config = this.configManager.getConfig();
      if (!config.sharedVariables) {
        config.sharedVariables = [];
      }

      const existingIndex = config.sharedVariables.findIndex(v => v.key === variable.key);
      if (existingIndex >= 0) {
        config.sharedVariables[existingIndex] = variable;
      } else {
        config.sharedVariables.push(variable);
      }

      await this.configManager.saveConfig(config);
      this.treeProvider?.refresh();
      this.sendConfigToConfigPanel();
      vscode.window.showInformationMessage(`Saved variable "${variable.key}".`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to save variable: ${message}`);
    }
  }

  private async saveSharedList(list: any): Promise<void> {
    try {
      const config = this.configManager.getConfig();
      if (!config.sharedLists) {
        config.sharedLists = [];
      }

      const existingIndex = config.sharedLists.findIndex(item => item.key === list.key);
      if (existingIndex >= 0) {
        config.sharedLists[existingIndex] = list;
      } else {
        config.sharedLists.push(list);
      }

      await this.configManager.saveConfig(config);
      this.treeProvider?.refresh();
      this.sendConfigToConfigPanel();
      vscode.window.showInformationMessage(`Saved list "${list.key}".`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to save list: ${message}`);
    }
  }

  private async deleteSharedVariable(key: string): Promise<void> {
    try {
      const config = this.configManager.getConfig();
      config.sharedVariables = (config.sharedVariables || []).filter(variable => variable.key !== key);
      await this.configManager.saveConfig(config);
      this.treeProvider?.refresh();
      this.sendConfigToConfigPanel();
      vscode.window.showInformationMessage(`Deleted variable "${key}".`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to delete variable: ${message}`);
    }
  }

  private async deleteSharedList(key: string): Promise<void> {
    try {
      const config = this.configManager.getConfig();
      config.sharedLists = (config.sharedLists || []).filter(list => list.key !== key);
      await this.configManager.saveConfig(config);
      this.treeProvider?.refresh();
      this.sendConfigToConfigPanel();
      vscode.window.showInformationMessage(`Deleted list "${key}".`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to delete list: ${message}`);
    }
  }

  private async saveConfigFromJson(configJson: string): Promise<void> {
    try {
      const parsed = JSON.parse(configJson) as CommandConfig;
      const validation = this.validateConfig(parsed);
      if (!validation.valid) {
        vscode.window.showErrorMessage(`Configuration is invalid: ${validation.errors.join(', ')}`);
        return;
      }

      await this.configManager.saveConfig(parsed);
      this.treeProvider?.refresh();
      this.sendConfigToConfigPanel();
      vscode.window.showInformationMessage('Configuration saved successfully.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to save configuration: ${message}`);
    }
  }

  private validateConfig(config: CommandConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!config || typeof config !== 'object') {
      errors.push('Configuration must be an object.');
      return { valid: false, errors };
    }

    if (!Array.isArray(config.folders) || config.folders.length === 0) {
      errors.push('Configuration must contain at least one folder.');
    }

    return { valid: errors.length === 0, errors };
  }

  private sendCommandEditorState(command?: Command, context?: CommandEditorContext): void {
    if (!this.commandPanel) {
      return;
    }

    this.commandPanel.webview.postMessage({
      type: 'init',
      command,
      context,
      variables: this.variableResolver.getAvailableVariables()
    });
  }

  private sendAvailableVariables(): void {
    if (!this.commandPanel) {
      return;
    }

    this.commandPanel.webview.postMessage({
      type: 'variables',
      variables: this.variableResolver.getAvailableVariables()
    });
  }

  private sendFolderEditorState(folder?: Folder, context?: FolderEditorContext): void {
    if (!this.folderPanel) {
      return;
    }

    this.folderPanel.webview.postMessage({
      type: 'init',
      folder,
      context
    });
  }

  private sendConfigToConfigPanel(): void {
    if (!this.configPanel) {
      return;
    }

    this.configPanel.webview.postMessage({
      type: 'config',
      config: this.configManager.getConfig()
    });
  }

  private resolveCommandContext(command?: Command, provided?: CommandEditorContext): CommandEditorContext | undefined {
    if (provided) {
      return provided;
    }

    if (!command?.id) {
      return undefined;
    }

    return this.findCommandContext(command.id);
  }

  private resolveFolderContext(folder?: Folder, provided?: FolderEditorContext): FolderEditorContext | undefined {
    if (provided) {
      return provided;
    }

    if (!folder?.name) {
      return undefined;
    }

    return this.findFolderContext(folder.name);
  }

  private findCommandContext(commandId: string, folders: Folder[] = this.configManager.getConfig().folders, currentPath: number[] = []): CommandEditorContext | undefined {
    for (let index = 0; index < folders.length; index++) {
      const folder = folders[index];
      const folderPath = [...currentPath, index];

      const commandIndex = folder.commands.findIndex(cmd => cmd.id === commandId);
      if (commandIndex >= 0) {
        return { folderPath, commandIndex };
      }

      if (folder.subfolders) {
        const nested = this.findCommandContext(commandId, folder.subfolders, folderPath);
        if (nested) {
          return nested;
        }
      }
    }

    return undefined;
  }

  private findFolderContext(folderName: string, folders: Folder[] = this.configManager.getConfig().folders, currentPath: number[] = []): FolderEditorContext | undefined {
    for (let index = 0; index < folders.length; index++) {
      const folder = folders[index];
      const folderPath = [...currentPath, index];

      if (folder.name === folderName) {
        return { path: folderPath };
      }

      if (folder.subfolders) {
        const nested = this.findFolderContext(folderName, folder.subfolders, folderPath);
        if (nested) {
          return nested;
        }
      }
    }

    return undefined;
  }

  private updateExistingCommand(folders: Folder[], command: Command): boolean {
    for (const folder of folders) {
      const index = folder.commands.findIndex(item => item.id === command.id);
      if (index >= 0) {
        folder.commands[index] = command;
        return true;
      }

      if (folder.subfolders && this.updateExistingCommand(folder.subfolders, command)) {
        return true;
      }
    }

    return false;
  }

  private getFolderByPath(folders: Folder[], path: number[]): Folder | undefined {
    let current = folders;
    let folder: Folder | undefined;

    for (const index of path) {
      folder = current[index];
      if (!folder) {
        return undefined;
      }
      current = folder.subfolders || [];
    }

    return folder;
  }

  private replaceFolderAtPath(folders: Folder[], path: number[], folder: Folder): void {
    if (path.length === 0) {
      throw new Error('Invalid folder path.');
    }

    const [index, ...rest] = path;

    if (rest.length === 0) {
      folders[index] = folder;
      return;
    }

    const current = folders[index];
    if (!current || !current.subfolders) {
      throw new Error('Invalid folder path.');
    }

    this.replaceFolderAtPath(current.subfolders, rest, folder);
  }


  public showTimerEditor(timerId: string): void {
    // Find timer in config
    const configManager = ConfigManager.getInstance();
    const timeTrackerConfig = configManager.getTimeTrackerConfig();
    
    const findTimer = (folders: typeof timeTrackerConfig.folders): Timer | undefined => {
      for (const folder of folders) {
        for (const timer of folder.timers) {
          if (timer.id === timerId) return timer;
        }
        if (folder.subfolders) {
          const found = findTimer(folder.subfolders);
          if (found) return found;
        }
      }
      return undefined;
    };
    
    const timer = findTimer(timeTrackerConfig.folders);
    if (!timer) {
      vscode.window.showErrorMessage('Timer not found');
      return;
    }

    if (this.timerPanel) {
      this.timerPanel.reveal();
      this.timerPanel.title = `Edit ${timer.label}`;
      this.sendTimerEditorState(timer);
      return;
    }

    this.timerPanel = vscode.window.createWebviewPanel(
      'timerEditor',
      `Edit ${timer.label}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.getWebviewRoot()]
      }
    );

    this.timerPanel.webview.html = this.getHtmlContent('timer-editor.html', this.timerPanel.webview);

    this.timerPanel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          this.sendTimerEditorState(timer);
          break;
        case 'saveTimer':
          try {
            await this.saveTimer(message.timer as Timer);
            const updatedTimer = this.findTimerById(timerId);
            if (updatedTimer) {
              this.sendTimerEditorState(updatedTimer);
            }
            this.timeTrackerTreeProvider?.refresh();
            vscode.window.showInformationMessage(`Timer "${(message.timer as Timer).label}" saved.`);
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to save timer: ${messageText}`);
          }
          break;
        case 'updateTimerDates':
          try {
            await this.timeTrackerManager.updateTimerDates(
              timerId,
              message.startTime,
              message.endTime
            );
            const updatedTimer = this.findTimerById(timerId);
            if (updatedTimer) {
              this.sendTimerEditorState(updatedTimer);
            }
            this.timeTrackerTreeProvider?.refresh();
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to update dates: ${messageText}`);
          }
          break;
        case 'editSubTimer':
          try {
            await this.timeTrackerManager.editSubTimer(
              timerId,
              message.subtimerId,
              { label: message.label, description: message.description }
            );
            const updatedTimer = this.findTimerById(timerId);
            if (updatedTimer) {
              this.sendTimerEditorState(updatedTimer);
            }
            this.timeTrackerTreeProvider?.refresh();
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to edit subtimer: ${messageText}`);
          }
          break;
        case 'updateSubTimerDates':
          try {
            await this.timeTrackerManager.updateSubTimerDates(
              timerId,
              message.subtimerId,
              message.startTime,
              message.endTime
            );
            const updatedTimer = this.findTimerById(timerId);
            if (updatedTimer) {
              this.sendTimerEditorState(updatedTimer);
            }
            this.timeTrackerTreeProvider?.refresh();
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to update subtimer dates: ${messageText}`);
          }
          break;
        case 'reorderSubTimers':
          try {
            await this.timeTrackerManager.reorderSubTimers(timerId, message.subtimerIds as string[]);
            const updatedTimer = this.findTimerById(timerId);
            if (updatedTimer) {
              this.sendTimerEditorState(updatedTimer);
            }
            this.timeTrackerTreeProvider?.refresh();
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to reorder subtimers: ${messageText}`);
          }
          break;
        case 'deleteSubTimer':
          try {
            await this.timeTrackerManager.deleteSubTimer(timerId, message.subtimerId);
            const updatedTimer = this.findTimerById(timerId);
            if (updatedTimer) {
              this.sendTimerEditorState(updatedTimer);
            }
            this.timeTrackerTreeProvider?.refresh();
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to delete subtimer: ${messageText}`);
          }
          break;
        case 'createSubTimer':
          try {
            const timer = this.findTimerById(timerId);
            if (!timer) {
              vscode.window.showErrorMessage('Timer not found');
              break;
            }
            // Calculate next session number
            const sessionNumber = timer.subtimers ? timer.subtimers.length + 1 : 1;
            const label = `Session ${sessionNumber}`;
            // Only start immediately if parent timer has running subtimers
            const hasRunningSubtimer = timer.subtimers && timer.subtimers.some(st => !st.endTime);
            await this.timeTrackerManager.createSubTimer(timerId, label, undefined, hasRunningSubtimer);
            const updatedTimer = this.findTimerById(timerId);
            if (updatedTimer) {
              this.sendTimerEditorState(updatedTimer);
            }
            this.timeTrackerTreeProvider?.refresh();
            vscode.window.showInformationMessage(`SubTimer "${label}" created`);
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Failed to create subtimer: ${messageText}`);
          }
          break;
        case 'cancel':
          this.timerPanel?.dispose();
          break;
      }
    });

    this.timerPanel.onDidDispose(() => {
      this.timerPanel = undefined;
    });
  }

  private sendTimerEditorState(timer: Timer): void {
    this.timerPanel?.webview.postMessage({
      type: 'timerState',
      timer: {
        ...timer,
        subtimers: timer.subtimers || []
      }
    });
  }

  private findTimerById(timerId: string): Timer | undefined {
    const configManager = ConfigManager.getInstance();
    const timeTrackerConfig = configManager.getTimeTrackerConfig();
    
    const findTimer = (folders: typeof timeTrackerConfig.folders): Timer | undefined => {
      for (const folder of folders) {
        for (const timer of folder.timers) {
          if (timer.id === timerId) return timer;
        }
        if (folder.subfolders) {
          const found = findTimer(folder.subfolders);
          if (found) return found;
        }
      }
      return undefined;
    };
    
    return findTimer(timeTrackerConfig.folders);
  }

  private async saveTimer(timer: Timer): Promise<void> {
    await this.timeTrackerManager.editTimer(timer.id, {
      label: timer.label,
      archived: timer.archived
    });
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 16; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
