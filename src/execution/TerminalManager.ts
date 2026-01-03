import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import { TerminalConfig } from '../types';

export class TerminalManager {
  private static instance: TerminalManager;
  private terminals: Map<string, vscode.Terminal> = new Map();
  private readonly closeListener: vscode.Disposable;
  private customRunner?: (command: string, config: TerminalConfig) => Promise<void>;

  private constructor() {
    this.closeListener = vscode.window.onDidCloseTerminal(terminal => {
      const entriesToDelete: string[] = [];
      for (const [name, trackedTerminal] of this.terminals.entries()) {
        if (trackedTerminal === terminal) {
          entriesToDelete.push(name);
        }
      }

      for (const name of entriesToDelete) {
        this.terminals.delete(name);
      }
    });
  }

  public static getInstance(): TerminalManager {
    if (!TerminalManager.instance) {
      TerminalManager.instance = new TerminalManager();
    }
    return TerminalManager.instance;
  }

  public async executeCommand(command: string, config: TerminalConfig): Promise<void> {
    if (this.customRunner) {
      // When using custom runner, still create/manage terminal if name is provided
      if (config.name && config.type === 'vscode-new') {
        const terminalName = config.name;
        // Check if terminal exists and dispose it before creating a new one
        let terminal = this.terminals.get(terminalName);
        if (terminal) {
          if (!this.isTerminalDisposed(terminal)) {
            terminal.dispose();
          }
          this.terminals.delete(terminalName);
        }
        // Create a new terminal even with custom runner for tracking
        terminal = this.createManagedTerminal(terminalName);
        this.terminals.set(terminalName, terminal);
      }
      await this.customRunner(command, config);
      return;
    }

    switch (config.type) {
      case 'vscode-current':
        await this.executeInCurrentTerminal(command, config);
        break;
      case 'vscode-new':
        await this.executeInNewTerminal(command, config);
        break;
      case 'external-cmd':
        await this.executeInExternalCmd(command, config);
        break;
      case 'external-powershell':
        await this.executeInExternalPowerShell(command, config);
        break;
      default:
        throw new Error(`Unknown terminal type: ${config.type}`);
    }
  }

  // Run a command via child_process and resolve with its exit code
  public async executeCommandWithExitCode(command: string, config: TerminalConfig): Promise<number> {
    // Use VS Code Tasks but ensure working directory is properly set
    // Convert relative cwd to absolute if needed
    let cwd = config.cwd;
    if (cwd && !path.isAbsolute(cwd) && vscode.workspace.workspaceFolders?.[0]) {
      cwd = path.resolve(vscode.workspace.workspaceFolders[0].uri.fsPath, cwd);
    } else if (!cwd && vscode.workspace.workspaceFolders?.[0]) {
      cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
    }

    const envEntries = Object.entries(process.env as Record<string, string | undefined>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    const safeEnv = Object.fromEntries(envEntries) as Record<string, string>;
    const shellOptions: vscode.ShellExecutionOptions = {
      cwd: cwd,
      env: safeEnv
    };
    const shellExec = new vscode.ShellExecution(command, shellOptions);

    const task = new vscode.Task(
      { type: 'shell' },
      vscode.TaskScope.Workspace,
      config.name || 'Test Runner',
      'Commands Manager Next',
      shellExec,
      []
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated
    };

    return await new Promise<number>((resolve, reject) => {
      let disposable: vscode.Disposable | undefined;
      disposable = vscode.tasks.onDidEndTaskProcess((e) => {
        try {
          if (e.execution.task === task) {
            disposable?.dispose();
            resolve(typeof e.exitCode === 'number' ? e.exitCode : -1);
          }
        } catch (err) {
          disposable?.dispose();
          reject(err);
        }
      });

      vscode.tasks.executeTask(task).then(undefined, reject);
    });
  }

  // Run a command in a shared terminal panel (for batch execution)
  public async executeCommandWithExitCodeInSharedTerminal(command: string, config: TerminalConfig): Promise<number> {
    // Use VS Code Tasks with a shared panel so all tasks run in the same terminal
    let cwd = config.cwd;
    if (cwd && !path.isAbsolute(cwd) && vscode.workspace.workspaceFolders?.[0]) {
      cwd = path.resolve(vscode.workspace.workspaceFolders[0].uri.fsPath, cwd);
    } else if (!cwd && vscode.workspace.workspaceFolders?.[0]) {
      cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
    }

    const envEntries = Object.entries(process.env as Record<string, string | undefined>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    const safeEnv = Object.fromEntries(envEntries) as Record<string, string>;
    const shellOptions: vscode.ShellExecutionOptions = {
      cwd: cwd,
      env: safeEnv
    };
    const shellExec = new vscode.ShellExecution(command, shellOptions);

    // Use a consistent task name for shared panel
    const taskName = config.name || 'Test Runner';
    const task = new vscode.Task(
      { type: 'shell' },
      vscode.TaskScope.Workspace,
      `${taskName} - ${Date.now()}`, // Unique name for each task
      'Commands Manager Next',
      shellExec,
      []
    );
    // Use Shared panel so all tasks run in the same terminal panel
    // Tasks with Shared panel and same task name will share the panel
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Shared
    };

    return await new Promise<number>((resolve, reject) => {
      let disposable: vscode.Disposable | undefined;
      disposable = vscode.tasks.onDidEndTaskProcess((e) => {
        try {
          if (e.execution.task === task) {
            disposable?.dispose();
            resolve(typeof e.exitCode === 'number' ? e.exitCode : -1);
          }
        } catch (err) {
          disposable?.dispose();
          reject(err);
        }
      });

      vscode.tasks.executeTask(task).then(undefined, reject);
    });
  }

  private async executeInCurrentTerminal(command: string, config: TerminalConfig): Promise<void> {
    const activeTerminal = vscode.window.activeTerminal;
    if (!activeTerminal) {
      // Create a new terminal if none exists
      const baseName = config.name || 'Commands Manager Next';
      const terminalInstance = this.createManagedTerminal(baseName);
      this.terminals.set(baseName, terminalInstance);
      terminalInstance.show();
      await this.executeInTerminal(terminalInstance, command, config);
    } else {
      await this.executeInTerminal(activeTerminal, command, config);
    }
  }

  private async executeInNewTerminal(command: string, config: TerminalConfig): Promise<void> {
    const { DebugLogger, DebugTag } = await import('../utils/DebugLogger');
    const terminalName = config.name || 'Commands Manager Next';

    DebugLogger.log(DebugTag.TERMINAL, `Executing in new terminal`, {
      terminalName,
      command,
      existingTerminals: Array.from(this.terminals.keys())
    });

    // Check if terminal exists and dispose it before creating a new one
    let terminal = this.terminals.get(terminalName);

    if (terminal) {
      DebugLogger.log(DebugTag.TERMINAL, `Found existing terminal, disposing`, {
        terminalName,
        isDisposed: this.isTerminalDisposed(terminal)
      });
      // Dispose existing terminal before creating a new one
      if (!this.isTerminalDisposed(terminal)) {
        terminal.dispose();
      }
      this.terminals.delete(terminalName);
    }

    // Create a new terminal
    terminal = this.createManagedTerminal(terminalName);
    this.terminals.set(terminalName, terminal);

    DebugLogger.log(DebugTag.TERMINAL, `Created new terminal`, {
      terminalName,
      actualName: terminal.name,
      terminalCount: this.terminals.size
    });

    terminal.show();
    await this.executeInTerminal(terminal, command, config);
  }

  private async executeInTerminal(terminal: vscode.Terminal, command: string, config: TerminalConfig): Promise<void> {
    // Change directory if specified
    if (config.cwd) {
      terminal.sendText(`cd "${config.cwd}"`);
    }

    terminal.sendText(command);
  }

  private async executeInExternalCmd(command: string, config: TerminalConfig): Promise<void> {
    const args = ['/c', 'start', '""', 'cmd.exe', '/k', command];

    if (config.cwd) {
      args.splice(2, 0, '/d', config.cwd);
    }

    const process = child_process.spawn('cmd.exe', args, {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true
    });

    process.unref();
  }

  private async executeInExternalPowerShell(command: string, config: TerminalConfig): Promise<void> {
    const script = `& { ${command} }`;
    const args = ['-NoExit', '-Command', script];

    const process = child_process.spawn('powershell.exe', args, {
      cwd: config.cwd,
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true
    });

    process.unref();
  }

  public getTerminal(name: string): vscode.Terminal | undefined {
    const terminal = this.terminals.get(name);
    // Also check if there's a terminal with the exact name in VS Code's terminals
    if (!terminal) {
      const vscodeTerminal = vscode.window.terminals.find(t => t.name === name);
      if (vscodeTerminal) {
        // Track it if found
        this.terminals.set(name, vscodeTerminal);
        return vscodeTerminal;
      }
    }
    return terminal;
  }

  public disposeTerminal(name: string): void {
    const terminal = this.terminals.get(name);
    if (terminal) {
      terminal.dispose();
      this.terminals.delete(name);
    }
  }

  public disposeAllTerminals(): void {
    this.terminals.forEach((terminal, name) => {
      terminal.dispose();
    });
    this.terminals.clear();
  }

  public async showTerminal(name: string): Promise<void> {
    const terminal = this.terminals.get(name);
    if (terminal) {
      terminal.show();
    }
  }

  public listTerminals(): string[] {
    return Array.from(this.terminals.keys());
  }

  public setRunner(runner?: (command: string, config: TerminalConfig) => Promise<void>): void {
    this.customRunner = runner;
  }

  private isTerminalDisposed(terminal: vscode.Terminal): boolean {
    return typeof terminal.exitStatus !== 'undefined';
  }

  private createManagedTerminal(baseName: string): vscode.Terminal {
    const existingNames = new Set(vscode.window.terminals.map(term => term.name));

    if (!existingNames.has(baseName)) {
      return vscode.window.createTerminal(baseName);
    }

    let attempt = 1;
    let candidate = `${baseName} #${attempt}`;
    while (existingNames.has(candidate)) {
      attempt += 1;
      candidate = `${baseName} #${attempt}`;
    }

    return vscode.window.createTerminal(candidate);
  }
}
