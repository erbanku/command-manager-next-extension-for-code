import * as vscode from 'vscode';
import { TimeTrackerManager } from './TimeTrackerManager';
import { Timer, SubTimer } from '../../src/types';
import { TimerHelpers } from './utils/TimerHelpers';

export class TimeTrackerStatusBar implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;
  private updateInterval?: NodeJS.Timeout;
  private timeTrackerManager: TimeTrackerManager;

  constructor(context: vscode.ExtensionContext) {
    this.timeTrackerManager = TimeTrackerManager.getInstance();
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.statusBarItem.command = 'commands-manager-next.time.focusView';
    context.subscriptions.push(this.statusBarItem);

    // Subscribe to manager change events
    this.timeTrackerManager.onDidChange(() => this.update());

    // Keep interval for live elapsed time updates
    // This is necessary because elapsed time changes every second even without state changes
    this.updateInterval = setInterval(() => {
      this.update();
    }, 30000);

    // Initial update
    this.update();
  }

  public update(): void {
    // Check if time tracking is enabled
    if (!this.timeTrackerManager.isEnabled()) {
      this.statusBarItem.hide();
      return;
    }

    const config = this.timeTrackerManager.getConfig();

    // Get all running timers
    const runningTimer = this.getRunningTimer();
    
    if (!runningTimer) {
      this.statusBarItem.hide();
      return;
    }

    // Calculate elapsed time
    const elapsedTime = this.calculateElapsedTime(runningTimer);
    const formattedTime = this.formatTime(elapsedTime);

    // Truncate timer name to 20 characters
    const timerLabel = runningTimer.label.length > 20 
      ? runningTimer.label.substring(0, 20) + '...' 
      : runningTimer.label;

    this.statusBarItem.text = `$(play) ${timerLabel}: ${formattedTime}`;
    this.statusBarItem.tooltip = `Timer: ${runningTimer.label}\nElapsed: ${formattedTime}`;
    this.statusBarItem.show();
  }

  private getRunningTimer(): Timer | null {
    const config = this.timeTrackerManager.getConfig();
    const runningTimers = TimerHelpers.getRunningTimers(config.folders || []);
    return runningTimers.length > 0 ? runningTimers[0] : null;
  }

  private calculateElapsedTime(timer: Timer): number {
    // CRITICAL BUG FIX: Use TimerHelpers.calculateTimerElapsed which properly accounts for pause/resume
    // Old implementation incorrectly calculated endTime - startTime, ignoring pauses
    const totalMs = TimerHelpers.calculateTimerElapsed(timer, Date.now());
    return Math.floor(totalMs / 1000); // Return seconds
  }

  private formatTime(seconds: number): string {
    // Convert seconds to milliseconds for TimerHelpers.formatElapsedTime
    return TimerHelpers.formatElapsedTime(seconds * 1000);
  }

  public dispose(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    this.statusBarItem.dispose();
  }

  public getConfig(): any {
    return this.timeTrackerManager.getConfig();
  }
}

