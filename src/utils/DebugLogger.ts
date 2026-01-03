import * as vscode from 'vscode';

export enum DebugTag {
  DISCOVERY = '[ Discovery ]',
  TERMINAL = '[ Terminal ]',
  VARIABLE = '[ Variable ]',
  MOVE = '[ Move ]',
  RESOLVER = '[ Resolver ]',
  TEST_RUNNER = '[ TestRunner ]'
}

export class DebugLogger {
  private static enabled = false;
  private static outputChannel: vscode.OutputChannel | undefined;

  public static initialize(): void {
    if (!this.outputChannel) {
      this.outputChannel = vscode.window.createOutputChannel('Commands Manager Next Debug');
    }
  }

  public static setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.initialize();
      this.outputChannel?.show(true);
    }
  }

  public static log(tag: DebugTag, message: string, details?: any): void {
    if (!this.enabled) {
      return;
    }

    this.initialize();

    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const logMessage = `${timestamp} ${tag} ${message}`;

    if (this.outputChannel) {
      this.outputChannel.appendLine(logMessage);
      if (details !== undefined) {
        this.outputChannel.appendLine(JSON.stringify(details, null, 2));
      }
      this.outputChannel.appendLine('-------------------------');
    }
  }

  public static section(title: string): void {
    if (!this.enabled) {
      return;
    }

    this.initialize();
    const separator = '='.repeat(60);
    if (this.outputChannel) {
      this.outputChannel.appendLine('');
      this.outputChannel.appendLine(separator);
      this.outputChannel.appendLine(`  ${title}`);
      this.outputChannel.appendLine(separator);
    }
  }

  public static show(): void {
    if (this.outputChannel) {
      this.outputChannel.show(true);
    }
  }
}
