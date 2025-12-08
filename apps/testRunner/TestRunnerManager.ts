import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigManager } from '../../src/config/ConfigManager';
import { TerminalManager } from '../../src/execution/TerminalManager';
import { TerminalConfig, TestRunnerConfig } from '../../src/types';
import { getResolver } from './resolvers/TestExecutionResolver';

export interface DiscoveredTest {
  id: string;
  configId: string;
  label: string;
  file: vscode.Uri;
  line: number;
  range: vscode.Range;
}

interface PatternSet {
  matchers: RegExp[];
}

export class TestRunnerManager {
  private static instance: TestRunnerManager;

  private readonly configManager = ConfigManager.getInstance();
  private readonly terminalManager = TerminalManager.getInstance();
  private cancelRunAllRequested = false;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  private readonly fileWatcher: vscode.FileSystemWatcher;

  public readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  private constructor() {
    this.configManager.setOnConfigChange(() => this._onDidChange.fire());

    this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*.{js,jsx,ts,tsx,mjs,cjs,cts,mts,py}');
    const refresh = () => this._onDidChange.fire();
    this.fileWatcher.onDidChange(refresh);
    this.fileWatcher.onDidCreate(refresh);
    this.fileWatcher.onDidDelete(refresh);
  }

  public static getInstance(): TestRunnerManager {
    if (!TestRunnerManager.instance) {
      TestRunnerManager.instance = new TestRunnerManager();
    }

    return TestRunnerManager.instance;
  }

  public cancelRunAll(): void {
    this.cancelRunAllRequested = true;
  }

  public dispose(): void {
    this.fileWatcher.dispose();
    this._onDidChange.dispose();
  }


  public getConfigs(): TestRunnerConfig[] {
    const config = this.configManager.getConfig();
    return [...(config.testRunners ?? [])];
  }

  public getConfigById(id: string): TestRunnerConfig | undefined {
    return this.getConfigs().find(entry => entry.id === id);
  }

  public async saveConfig(runner: TestRunnerConfig): Promise<void> {
    await this.updateConfigs(configs => {
      const index = configs.findIndex(existing => existing.id === runner.id);
      if (index >= 0) {
        configs[index] = { ...runner };
      } else {
        configs.push({ ...runner });
      }
      return configs;
    });
  }

  public async deleteConfig(id: string): Promise<void> {
    await this.updateConfigs(configs => configs.filter(config => config.id !== id));
  }

  public async moveConfig(id: string, newIndex: number): Promise<void> {
    await this.updateConfigs(configs => {
      const index = configs.findIndex(config => config.id === id);
      if (index === -1 || newIndex < 0 || newIndex >= configs.length) {
        return configs;
      }

      const [item] = configs.splice(index, 1);
      configs.splice(newIndex, 0, item);
      return configs;
    });
  }

  public async toggleActivation(id: string): Promise<void> {
    await this.setActivation(id, undefined);
  }

  public async setActivation(id: string, activated?: boolean): Promise<void> {
    await this.updateConfigs(configs => {
      const index = configs.findIndex(config => config.id === id);
      if (index === -1) {
        return configs;
      }

      const current = configs[index];
      const nextState = typeof activated === 'boolean' ? activated : !current.activated;
      configs[index] = { ...current, activated: nextState };
      return configs;
    });
  }

  public async addIgnoredTest(configId: string, testName: string): Promise<void> {
    await this.updateConfigs(configs => {
      const index = configs.findIndex(config => config.id === configId);
      if (index === -1) {
        return configs;
      }

      const current = configs[index];
      const existing = (current.ignoreList ?? '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      if (!existing.includes(testName)) {
        existing.push(testName);
      }

      configs[index] = { ...current, ignoreList: existing.join('\n') };
      return configs;
    });
  }

  /**
   * Discover tests and cache them in the tree provider.
   * This is the unified method that should be used to discover tests
   * and populate the sidebar view.
   */
  public async discoverAndCacheTests(config: TestRunnerConfig, treeProvider?: { cacheTests: (configId: string, tests: DiscoveredTest[]) => void }): Promise<DiscoveredTest[]> {
    const tests = await this.discoverTests(config);
    if (treeProvider) {
      treeProvider.cacheTests(config.id, tests);
    }
    return tests;
  }

  public async discoverTests(config: TestRunnerConfig): Promise<DiscoveredTest[]> {
    const { DebugLogger, DebugTag } = await import('../../src/utils/DebugLogger');
    
    DebugLogger.section(`Test Discovery: ${config.title || config.id}`);
    DebugLogger.log(DebugTag.DISCOVERY, `Starting discovery`, {
      configId: config.id,
      fileType: config.fileType,
      fileNamePattern: config.fileNamePattern,
      activated: config.activated
    });

    if (!vscode.workspace.workspaceFolders?.length) {
      DebugLogger.log(DebugTag.DISCOVERY, 'No workspace folders found');
      return [];
    }

    if (!config.activated) {
      DebugLogger.log(DebugTag.DISCOVERY, 'Config is not activated, skipping discovery');
      return [];
    }

    const includeGlob = this.getGlobForFileType(config.fileType);
    const excludeGlob = this.getIgnorePatterns(config.fileType);
    
    DebugLogger.log(DebugTag.DISCOVERY, `File search globs`, {
      include: includeGlob,
      exclude: excludeGlob
    });
    
    const files = await vscode.workspace.findFiles(includeGlob, excludeGlob);
    
    DebugLogger.log(DebugTag.DISCOVERY, `Found ${files.length} files matching file type`, {
      fileCount: files.length
    });
    
    const patternEntries = config.fileNamePattern
      .split(/\r?\n/)
      .map(pattern => pattern.trim())
      .filter(pattern => pattern.length > 0);

    DebugLogger.log(DebugTag.DISCOVERY, `Pattern matching`, {
      fileNamePattern: config.fileNamePattern,
      patternCount: patternEntries.length,
      patterns: patternEntries
    });

    const results: DiscoveredTest[] = [];
    let filesChecked = 0;
    let filesMatched = 0;
    const unmatchedFiles: string[] = [];

    for (const file of files) {
      const basename = path.basename(file.fsPath);
      const relativePath = vscode.workspace.asRelativePath(file, false).replace(/\\/g, '/');
      // Remove extension for pattern matching
      const basenameWithoutExt = basename.replace(/\.[^.]+$/, '');
      const pathWithoutExt = relativePath.replace(/\.[^.]+$/, '');

      // Check if any pattern matches
      let matches = false;
      for (const pattern of patternEntries) {
        const hasPathPattern = pattern.includes('/');
        
        if (hasPathPattern) {
          // Match against full relative path (without extension)
          if (this.matchesPattern(pathWithoutExt, pattern)) {
            matches = true;
            break;
          }
        } else {
          // Match against basename only (without extension)
          if (this.matchesPattern(basenameWithoutExt, pattern)) {
            matches = true;
            break;
          }
        }
      }

      if (!matches) {
        unmatchedFiles.push(`Path: ${relativePath}, Basename: ${basename}`);
        continue;
      }

      filesMatched++;
      try {
        const document = await vscode.workspace.openTextDocument(file);
        const tests = this.extractTestsFromDocument(document, config);
        results.push(...tests);
        
        if (tests.length > 0) {
          DebugLogger.log(DebugTag.DISCOVERY, `Extracted ${tests.length} test(s) from file`, {
            file: vscode.workspace.asRelativePath(file, false),
            testCount: tests.length
          });
        }
      } catch (error) {
        DebugLogger.log(DebugTag.DISCOVERY, `Error opening file`, {
          file: vscode.workspace.asRelativePath(file, false),
          error: error instanceof Error ? error.message : String(error)
        });
      }
      
      filesChecked++;
    }

    DebugLogger.log(DebugTag.DISCOVERY, `Discovery complete`, {
      totalFiles: files.length,
      filesChecked,
      filesMatched,
      testsFound: results.length,
      unmatchedSample: unmatchedFiles.slice(0, 5) // Show first 5 unmatched
    });

    return results;
  }

  public async getMatchingFiles(config: TestRunnerConfig): Promise<vscode.Uri[]> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return [];
    }

    if (!config.activated) {
      return [];
    }

    const includeGlob = this.getGlobForFileType(config.fileType);
    const excludeGlob = this.getIgnorePatterns(config.fileType);
    
    const files = await vscode.workspace.findFiles(includeGlob, excludeGlob);
    
    const patternEntries = config.fileNamePattern
      .split(/\r?\n/)
      .map(pattern => pattern.trim())
      .filter(pattern => pattern.length > 0);

    if (patternEntries.length === 0) {
      return files; // No pattern means match all files
    }

    const matchingFiles: vscode.Uri[] = [];

    for (const file of files) {
      const basename = path.basename(file.fsPath);
      const relativePath = vscode.workspace.asRelativePath(file, false).replace(/\\/g, '/');
      // Remove extension for pattern matching
      const basenameWithoutExt = basename.replace(/\.[^.]+$/, '');
      const pathWithoutExt = relativePath.replace(/\.[^.]+$/, '');

      // Check if any pattern matches
      let matches = false;
      for (const pattern of patternEntries) {
        const hasPathPattern = pattern.includes('/');
        
        if (hasPathPattern) {
          // Match against full relative path (without extension)
          if (this.matchesPattern(pathWithoutExt, pattern)) {
            matches = true;
            break;
          }
        } else {
          // Match against basename only (without extension)
          if (this.matchesPattern(basenameWithoutExt, pattern)) {
            matches = true;
            break;
          }
        }
      }

      if (matches) {
        matchingFiles.push(file);
      }
    }

    return matchingFiles;
  }

  public getConfigsForDocument(document: vscode.TextDocument): TestRunnerConfig[] {
    const basename = path.basename(document.uri.fsPath);
    const relativePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
    // Remove extension for pattern matching
    const basenameWithoutExt = basename.replace(/\.[^.]+$/, '');
    const pathWithoutExt = relativePath.replace(/\.[^.]+$/, '');

    return this.getConfigs().filter(config => {
      if (!config.activated) {
        return false;
      }

      if (!this.documentMatchesFileType(document, config.fileType)) {
        return false;
      }

      const patternEntries = config.fileNamePattern
        .split(/\r?\n/)
        .map(pattern => pattern.trim())
        .filter(pattern => pattern.length > 0);

      if (patternEntries.length === 0) {
        return true;
      }

      // Check if any pattern matches
      for (const pattern of patternEntries) {
        const hasPathPattern = pattern.includes('/');
        
        if (hasPathPattern) {
          // Match against full relative path (without extension)
          if (this.matchesPattern(pathWithoutExt, pattern)) {
            return true;
          }
        } else {
          // Match against basename only (without extension)
          if (this.matchesPattern(basenameWithoutExt, pattern)) {
            return true;
          }
        }
      }

      return false;
    });
  }

  public extractTestsFromDocument(document: vscode.TextDocument, config: TestRunnerConfig): DiscoveredTest[] {
    const strategy = this.getLanguagePattern(config.fileType);
    return strategy.extract(document, config);
  }

  private getLanguagePattern(fileType: TestRunnerConfig['fileType']): LanguagePattern {
    switch (fileType) {
      case 'python':
        return new PythonPattern();
      case 'typescript':
        return new TypeScriptPattern();
      case 'javascript':
      default:
        return new JavaScriptPattern();
    }
  }

  public async runTest(config: TestRunnerConfig, testName: string, additionalReplacements?: Record<string, string>): Promise<void> {
    const terminalConfig: TerminalConfig = {
      type: 'vscode-new',
      name: config.terminalName || config.title,
      cwd: config.workingDirectory || undefined
    };

    // Extract test case (class name) from test name
    // testName format: "ClassName.test_method" or "test_method"
    let testCase = '';
    const dotIndex = testName.indexOf('.');
    if (dotIndex > 0) {
      testCase = testName.substring(0, dotIndex);
    }

    // Build all test variables from file path
    let testFile = '';
    let testPath = '';
    let testExtension = '';
    let executableTestPath = '';
    
    if (additionalReplacements?.file) {
      const filePath = additionalReplacements.file;
      // Normalize path separators to forward slashes
      const normalizedPath = filePath.replace(/\\/g, '/');
      
      // Extract extension
      const extMatch = normalizedPath.match(/\.([^.]+)$/);
      testExtension = extMatch ? `.${extMatch[1]}` : '';
      
      // Remove extension to get base path
      const pathWithoutExt = normalizedPath.replace(/\.[^.]+$/, '');
      
      // Extract filename without extension
      const filenameWithExt = path.basename(normalizedPath);
      testFile = filenameWithExt.replace(/\.[^.]+$/, '');
      
      // Get relative path from workspace root (for test_path)
      let relativePath = pathWithoutExt;
      let moduleBasePath = pathWithoutExt;
      
      // Determine base path for Python module resolution
      // If workingDirectory is set, use it as the base; otherwise use workspace root
      let basePath = '';
      if (config.workingDirectory && vscode.workspace.workspaceFolders?.[0]) {
        // Resolve working directory relative to workspace root
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');
        const workingDir = path.resolve(workspaceRoot, config.workingDirectory).replace(/\\/g, '/');
        basePath = workingDir;
      } else if (vscode.workspace.workspaceFolders?.[0]) {
        basePath = vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');
      }
      
      if (basePath && normalizedPath.startsWith(basePath)) {
        moduleBasePath = normalizedPath.substring(basePath.length + 1); // +1 to remove leading /
        moduleBasePath = moduleBasePath.replace(/\.[^.]+$/, ''); // Remove extension
      }
      
      // For test_path, use workspace-relative path
      if (vscode.workspace.workspaceFolders?.[0]) {
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');
        if (normalizedPath.startsWith(workspaceRoot)) {
          relativePath = normalizedPath.substring(workspaceRoot.length + 1); // +1 to remove leading /
          relativePath = relativePath.replace(/\.[^.]+$/, ''); // Remove extension from relative path
        }
      }
      testPath = relativePath;
      
      // Build executable test path: convert module path to dots and append test name
      // test_name already includes TestCase.test_name format
      const pathWithDots = moduleBasePath.replace(/\//g, '.');
      executableTestPath = `${pathWithDots}.${testName}`;
    }

    const replacements: Record<string, string> = {
      test_name: testName,
      test_testcase: testCase,
      test_file: testFile,
      test_path: testPath,
      test_extension: testExtension,
      executable_test_path: executableTestPath,
      ...(additionalReplacements ?? {})
    };

    // Validate variables before executing
    this.validateVariables(config.runTestCommand);

    const command = this.injectVariables(config.runTestCommand, replacements);
    await this.terminalManager.executeCommand(command, terminalConfig);
  }

  /**
   * Run tests using a resolved path (for batch execution).
   * This executes a single command instead of looping through individual tests.
   */
  public async runTestsInPath(
    config: TestRunnerConfig,
    tests: DiscoveredTest[],
    pathType: 'file' | 'folder' | 'testcase',
    folderPath?: string,
    testCaseName?: string
  ): Promise<void> {
    if (tests.length === 0) {
      return;
    }

    const resolver = getResolver(config.fileType);
    let resolvedPath: string;

    switch (pathType) {
      case 'file':
        resolvedPath = resolver.resolveFilePath(tests, { workingDirectory: config.workingDirectory });
        break;
      case 'folder':
        if (!folderPath) {
          throw new Error('folderPath is required for folder execution');
        }
        resolvedPath = resolver.resolveFolderPath(tests, folderPath, { workingDirectory: config.workingDirectory });
        break;
      case 'testcase':
        if (!testCaseName) {
          throw new Error('testCaseName is required for test case execution');
        }
        resolvedPath = resolver.resolveTestCasePath(tests, testCaseName, { workingDirectory: config.workingDirectory });
        break;
      default:
        throw new Error(`Unknown path type: ${pathType}`);
    }

    // Use the resolved path as executable_test_path variable
    const terminalConfig: TerminalConfig = {
      type: 'vscode-new',
      name: config.terminalName || config.title,
      cwd: config.workingDirectory || undefined
    };

    // Get file path from first test for other variables
    const firstTest = tests[0];
    const filePath = firstTest.file.fsPath;
    const normalizedPath = filePath.replace(/\\/g, '/');
    const extMatch = normalizedPath.match(/\.([^.]+)$/);
    const testExtension = extMatch ? `.${extMatch[1]}` : '';
    const pathWithoutExt = normalizedPath.replace(/\.[^.]+$/, '');
    const filenameWithExt = path.basename(normalizedPath);
    const testFile = filenameWithExt.replace(/\.[^.]+$/, '');

    let testPath = '';
    if (vscode.workspace.workspaceFolders?.[0]) {
      const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');
      if (normalizedPath.startsWith(workspaceRoot)) {
        testPath = normalizedPath.substring(workspaceRoot.length + 1).replace(/\.[^.]+$/, '');
      }
    }

    const replacements: Record<string, string> = {
      executable_test_path: resolvedPath,
      test_file: testFile,
      test_path: testPath,
      test_extension: testExtension,
      file: filePath
    };

    // Validate variables before executing
    this.validateVariables(config.runTestCommand);

    const command = this.injectVariables(config.runTestCommand, replacements);
    await this.terminalManager.executeCommand(command, terminalConfig);
  }

  /**
   * Run tests using a resolved path and return result (for batch execution with status tracking).
   * This executes a single command instead of looping through individual tests.
   */
  public async runTestsInPathWithResult(
    config: TestRunnerConfig,
    tests: DiscoveredTest[],
    pathType: 'file' | 'folder' | 'testcase',
    folderPath?: string,
    testCaseName?: string
  ): Promise<boolean> {
    if (tests.length === 0) {
      return false;
    }

    const resolver = getResolver(config.fileType);
    let resolvedPath: string;

    switch (pathType) {
      case 'file':
        resolvedPath = resolver.resolveFilePath(tests, { workingDirectory: config.workingDirectory });
        break;
      case 'folder':
        if (!folderPath) {
          throw new Error('folderPath is required for folder execution');
        }
        resolvedPath = resolver.resolveFolderPath(tests, folderPath, { workingDirectory: config.workingDirectory });
        break;
      case 'testcase':
        if (!testCaseName) {
          throw new Error('testCaseName is required for test case execution');
        }
        resolvedPath = resolver.resolveTestCasePath(tests, testCaseName, { workingDirectory: config.workingDirectory });
        break;
      default:
        throw new Error(`Unknown path type: ${pathType}`);
    }

    // Use the resolved path as executable_test_path variable
    const terminalConfig: TerminalConfig = {
      type: 'vscode-new',
      name: config.terminalName || config.title,
      cwd: config.workingDirectory || undefined
    };

    // Get file path from first test for other variables
    const firstTest = tests[0];
    const filePath = firstTest.file.fsPath;
    const normalizedPath = filePath.replace(/\\/g, '/');
    const extMatch = normalizedPath.match(/\.([^.]+)$/);
    const testExtension = extMatch ? `.${extMatch[1]}` : '';
    const pathWithoutExt = normalizedPath.replace(/\.[^.]+$/, '');
    const filenameWithExt = path.basename(normalizedPath);
    const testFile = filenameWithExt.replace(/\.[^.]+$/, '');

    let testPath = '';
    if (vscode.workspace.workspaceFolders?.[0]) {
      const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');
      if (normalizedPath.startsWith(workspaceRoot)) {
        testPath = normalizedPath.substring(workspaceRoot.length + 1);
        testPath = testPath.replace(/\.[^.]+$/, '');
      }
    }

    const replacements: Record<string, string> = {
      executable_test_path: resolvedPath,
      test_file: testFile,
      test_path: testPath,
      test_extension: testExtension
    };

    // Validate variables before executing
    this.validateVariables(config.runTestCommand);

    const command = this.injectVariables(config.runTestCommand, replacements);
    const exitCode = await this.terminalManager.executeCommandWithExitCode(command, terminalConfig);
    return exitCode === 0;
  }

  private async runTestWithResultInTerminal(
    config: TestRunnerConfig,
    testName: string,
    terminalName: string,
    additionalReplacements?: Record<string, string>
  ): Promise<boolean> {
    const terminalConfig: TerminalConfig = {
      type: 'vscode-new',
      name: terminalName,
      cwd: config.workingDirectory || undefined
    };

    // Build all test variables from file path
    let testFile = '';
    let testPath = '';
    let testExtension = '';
    let executableTestPath = '';
    
    if (additionalReplacements?.file) {
      const filePath = additionalReplacements.file;
      // Normalize path separators to forward slashes
      const normalizedPath = filePath.replace(/\\/g, '/');
      
      // Extract extension
      const extMatch = normalizedPath.match(/\.([^.]+)$/);
      testExtension = extMatch ? `.${extMatch[1]}` : '';
      
      // Remove extension to get base path
      const pathWithoutExt = normalizedPath.replace(/\.[^.]+$/, '');
      
      // Extract filename without extension
      const filenameWithExt = path.basename(normalizedPath);
      testFile = filenameWithExt.replace(/\.[^.]+$/, '');
      
      // Get relative path from workspace root (for test_path)
      let relativePath = pathWithoutExt;
      let moduleBasePath = pathWithoutExt;
      
      // Determine base path for Python module resolution
      // If workingDirectory is set, use it as the base; otherwise use workspace root
      let basePath = '';
      if (config.workingDirectory && vscode.workspace.workspaceFolders?.[0]) {
        // Resolve working directory relative to workspace root
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');
        const workingDir = path.resolve(workspaceRoot, config.workingDirectory).replace(/\\/g, '/');
        basePath = workingDir;
      } else if (vscode.workspace.workspaceFolders?.[0]) {
        basePath = vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');
      }
      
      if (basePath && normalizedPath.startsWith(basePath)) {
        moduleBasePath = normalizedPath.substring(basePath.length + 1); // +1 to remove leading /
        moduleBasePath = moduleBasePath.replace(/\.[^.]+$/, ''); // Remove extension
      }
      
      // For test_path, use workspace-relative path
      if (vscode.workspace.workspaceFolders?.[0]) {
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');
        if (normalizedPath.startsWith(workspaceRoot)) {
          relativePath = normalizedPath.substring(workspaceRoot.length + 1); // +1 to remove leading /
          relativePath = relativePath.replace(/\.[^.]+$/, ''); // Remove extension from relative path
        }
      }
      testPath = relativePath;
      
      // Build executable test path: convert module path to dots and append test name
      // test_name already includes TestCase.test_name format
      const pathWithDots = moduleBasePath.replace(/\//g, '.');
      executableTestPath = `${pathWithDots}.${testName}`;
    }

    const replacements: Record<string, string> = {
      test_name: testName,
      test_file: testFile,
      test_path: testPath,
      test_extension: testExtension,
      executable_test_path: executableTestPath,
      ...(additionalReplacements ?? {})
    };

    // Validate variables before executing
    this.validateVariables(config.runTestCommand);
    
    const command = this.injectVariables(config.runTestCommand, replacements);
    const exitCode = await this.terminalManager.executeCommandWithExitCodeInSharedTerminal(command, terminalConfig);
    return exitCode === 0;
  }

  public async runTestWithResult(config: TestRunnerConfig, testName: string, additionalReplacements?: Record<string, string>): Promise<boolean> {
    const terminalConfig: TerminalConfig = {
      type: 'vscode-new',
      name: config.terminalName || config.title,
      cwd: config.workingDirectory || undefined
    };

    // Build all test variables from file path
    let testFile = '';
    let testPath = '';
    let testExtension = '';
    let executableTestPath = '';
    
    if (additionalReplacements?.file) {
      const filePath = additionalReplacements.file;
      // Normalize path separators to forward slashes
      const normalizedPath = filePath.replace(/\\/g, '/');
      
      // Extract extension
      const extMatch = normalizedPath.match(/\.([^.]+)$/);
      testExtension = extMatch ? `.${extMatch[1]}` : '';
      
      // Remove extension to get base path
      const pathWithoutExt = normalizedPath.replace(/\.[^.]+$/, '');
      
      // Extract filename without extension
      const filenameWithExt = path.basename(normalizedPath);
      testFile = filenameWithExt.replace(/\.[^.]+$/, '');
      
      // Get relative path from workspace root (for test_path)
      let relativePath = pathWithoutExt;
      let moduleBasePath = pathWithoutExt;
      
      // Determine base path for Python module resolution
      // If workingDirectory is set, use it as the base; otherwise use workspace root
      let basePath = '';
      if (config.workingDirectory && vscode.workspace.workspaceFolders?.[0]) {
        // Resolve working directory relative to workspace root
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');
        const workingDir = path.resolve(workspaceRoot, config.workingDirectory).replace(/\\/g, '/');
        basePath = workingDir;
      } else if (vscode.workspace.workspaceFolders?.[0]) {
        basePath = vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');
      }
      
      if (basePath && normalizedPath.startsWith(basePath)) {
        moduleBasePath = normalizedPath.substring(basePath.length + 1); // +1 to remove leading /
        moduleBasePath = moduleBasePath.replace(/\.[^.]+$/, ''); // Remove extension
      }
      
      // For test_path, use workspace-relative path
      if (vscode.workspace.workspaceFolders?.[0]) {
        const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath.replace(/\\/g, '/');
        if (normalizedPath.startsWith(workspaceRoot)) {
          relativePath = normalizedPath.substring(workspaceRoot.length + 1); // +1 to remove leading /
          relativePath = relativePath.replace(/\.[^.]+$/, ''); // Remove extension from relative path
        }
      }
      testPath = relativePath;
      
      // Build executable test path: convert module path to dots and append test name
      // test_name already includes TestCase.test_name format
      const pathWithDots = moduleBasePath.replace(/\//g, '.');
      executableTestPath = `${pathWithDots}.${testName}`;
    }

    const replacements: Record<string, string> = {
      test_name: testName,
      test_file: testFile,
      test_path: testPath,
      test_extension: testExtension,
      executable_test_path: executableTestPath,
      ...(additionalReplacements ?? {})
    };

    // Validate variables before executing
    this.validateVariables(config.runTestCommand);
    
    const command = this.injectVariables(config.runTestCommand, replacements);
    const exitCode = await this.terminalManager.executeCommandWithExitCode(command, terminalConfig);
    return exitCode === 0;
  }

  public async runAll(
    config?: TestRunnerConfig,
    treeProvider?: { setTestsStatus?: (tests: DiscoveredTest[], status: 'idle' | 'running' | 'passed' | 'failed') => void; refresh?: (item?: any) => void }
  ): Promise<void> {
    this.cancelRunAllRequested = false;
    const configs = config ? [config] : this.getConfigs().filter(entry => entry.activated);
    
    // Count total tests across all configs
    let totalTests = 0;
    const configTestCounts: Array<{ config: TestRunnerConfig; count: number }> = [];
    
    for (const runner of configs) {
      const tests = await this.discoverTests(runner);
      const count = tests.length;
      totalTests += count;
      configTestCounts.push({ config: runner, count });
    }
    
    // Show confirmation dialog
    if (totalTests === 0) {
      vscode.window.showInformationMessage('No tests found to run.');
      return;
    }
    
    const configDetails = configTestCounts
      .filter(ctc => ctc.count > 0)
      .map(ctc => `  • ${ctc.config.title || ctc.config.id}: ${ctc.count} test(s)`)
      .join('\n');
    
    const message = totalTests === 1
      ? `Run 1 test?`
      : `Run ${totalTests} tests?\n\n${configDetails}`;
    
    const confirmed = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      'Run',
      'Cancel'
    );
    
    if (confirmed !== 'Run') {
      return;
    }
    
    // Collect all tests with their configs
    const allTests: Array<{ test: DiscoveredTest; config: TestRunnerConfig }> = [];
    for (const runner of configs) {
      const tests = await this.discoverTests(runner);
      for (const test of tests) {
        allTests.push({ test, config: runner });
      }
    }

    // Run tests in parallel with max concurrency of 6
    const MAX_CONCURRENT = 6;
    let currentIndex = 0;

    const runTestTask = async (testItem: { test: DiscoveredTest; config: TestRunnerConfig }): Promise<void> => {
      if (this.cancelRunAllRequested) {
        return;
      }

      const { test, config } = testItem;
      
      // Mark running in tree (if provider available)
      try { 
        treeProvider?.setTestsStatus?.([test], 'running'); 
        treeProvider?.refresh?.(); 
      } catch {}

      // Use individual terminal names for parallel execution
      const terminalName = `Test Runner: ${config.title || config.id} - ${test.label}`;
      
      const passed = await this.runTestWithResultInTerminal(config, test.label, terminalName, {
        file: test.file.fsPath,
        line: String(test.line + 1)
      });

      // Update status icon according to exit code
      try { 
        treeProvider?.setTestsStatus?.([test], passed ? 'passed' : 'failed'); 
        treeProvider?.refresh?.(); 
      } catch {}
    };

    // Process tests in batches with concurrency limit
    while (currentIndex < allTests.length && !this.cancelRunAllRequested) {
      const batch = allTests.slice(currentIndex, currentIndex + MAX_CONCURRENT);
      await Promise.all(batch.map(runTestTask));
      currentIndex += MAX_CONCURRENT;
    }

    // Final refresh to ensure all parent statuses are updated
    if (treeProvider?.refresh) {
      treeProvider.refresh();
    }
  }

  private async updateConfigs(updater: (configs: TestRunnerConfig[]) => TestRunnerConfig[]): Promise<void> {
    const config = this.configManager.getConfig();
    const updated = updater([...(config.testRunners ?? [])]);
    config.testRunners = updated;
    await this.configManager.saveConfig(config);
    this._onDidChange.fire();
  }

  private createPatternSet(patterns: string): PatternSet {
    const entries = patterns
      .split(/\r?\n/)
      .map(pattern => pattern.trim())
      .filter(pattern => pattern.length > 0);

    const matchers = entries.map(pattern => this.patternToRegex(pattern));
    return { matchers };
  }

  private matchesAnyPattern(value: string, set: PatternSet): boolean {
    if (set.matchers.length === 0) {
      return true;
    }

    const matches = set.matchers.some(regex => regex.test(value));
    return matches;
  }

  private matchesPattern(value: string, pattern: string): boolean {
    if (!pattern || pattern.trim().length === 0) {
      return true;
    }

    // Remove file extension from pattern if it exists
    const patternWithoutExt = pattern.replace(/\.[^.]+$/, '');
    const regex = this.patternToRegex(patternWithoutExt);
    
    // Remove file extension from value
    const valueWithoutExt = value.replace(/\.[^.]+$/, '');
    
    return regex.test(valueWithoutExt);
  }

  private patternToRegex(pattern: string): RegExp {
    // Handle empty patterns - match everything
    if (!pattern || pattern.trim().length === 0) {
      return new RegExp('.*', 'i');
    }
    
    // Check if this is a path pattern (contains /)
    const isPathPattern = pattern.includes('/');
    
    // For path patterns that don't start with *, automatically allow anything before
    // This makes patterns like "tests/classes/*.py" match "flowchart/tests/classes/test_classes.py"
    let normalizedPattern = pattern;
    if (isPathPattern && !pattern.startsWith('*') && !pattern.startsWith('/')) {
      normalizedPattern = '*' + pattern;
    }
    
    // First, handle wildcards by replacing * with a placeholder
    // Then escape special regex characters
    // Finally replace the placeholder with .*
    const placeholder = '__WILDCARD_PLACEHOLDER__';
    const withPlaceholders = normalizedPattern.replace(/\*/g, placeholder);
    
    // Escape special regex characters (but not our placeholder)
    const escaped = withPlaceholders.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    
    // Replace placeholder with regex wildcard .*
    const wildcard = escaped.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '.*');
    
    // For path patterns, allow matching anywhere in the path (no start anchor if pattern starts with wildcard)
    // For non-path patterns (basename), always anchor at start
    let regexPattern = wildcard;
    if (isPathPattern && (normalizedPattern.startsWith('*') || normalizedPattern.startsWith('.*'))) {
      // Path pattern with leading wildcard - match anywhere in path, but anchor at end
      if (!regexPattern.endsWith('$')) {
        regexPattern = regexPattern + '$';
      }
    } else {
      // Basename pattern or path pattern without leading wildcard - anchor at both ends
      if (!regexPattern.startsWith('^')) {
        regexPattern = '^' + regexPattern;
      }
      if (!regexPattern.endsWith('$')) {
        regexPattern = regexPattern + '$';
      }
    }
    
    // Validate the regex before creating it
    try {
      return new RegExp(regexPattern, 'i');
    } catch (error) {
      // If regex is invalid, fallback to matching everything silently
      return new RegExp('.*', 'i');
    }
  }

  private extractTestName(line: string, fileType: TestRunnerConfig['fileType'], extractAllFunctions: boolean = false): string | undefined {
    if (fileType === 'python') {
      // Match pytest-style: def test_something()
      const pytestMatch = line.match(/^\s*def\s+(test_\w+)/i);
      if (pytestMatch) {
        return pytestMatch[1];
      }
      
      // Match unittest-style: def testSomething(self) or def test_something(self)
      const unittestMatch = line.match(/^\s*def\s+(test\w+)\s*\(/i);
      if (unittestMatch) {
        return unittestMatch[1];
      }
      
      // DO NOT match classes as tests - only test methods should be discovered
      // Classes will be automatically handled via the class prefix we add to test methods
      
      // If extractAllFunctions is true and test name pattern is "*", extract ALL functions
      if (extractAllFunctions) {
        // Match any function: def function_name()
        const anyFunctionMatch = line.match(/^\s*def\s+(\w+)\s*\(/);
        if (anyFunctionMatch) {
          return anyFunctionMatch[1];
        }
        
        // DO NOT extract classes - only functions/methods
      }
      
      return undefined;
    }

    const jsMatch = line.match(/\b(?:it|test|describe)\s*\(\s*['"`]([^'"`]+)['"`]/i);
    return jsMatch?.[1];
  }

  private getGlobForFileType(fileType: TestRunnerConfig['fileType']): string {
    switch (fileType) {
      case 'typescript':
        return '**/*.{ts,tsx,mts,cts}';
      case 'python':
        return '**/*.py';
      case 'javascript':
      default:
        return '**/*.{js,jsx,mjs,cjs}';
    }
  }

  /**
   * Get language-specific ignore patterns for test discovery.
   */
  private getIgnorePatterns(fileType: TestRunnerConfig['fileType']): string {
    const commonIgnores = ['node_modules', '.git'];
    const languageIgnores: Record<TestRunnerConfig['fileType'], string[]> = {
      javascript: ['out', 'dist', 'build', '.next', '.cache', '.nyc_output', 'coverage'],
      typescript: ['out', 'dist', 'build', '.next', '.cache', '.nyc_output', 'coverage'],
      python: ['__pycache__', '.env', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '*.egg-info', '.tox', '.coverage', 'htmlcov']
    };

    const ignores = [...commonIgnores, ...(languageIgnores[fileType] || [])];
    return `**/{${ignores.join(',')}}/**`;
  }

  private documentMatchesFileType(document: vscode.TextDocument, fileType: TestRunnerConfig['fileType']): boolean {
    const ext = path.extname(document.uri.fsPath).toLowerCase();
    switch (fileType) {
      case 'typescript':
        return ['.ts', '.tsx', '.mts', '.cts'].includes(ext);
      case 'python':
        return ext === '.py';
      case 'javascript':
      default:
        return ['.js', '.jsx', '.mjs', '.cjs'].includes(ext);
    }
  }

  private injectVariables(template: string, replacements: Record<string, string>): string {
    let result = template;
    
    // Pattern to match variables with options: $var:option1:option2=value
    // Supports: $executable_test_path:trimparent=1, $test_path:dot, etc.
    const variablePattern = /\$(\w+)((?::[\w=]+)+)/g;
    const processedMatches = new Set<string>();
    let match: RegExpExecArray | null;
    
    // First pass: handle variables with options
    while ((match = variablePattern.exec(template)) !== null) {
      const [fullMatch, varName, options] = match;
      if (processedMatches.has(fullMatch)) continue;
      processedMatches.add(fullMatch);
      
      const baseValue = replacements[varName] || '';
      if (!baseValue) {
        result = result.replace(fullMatch, '');
        continue;
      }
      
      let formattedValue = baseValue;
      const optionParts = options.split(':').filter(Boolean);
      
      // For executable_test_path, always use dot format (ignore :dot, :slash, :hyphen)
      if (varName === 'executable_test_path') {
        formattedValue = baseValue.replace(/[\/\\]/g, '.');
        
        // Parse trimparent option
        for (const option of optionParts) {
          if (option.startsWith('trimparent=')) {
            const trimCount = parseInt(option.substring('trimparent='.length), 10);
            if (!isNaN(trimCount) && trimCount > 0) {
              // Split by dots and remove the specified number of parent segments
              const parts = formattedValue.split('.');
              if (parts.length > trimCount) {
                formattedValue = parts.slice(trimCount).join('.');
              } else {
                formattedValue = parts[parts.length - 1]; // Keep at least the last part
              }
            }
          }
        }
      } else {
        // For other variables, support dot, slash, hyphen formats
        for (const option of optionParts) {
          switch (option) {
            case 'dot':
              formattedValue = formattedValue.replace(/[\/\\]/g, '.');
              break;
            case 'slash':
              formattedValue = formattedValue.replace(/[\\]/g, '/');
              break;
            case 'hyphen':
              formattedValue = formattedValue.replace(/[\/\\\.]/g, '-');
              break;
          }
        }
      }
      
      result = result.replace(fullMatch, formattedValue);
    }
    
    // Second pass: handle simple variables without options
    // For executable_test_path, default to dot format
    for (const [key, value] of Object.entries(replacements)) {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const simplePattern = new RegExp(`\\$${escapedKey}(?!:)`, 'g');
      
      if (key === 'executable_test_path') {
        // Always use dot format for executable_test_path
        const dotFormatted = value.replace(/[\/\\]/g, '.');
        result = result.replace(simplePattern, dotFormatted);
      } else {
        result = result.replace(simplePattern, value);
      }
    }
    
    return result;
  }

  private validateVariables(command: string): void {
    const validVariables = ['test_name', 'test_testcase', 'test_file', 'test_path', 'test_extension', 'executable_test_path', 'file', 'line'];
    const validFormats = ['dot', 'slash', 'hyphen'];
    
    // Extract all variables with options (e.g., $var:option1:option2=value)
    const variablePattern = /\$(\w+)((?::[\w=]+)+)?/g;
    const foundVariables = new Set<string>();
    const invalidOptions = new Set<string>();
    let match: RegExpExecArray | null;
    
    while ((match = variablePattern.exec(command)) !== null) {
      const varName = match[1];
      const options = match[2] || '';
      
      // Check if variable name is valid
      if (!validVariables.includes(varName)) {
        foundVariables.add(varName);
        continue;
      }
      
      // Parse options
      if (options) {
        const optionParts = options.split(':').filter(Boolean);
        for (const option of optionParts) {
          if (option.startsWith('trimparent=')) {
            // Validate trimparent option
            const trimValue = option.substring('trimparent='.length);
            const trimCount = parseInt(trimValue, 10);
            if (isNaN(trimCount) || trimCount < 0) {
              invalidOptions.add(`trimparent=${trimValue}`);
            }
          } else if (varName === 'executable_test_path') {
            // For executable_test_path, ignore dot/slash/hyphen (they're ignored anyway)
            // But don't throw error for backwards compatibility
          } else if (!validFormats.includes(option)) {
            invalidOptions.add(option);
          }
        }
      }
    }
    
    const invalidVariables = Array.from(foundVariables);
    if (invalidVariables.length > 0) {
      throw new Error(
        `Invalid variable(s) in test command: ${invalidVariables.map(v => `$${v}`).join(', ')}. ` +
        `Available variables: ${validVariables.map(v => `$${v}`).join(', ')}.`
      );
    }
    
    if (invalidOptions.size > 0) {
      throw new Error(
        `Invalid option(s) in test command: ${Array.from(invalidOptions).join(', ')}. ` +
        `Valid options: ${validFormats.join(', ')}, trimparent=number.`
      );
    }
  }

}

// Language pattern strategy interfaces and implementations
interface LanguagePattern {
  extract(document: vscode.TextDocument, config: TestRunnerConfig): DiscoveredTest[];
}

class BasePattern {
  protected createPatternSet(patterns: string): { matchers: RegExp[] } {
    const entries = (patterns || '')
      .split(/\r?\n/)
      .map(p => p.trim())
      .filter(Boolean);
    return { matchers: entries.map(p => this.patternToRegex(p)) };
  }

  protected patternToRegex(pattern: string): RegExp {
    if (!pattern || pattern.trim().length === 0) return new RegExp('.*', 'i');
    // Convert wildcard pattern to regex directly
    // Split by * to handle multiple wildcards, then join with .*
    const parts = pattern.split('*');
    // Escape each part (except the wildcards which are represented by the splits)
    const escapedParts = parts.map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
    // Join with .* (regex for any characters)
    const regexPattern = escapedParts.join('.*');
    // Add anchors
    let finalPattern = regexPattern;
    if (!finalPattern.startsWith('^')) finalPattern = '^' + finalPattern;
    if (!finalPattern.endsWith('$')) finalPattern = finalPattern + '$';
    try { return new RegExp(finalPattern, 'i'); } catch { return new RegExp('.*', 'i'); }
  }

  protected matchesAny(value: string, set: { matchers: RegExp[] }): boolean {
    if (set.matchers.length === 0) return true;
    return set.matchers.some(r => r.test(value));
  }

  /**
   * Check if a test should be ignored based on ignore patterns.
   * Checks both test name and file path (including folder paths).
   * Supports wildcards in patterns (e.g., "*burlap*", "tests/burlap/*").
   */
  protected shouldIgnoreTest(testName: string, filePath: string, ignorePatterns: { matchers: RegExp[] }): boolean {
    if (ignorePatterns.matchers.length === 0) return false;
    
    // Normalize path separators
    const relativePath = filePath.replace(/\\/g, '/');
    // Get path without extension for matching
    const pathWithoutExt = relativePath.replace(/\.[^.]+$/, '');
    // Get folder path (directory part, without filename)
    const folderPath = relativePath.substring(0, relativePath.lastIndexOf('/')) || '.';
    // Get individual folder names in the path
    const folderParts = folderPath.split('/').filter(Boolean);
    
    // Check if any ignore pattern matches:
    // 1. Test name (e.g., "test_legacy")
    // 2. Full file path without extension (e.g., "tests/burlap/test_file")
    // 3. Folder path (e.g., "tests/burlap" or "tests/integration/burlap")
    // 4. Any individual folder name (e.g., "burlap" will match if folder is "burlap")
    // 5. Full path with extension (for patterns like "*burlap*.js")
    
    // Check test name
    if (this.matchesAny(testName, ignorePatterns)) return true;
    
    // Check full path (supports wildcards like "*burlap*")
    if (this.matchesAny(relativePath, ignorePatterns)) return true;
    
    // Check path without extension
    if (this.matchesAny(pathWithoutExt, ignorePatterns)) return true;
    
    // Check folder path (supports patterns like "tests/burlap/*" or "*burlap*")
    if (this.matchesAny(folderPath, ignorePatterns)) return true;
    
    // Check each folder name individually (supports patterns like "burlap" or "*burlap*")
    for (const folder of folderParts) {
      if (this.matchesAny(folder, ignorePatterns)) return true;
    }
    
    return false;
  }
}

class PythonPattern extends BasePattern implements LanguagePattern {
  extract(document: vscode.TextDocument, config: TestRunnerConfig): DiscoveredTest[] {
    const lines = document.getText().split(/\r?\n/);
    const ignorePatterns = this.createPatternSet(config.ignoreList ?? '');
    const testNamePatterns = this.createPatternSet(config.testNamePattern);
    const allowNonTest = config.allowNonTest === true;
    const matchAll = allowNonTest && (testNamePatterns.matchers.length === 0 || (testNamePatterns.matchers.length === 1 && testNamePatterns.matchers[0].toString() === '/^.*$/i'));

    // Get relative file path for ignore checking
    const relativeFilePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');

    // Gather class definitions
    const classDefs: Array<{ name: string; indent: number; lineIdx: number }> = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)class\s+(\w+)/);
      if (m) classDefs.push({ name: m[2], indent: m[1].length, lineIdx: i });
    }

    const results: DiscoveredTest[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match only test methods (do not treat classes as tests)
      const pyTest = line.match(/^\s*def\s+(test_\w+)/i) || line.match(/^\s*def\s+(test\w+)\s*\(/i) || (matchAll ? line.match(/^\s*def\s+(\w+)\s*\(/) : null);
      if (!pyTest) continue;
      const method = pyTest[1];
      const methodIndent = (line.match(/^(\s*)/)?.[1].length) || 0;

      // Find innermost containing class
      let qualified = method;
      const containing = classDefs
        .filter(c => c.lineIdx < i && methodIndent > c.indent)
        .sort((a, b) => {
          if (b.indent !== a.indent) {
            return b.indent - a.indent;
          }
          return b.lineIdx - a.lineIdx;
        });
      if (containing.length > 0) {
        qualified = `${containing[0].name}.${method}`;
      }

      // Match test name pattern against method name only (not class name)
      // This allows ANY test case class name to match
      if (!this.matchesAny(method, testNamePatterns)) continue;
      // Check ignore patterns against both test name and file/folder path
      if (this.shouldIgnoreTest(qualified, relativeFilePath, ignorePatterns)) continue;

      const position = new vscode.Position(i, Math.max(0, line.indexOf(method)));
      const range = new vscode.Range(position, position);
      const id = `${config.id}:${document.uri.toString()}:${i}`;
      results.push({ id, configId: config.id, label: qualified, file: document.uri, line: i, range });
    }

    return results;
  }
}

class JavaScriptPattern extends BasePattern implements LanguagePattern {
  extract(document: vscode.TextDocument, config: TestRunnerConfig): DiscoveredTest[] {
    const lines = document.getText().split(/\r?\n/);
    const ignorePatterns = this.createPatternSet(config.ignoreList ?? '');
    const testNamePatterns = this.createPatternSet(config.testNamePattern);
    
    // Get relative file path for ignore checking
    const relativeFilePath = vscode.workspace.asRelativePath(document.uri, false).replace(/\\/g, '/');
    
    const results: DiscoveredTest[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/\b(?:it|test)\s*\(\s*['"`]([^'"`]+)['"`]/i);
      if (!m) continue;
      const name = m[1];
      if (!this.matchesAny(name, testNamePatterns)) continue;
      // Check ignore patterns against both test name and file/folder path
      if (this.shouldIgnoreTest(name, relativeFilePath, ignorePatterns)) continue;
      const col = Math.max(0, line.indexOf(m[0]));
      const range = new vscode.Range(new vscode.Position(i, col), new vscode.Position(i, col));
      const id = `${config.id}:${document.uri.toString()}:${i}`;
      results.push({ id, configId: config.id, label: name, file: document.uri, line: i, range });
    }
    return results;
  }
}

class TypeScriptPattern extends JavaScriptPattern {}
