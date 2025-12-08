import * as vscode from 'vscode';
import { TimeTrackerManager } from './TimeTrackerManager';
import { TimeTrackerTreeItem } from './TimeTrackerTreeItem';
import { Timer, TimerFolder, SubTimer } from '../../src/types';
import { ConfigManager } from '../../src/config/ConfigManager';

export class TimeTrackerTreeProvider implements vscode.TreeDataProvider<TimeTrackerTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<TimeTrackerTreeItem | undefined | null | void> = new vscode.EventEmitter<TimeTrackerTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TimeTrackerTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private manager: TimeTrackerManager;
  private updateInterval?: NodeJS.Timeout;

  constructor() {
    this.manager = TimeTrackerManager.getInstance();

    // Subscribe to manager change events (replaces config manager callback)
    this.manager.onDidChange(() => this.refresh());

    // Keep interval for live elapsed time updates (but only for running timers)
    // This is necessary because elapsed time changes every second even without state changes
    this.updateInterval = setInterval(() => {
      this.refresh();
    }, 10000); // Update every 10 seconds
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: TimeTrackerTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: TimeTrackerTreeItem): Thenable<TimeTrackerTreeItem[]> {
    if (!element) {
      // Root level - show folders and root-level timers
      return this.getRootItems();
    } else if (element.type === 'folder') {
      // Folder level - show timers and subfolders
      return this.getFolderChildren(element);
    } else if (element.type === 'timer') {
      // Timer level - show subtimers if they exist
      return this.getTimerChildren(element);
    } else {
      // Subtimer level - no children
      return Promise.resolve([]);
    }
  }

  public getParent(element: TimeTrackerTreeItem): TimeTrackerTreeItem | undefined {
    return element.parent;
  }

  private async getRootItems(): Promise<TimeTrackerTreeItem[]> {
    // Access config through ConfigManager
    const configManager = ConfigManager.getInstance();
    const config = configManager.getTimeTrackerConfig();
    
    // Check if time tracking is enabled
    if (config.enabled === false) {
      return []; // Return empty if disabled
    }
    
    const items: TimeTrackerTreeItem[] = [];

    // Collect all archived timers from all folders
    const archivedTimers: Timer[] = [];
    const collectArchivedTimers = (folders: TimerFolder[]): void => {
      for (const folder of folders) {
        folder.timers.forEach(timer => {
          if (timer.archived) {
            archivedTimers.push(timer);
          }
        });
        if (folder.subfolders) {
          collectArchivedTimers(folder.subfolders);
        }
      }
    };
    collectArchivedTimers(config.folders);

    // Collect all branch timers from all folders
    const branchTimers: Timer[] = [];
    const collectBranchTimers = (folders: TimerFolder[]): void => {
      for (const folder of folders) {
        folder.timers.forEach(timer => {
          if (timer.branchName && !timer.archived) {
            branchTimers.push(timer);
          }
        });
        if (folder.subfolders) {
          collectBranchTimers(folder.subfolders);
        }
      }
    };
    collectBranchTimers(config.folders);

    // Always add Git Branches folder (even when empty) so the toggle button is always visible
    const gitBranchesFolder: TimerFolder = {
      name: 'Git Branches',
      timers: branchTimers,
      subfolders: []
    };
    items.push(new TimeTrackerTreeItem(gitBranchesFolder, 'folder', undefined, [-2], undefined, false, true)); // -2 indicates special git branches folder, isArchiveFolder=false, isGitBranchesFolder=true

    // Add archived folder if there are archived timers
    if (archivedTimers.length > 0) {
      const archiveFolder: TimerFolder = {
        name: 'Archived',
        timers: archivedTimers,
        subfolders: []
      };
      items.push(new TimeTrackerTreeItem(archiveFolder, 'folder', undefined, [-1], undefined, true)); // -1 indicates special archive folder
    }

    // Create a set of branch timer IDs to exclude them from other locations
    const branchTimerIds = new Set(branchTimers.map(t => t.id));

    // Add folders (skip empty root folder, but show its timers)
    config.folders.forEach((folder, index) => {
      if (folder.name === '') {
        // Root level folder - add its timers directly, but exclude branch timers (they're in Git Branches folder)
        folder.timers.forEach((timer, timerIndex) => {
          if (!timer.archived && !branchTimerIds.has(timer.id)) {
            items.push(new TimeTrackerTreeItem(timer, 'timer', undefined, [], timerIndex));
          }
        });
      } else {
        // Regular folder - only add if it has non-branch timers or subfolders
        const hasNonBranchTimers = folder.timers.some(t => !t.archived && !branchTimerIds.has(t.id));
        const hasSubfolders = folder.subfolders && folder.subfolders.length > 0;
        if (hasNonBranchTimers || hasSubfolders) {
          items.push(new TimeTrackerTreeItem(folder, 'folder', undefined, [index]));
        }
      }
    });

    return items;
  }

  private async getFolderChildren(folderElement: TimeTrackerTreeItem): Promise<TimeTrackerTreeItem[]> {
    const folder = folderElement.getFolder();
    if (!folder) {
      return [];
    }

    const items: TimeTrackerTreeItem[] = [];

    // Check if this is a special folder
    const folderPath = folderElement.getFolderPath();
    const isArchiveFolder = folderPath.length === 1 && folderPath[0] === -1;
    const isGitBranchesFolder = folderPath.length === 1 && folderPath[0] === -2;

    // Get all branch timer IDs to exclude them from regular folders
    const configManager = ConfigManager.getInstance();
    const config = configManager.getTimeTrackerConfig();
    const branchTimerIds = new Set<string>();
    const collectBranchTimerIds = (folders: TimerFolder[]): void => {
      for (const f of folders) {
        f.timers.forEach(timer => {
          if (timer.branchName && !timer.archived) {
            branchTimerIds.add(timer.id);
          }
        });
        if (f.subfolders) {
          collectBranchTimerIds(f.subfolders);
        }
      }
    };
    collectBranchTimerIds(config.folders);

    // Add subfolders first (special folders don't have subfolders)
    if (!isArchiveFolder && !isGitBranchesFolder && folder.subfolders) {
      folder.subfolders.forEach((subfolder, index) => {
        const subfolderPath = [...folderElement.getFolderPath(), index];
        items.push(new TimeTrackerTreeItem(subfolder, 'folder', folderElement, subfolderPath));
      });
    }

    // Add timers
    // For archive folder, show all archived timers
    // For git branches folder, show all branch timers (non-archived) - collect them dynamically
    // For regular folders, show only non-archived timers and exclude branch timers (they're in Git Branches folder)
    let timersToShow: Timer[];
    if (isArchiveFolder) {
      timersToShow = folder.timers;
    } else if (isGitBranchesFolder) {
      // Re-collect branch timers dynamically for Git Branches folder
      const branchTimers: Timer[] = [];
      const collectBranchTimers = (folders: TimerFolder[]): void => {
        for (const f of folders) {
          f.timers.forEach(timer => {
            if (timer.branchName && !timer.archived) {
              branchTimers.push(timer);
            }
          });
          if (f.subfolders) {
            collectBranchTimers(f.subfolders);
          }
        }
      };
      collectBranchTimers(config.folders);
      timersToShow = branchTimers;
    } else {
      timersToShow = folder.timers.filter(timer => !timer.archived && !branchTimerIds.has(timer.id));
    }
    
    timersToShow.forEach((timer, index) => {
      const timerIndex = folder.timers.indexOf(timer);
      items.push(new TimeTrackerTreeItem(timer, 'timer', folderElement, folderElement.getFolderPath(), timerIndex));
    });

    return items;
  }

  private async getTimerChildren(timerElement: TimeTrackerTreeItem): Promise<TimeTrackerTreeItem[]> {
    const timer = timerElement.getTimer();
    if (!timer || !timer.subtimers || timer.subtimers.length === 0) {
      // Timer should always have subtimers, but if it doesn't, return empty array
      return [];
    }

    const items: TimeTrackerTreeItem[] = [];
    timer.subtimers.forEach((subtimer, index) => {
      items.push(new TimeTrackerTreeItem(subtimer, 'subtimer', timerElement, timerElement.getFolderPath(), index));
    });

    return items;
  }

  /**
   * Dispose of resources.
   */
  public dispose(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }
    this._onDidChangeTreeData.dispose();
  }
}
