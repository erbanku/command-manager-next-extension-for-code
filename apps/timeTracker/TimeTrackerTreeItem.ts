import * as vscode from 'vscode';
import { Timer, TimerFolder, SubTimer } from '../../src/types';
import { TimerHelpers } from './utils/TimerHelpers';

export class TimeTrackerTreeItem extends vscode.TreeItem {
  public readonly subtimer?: SubTimer;

  constructor(
    public readonly item: Timer | TimerFolder | SubTimer,
    public readonly type: 'timer' | 'folder' | 'subtimer',
    public readonly parent?: TimeTrackerTreeItem,
    public readonly path: number[] = [],
    public readonly timerIndex?: number,
    public readonly isArchiveFolder: boolean = false,
    public readonly isGitBranchesFolder: boolean = false
  ) {
    const label = type === 'folder' 
      ? (item as TimerFolder).name 
      : type === 'subtimer'
      ? (item as SubTimer).label
      : (item as Timer).label;

    // Timers always have subtimers, so they're always collapsible
    const hasSubtimers = type === 'timer' && (item as Timer).subtimers && (item as Timer).subtimers.length > 0;
    const collapsible = type === 'folder' 
      ? vscode.TreeItemCollapsibleState.Collapsed 
      : type === 'timer'
      ? vscode.TreeItemCollapsibleState.Collapsed // Timers always have subtimers, so always collapsible
      : vscode.TreeItemCollapsibleState.None;

    super(label, collapsible);

    if (type === 'folder') {
      const pathKey = path.length ? path.join('/') : 'root';
      this.id = `timer-folder:${pathKey}`;
      if (this.isArchiveFolder) {
        this.contextValue = 'timerArchiveFolder';
        this.iconPath = new vscode.ThemeIcon('archive');
      } else if (this.isGitBranchesFolder) {
        this.contextValue = 'timerGitBranchesFolder';
        this.iconPath = new vscode.ThemeIcon('git-branch');
      } else {
        this.contextValue = 'timerFolder';
        this.iconPath = this.getFolderIcon();
      }
    } else if (type === 'subtimer') {
      const subtimer = item as SubTimer;
      this.subtimer = subtimer;
      this.id = `subtimer:${subtimer.id}`;
      this.contextValue = subtimer.endTime ? 'subtimerStopped' : 'subtimerRunning';
      this.iconPath = this.getSubTimerIcon();
      this.description = this.getSubTimerDescription();
      this.tooltip = this.getSubTimerTooltip();
    } else {
      const timer = item as Timer;
      this.id = `timer:${timer.id}`;
      // Timer is running if it has at least one running subtimer
      const hasRunningSubtimer = timer.subtimers && timer.subtimers.some(st => !st.endTime);
      // Check if timer has any subtimers (started before)
      const hasSubtimers = timer.subtimers && timer.subtimers.length > 0;
      // Set contextValue based on timer state and whether it's archived
      let baseContextValue: string;
      if (timer.archived) {
        baseContextValue = hasRunningSubtimer ? 'timerRunning timerArchived' : 'timerStopped timerArchived';
      } else {
        baseContextValue = hasRunningSubtimer ? 'timerRunning' : 'timerStopped';
      }
      // Add hasSubtimers flag to distinguish between new timers and timers with existing subtimers
      if (hasSubtimers) {
        this.contextValue = baseContextValue + ' timerHasSubtimers';
      } else {
        this.contextValue = baseContextValue;
      }
      this.iconPath = this.getTimerIcon();
      this.description = this.getTimerDescription();
      this.tooltip = this.getTimerTooltip();
    }
  }

  private getFolderIcon(): vscode.ThemeIcon | string {
    const folder = this.item as TimerFolder;
    if (folder.icon) {
      const iconName = folder.icon.startsWith('$(') && folder.icon.endsWith(')')
        ? folder.icon.slice(2, -1)
        : folder.icon;
      return new vscode.ThemeIcon(iconName);
    }
    return new vscode.ThemeIcon('folder');
  }

  private getTimerIcon(): vscode.ThemeIcon {
    const timer = this.item as Timer;
    // Timer is running if it has at least one running subtimer
    const hasRunningSubtimer = timer.subtimers && timer.subtimers.some(st => !st.endTime);
    if (hasRunningSubtimer) {
      return new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.green')); // Running timer
    } else {
      return new vscode.ThemeIcon('clock'); // Stopped timer
    }
  }

  private getTimerDescription(): string {
    const timer = this.item as Timer;
    if (!timer.subtimers || timer.subtimers.length === 0) {
      return '0s';
    }

    // Calculate total elapsed time from all subtimers
    let totalDuration = 0;
    let hasRunningSubtimer = false;

    for (const subtimer of timer.subtimers) {
      const elapsed = this.calculateSubtimerElapsedTime(subtimer);
      totalDuration += elapsed;
      
      if (!subtimer.endTime) {
        hasRunningSubtimer = true;
      }
    }

    const description = this.formatDuration(totalDuration);
    return hasRunningSubtimer ? description + ' (running)' : description;
  }

  private formatDuration(ms: number): string {
    return TimerHelpers.formatElapsedTime(ms);
  }

  private getTimerTooltip(): string {
    const timer = this.item as Timer;
    const start = new Date(timer.startTime);
    let tooltip = `Timer: ${timer.label}\nStarted: ${start.toLocaleString()}`;
    
    // Calculate total duration from subtimers
    if (timer.subtimers && timer.subtimers.length > 0) {
      let totalDuration = 0;
      let hasRunningSubtimer = false;
      for (const subtimer of timer.subtimers) {
        if (subtimer.endTime) {
          const stStart = new Date(subtimer.startTime);
          const stEnd = new Date(subtimer.endTime);
          totalDuration += stEnd.getTime() - stStart.getTime();
        } else {
          const stStart = new Date(subtimer.startTime);
          const now = new Date();
          totalDuration += now.getTime() - stStart.getTime();
          hasRunningSubtimer = true;
        }
      }
      tooltip += `\nTotal Duration: ${this.formatDuration(totalDuration)}`;
      tooltip += hasRunningSubtimer ? '\nStatus: Running' : '\nStatus: Stopped';
      tooltip += `\nSessions: ${timer.subtimers.length}`;
    } else {
      tooltip += '\nDuration: 0s\nStatus: No sessions';
    }
    
    if (timer.branchName) {
      tooltip += `\nBranch: ${timer.branchName}`;
    }
    
    return tooltip;
  }

  public isFolder(): boolean {
    return this.type === 'folder';
  }

  public isTimer(): boolean {
    return this.type === 'timer';
  }

  public getFolder(): TimerFolder | undefined {
    return this.type === 'folder' ? (this.item as TimerFolder) : undefined;
  }

  public getTimer(): Timer | undefined {
    return this.type === 'timer' ? (this.item as Timer) : undefined;
  }

  public getFolderPath(): number[] {
    return this.path;
  }

  private getSubTimerIcon(): vscode.ThemeIcon {
    const subtimer = this.item as SubTimer;
    if (subtimer.endTime) {
      return new vscode.ThemeIcon('clock'); // Stopped subtimer
    } else {
      return new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.blue')); // Running subtimer
    }
  }

  private calculateSubtimerElapsedTime(subtimer: SubTimer): number {
    return TimerHelpers.calculateSubtimerElapsed(subtimer, Date.now());
  }

  private getSubTimerDescription(): string {
    const subtimer = this.item as SubTimer;
    const elapsed = this.calculateSubtimerElapsedTime(subtimer);
    const description = this.formatDuration(elapsed);
    return subtimer.endTime ? description : description + ' (running)';
  }

  private getSubTimerTooltip(): string {
    const subtimer = this.item as SubTimer;
    const start = new Date(subtimer.startTime);
    let tooltip = `SubTimer: ${subtimer.label}`;
    
    if (subtimer.description) {
      tooltip += `\nDescription: ${subtimer.description}`;
    }
    
    // Calculate elapsed time (using the helper method that accounts for pauses)
    const elapsedMs = this.calculateSubtimerElapsedTime(subtimer);
    const elapsed = this.formatDuration(elapsedMs);
    
    tooltip += `\n\nStart Time: ${start.toLocaleString()}`;
    if (subtimer.endTime) {
      tooltip += `\nEnd Time: ${new Date(subtimer.endTime).toLocaleString()}`;
      tooltip += `\nStatus: Stopped`;
    } else {
      tooltip += `\nEnd Time: -`;
      tooltip += `\nStatus: Running`;
    }
    tooltip += `\nElapsed: ${elapsed}`;
    
    return tooltip;
  }

  public isSubTimer(): boolean {
    return this.type === 'subtimer';
  }

  public getSubTimer(): SubTimer | undefined {
    return this.type === 'subtimer' ? (this.item as SubTimer) : undefined;
  }

  public isArchiveFolderItem(): boolean {
    return this.type === 'folder' && this.isArchiveFolder;
  }
}

