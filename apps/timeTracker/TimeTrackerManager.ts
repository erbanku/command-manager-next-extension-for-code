import * as vscode from 'vscode';
import { ConfigManager } from '../../src/config/ConfigManager';
import { Timer, TimerFolder, TimeTrackerConfig, SubTimer } from '../../src/types';
import * as crypto from 'crypto';

export class TimeTrackerManager {
  private static instance: TimeTrackerManager;
  private static readonly PERIODIC_SAVE_INTERVAL_MS = 30 * 1000;
  private static readonly ELAPSED_DRIFT_TOLERANCE_MS = TimeTrackerManager.PERIODIC_SAVE_INTERVAL_MS * 3;
  private configManager: ConfigManager;
  private currentBranch?: string;
  private activeTimers: Map<string, Timer> = new Map(); // Timer ID -> Timer
  private workspaceState?: vscode.Memento;

  private constructor() {
    this.configManager = ConfigManager.getInstance();
    this.configManager.setOnTimeTrackerChange(() => {
      // Refresh active timers from config
      this.refreshActiveTimers();
    });
    this.refreshActiveTimers();
  }

  public setWorkspaceState(workspaceState: vscode.Memento): void {
    this.workspaceState = workspaceState;
  }

  public static getInstance(): TimeTrackerManager {
    if (!TimeTrackerManager.instance) {
      TimeTrackerManager.instance = new TimeTrackerManager();
    }
    return TimeTrackerManager.instance;
  }

  private getConfigInternal(): TimeTrackerConfig {
    const config = this.configManager.getTimeTrackerConfig();
    if (!config.folders) {
      config.folders = [];
    }
    if (!config.ignoredBranches) {
      config.ignoredBranches = [];
    }
    if (config.enabled === undefined) {
      config.enabled = true;
    }
    if (config.autoCreateOnBranchCheckout === undefined) {
      config.autoCreateOnBranchCheckout = true;
    }
    return config;
  }

  private calculateCurrentElapsedTime(subtimer: SubTimer, referenceTimeMs: number): number {
    const baseElapsed = subtimer.totalElapsedTime ?? 0;
    if (!subtimer.endTime) {
      const resumeSource = subtimer.lastResumeTime ?? subtimer.startTime;
      const resumeTime = new Date(resumeSource).getTime();
      if (!Number.isFinite(resumeTime)) {
        return baseElapsed;
      }
      const delta = referenceTimeMs - resumeTime;
      if (delta > 0) {
        return baseElapsed + delta;
      }
    }
    return baseElapsed;
  }

  private syncLastPersistedElapsedTime(subtimer: SubTimer, elapsedMs: number): boolean {
    const sanitized = Math.max(0, Math.floor(elapsedMs));
    if (subtimer.lastPersistedElapsedTime === undefined || Math.abs(subtimer.lastPersistedElapsedTime - sanitized) > 10) {
      subtimer.lastPersistedElapsedTime = sanitized;
      return true;
    }
    return false;
  }

  private detectAndHandleUnexpectedShutdown(timer: Timer, subtimer: SubTimer, nowMs: number): boolean {
    // Only detect if there's a persisted elapsed time to compare against
    if (subtimer.lastPersistedElapsedTime === undefined) {
      return false;
    }

    // When resuming a paused subtimer, check the gap between when it was paused and now
    // If it was paused, use endTime; if it was running, use lastResumeTime
    const previousStopTime = subtimer.endTime 
      ? new Date(subtimer.endTime).getTime()
      : (subtimer.lastResumeTime ? new Date(subtimer.lastResumeTime).getTime() : new Date(subtimer.startTime).getTime());
    
    // Calculate expected elapsed time based on current state
    // If paused, expected elapsed is just the accumulated time (no new time since pause)
    // If was running (which shouldn't happen when resuming), calculate from last resume
    const currentElapsed = subtimer.endTime
      ? (subtimer.totalElapsedTime ?? 0) // Paused: no new time accumulated
      : this.calculateCurrentElapsedTime(subtimer, nowMs); // Was running (edge case)
    
    // Calculate the time gap since last known state
    const timeGap = nowMs - previousStopTime;
    
    // The drift is the difference between what we expect based on last persist and what we calculate now
    // If subtimer was paused, we use the paused elapsed time
    // If there's a large time gap (> tolerance) between when it was paused/resumed and now,
    // it likely means VS Code was closed
    const expectedElapsed = currentElapsed;
    const drift = Math.abs(expectedElapsed - subtimer.lastPersistedElapsedTime);

    // If drift is too large (> 90 seconds), or if there's a large time gap, VS Code was likely closed unexpectedly
    const largeTimeGap = timeGap > TimeTrackerManager.ELAPSED_DRIFT_TOLERANCE_MS;
    const largeDrift = drift > TimeTrackerManager.ELAPSED_DRIFT_TOLERANCE_MS;

    if (largeTimeGap || largeDrift) {
      // Use the minimum of expected and persisted to avoid inflating time
      const previousElapsedMs = subtimer.lastPersistedElapsedTime ?? 0;
      const baseline = Math.min(expectedElapsed, previousElapsedMs);
      const normalizedBaseline = Math.max(0, Math.floor(baseline));

      subtimer.totalElapsedTime = normalizedBaseline;
      subtimer.lastPersistedElapsedTime = normalizedBaseline;

      const previousElapsedFormatted = this.formatElapsedForLog(previousElapsedMs);
      const newElapsedFormatted = this.formatElapsedForLog(normalizedBaseline);
      this.addLog(timer, `[${subtimer.label}] - VS Code closed unexpectedly. Restored elapsed time from ${previousElapsedFormatted} to ${newElapsedFormatted}.`);
      return true;
    }

    return false;
  }

  private formatElapsedForLog(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts: string[] = [];
    if (hours > 0) {
      parts.push(`${hours}h`);
    }
    if (minutes > 0 || hours > 0) {
      parts.push(`${minutes}m`);
    }
    parts.push(`${seconds}s`);

    return parts.join(' ');
  }

  public getConfig(): TimeTrackerConfig {
    return this.getConfigInternal();
  }

  private async saveConfig(config: TimeTrackerConfig): Promise<void> {
    await this.configManager.saveTimeTrackerConfig(config);
  }

  public async setEnabled(enabled: boolean): Promise<void> {
    const config = this.getConfigInternal();
    const wasEnabled = config.enabled !== false;
    config.enabled = enabled;
    
    // If disabling, pause all running timers
    if (!enabled && wasEnabled) {
      await this.stopAllTimers();
    }
    
    await this.saveConfig(config);
  }

  public isEnabled(): boolean {
    const config = this.getConfigInternal();
    return config.enabled !== false;
  }

  public async setAutoCreateOnBranchCheckout(enabled: boolean): Promise<void> {
    const config = this.getConfigInternal();
    config.autoCreateOnBranchCheckout = enabled;
    await this.saveConfig(config);
  }

  public isAutoCreateOnBranchCheckoutEnabled(): boolean {
    const config = this.getConfigInternal();
    return config.autoCreateOnBranchCheckout !== false;
  }

  private refreshActiveTimers(): void {
    const config = this.getConfigInternal();
    this.activeTimers.clear();
    const findAllTimers = (folders: TimerFolder[]): void => {
      for (const folder of folders) {
        for (const timer of folder.timers) {
          // Timer is active if it has at least one running subtimer and is not archived
          if (!timer.archived && timer.subtimers && timer.subtimers.some(st => !st.endTime)) {
            this.activeTimers.set(timer.id, timer);
          }
        }
        if (folder.subfolders) {
          findAllTimers(folder.subfolders);
        }
      }
    };
    findAllTimers(config.folders);
  }

  public async startTimer(label: string, folderPath?: number[]): Promise<Timer> {
    const config = this.getConfigInternal();
    
    // Stop any currently running timers (pause all their subtimers)
    await this.stopAllTimers();

    const timer: Timer = {
      id: crypto.randomUUID(),
      label: label || 'Untitled Timer',
      startTime: new Date().toISOString(),
      archived: false,
      folderPath: folderPath,
      branchName: undefined, // Will be set if auto-created from branch
      subtimers: [], // Initialize with empty array
      logs: []
    };
    
    // Log timer creation
    this.addLog(timer, `Timer created`);
    this.addLog(timer, `VS Code opened and started`);

    if (folderPath && folderPath.length > 0) {
      // Add to specific folder
      const folder = this.getFolderAtPath(config.folders, folderPath);
      if (folder) {
        folder.timers.push(timer);
      } else {
        // Folder doesn't exist, add to root
        const rootTimers = this.getRootLevelTimers(config);
        rootTimers.push(timer);
        timer.folderPath = undefined;
      }
    } else {
      // Add to root level (no category)
      const rootTimers = this.getRootLevelTimers(config);
      rootTimers.push(timer);
      timer.folderPath = undefined;
    }

    await this.saveConfig(config);

    // Always create "Session 1" subtimer when starting a timer
    await this.createSubTimer(timer.id, 'Session 1:', undefined, true);

    return timer;
  }

  private getRootLevelTimers(config: TimeTrackerConfig): Timer[] {
    // Create a special root folder if it doesn't exist
    let rootFolder = config.folders.find(f => f.name === '');
    if (!rootFolder) {
      rootFolder = {
        name: '',
        timers: [],
        subfolders: []
      };
      config.folders.unshift(rootFolder);
    }
    return rootFolder.timers;
  }

  private addLog(timer: Timer, message: string): void {
    if (!timer.logs) {
      timer.logs = [];
    }
    const timestamp = new Date().toLocaleTimeString();
    timer.logs.push(`${timestamp} - ${message}`);
    // Keep only last 1000 logs to prevent excessive storage
    if (timer.logs.length > 1000) {
      timer.logs = timer.logs.slice(-1000);
    }
  }

  private getFolderAtPath(folders: TimerFolder[], path: number[]): TimerFolder | undefined {
    if (path.length === 0) return undefined;
    let current: TimerFolder | undefined = folders[path[0]];
    for (let i = 1; i < path.length; i++) {
      if (!current?.subfolders) return undefined;
      current = current.subfolders[path[i]];
    }
    return current;
  }

  public async stopTimer(timerId: string): Promise<void> {
    const config = this.getConfigInternal();
    const timer = this.findTimerInConfig(config, timerId);
    if (timer && timer.subtimers) {
      // Pause all running subtimers
      let changed = false;
      for (const subtimer of timer.subtimers) {
        if (!subtimer.endTime) {
          // Accumulate elapsed time before stopping
          const now = new Date();
          const lastResumeTime = subtimer.lastResumeTime ? new Date(subtimer.lastResumeTime) : new Date(subtimer.startTime);
          const elapsedThisSegment = now.getTime() - lastResumeTime.getTime();
          
          if (subtimer.totalElapsedTime === undefined) {
            subtimer.totalElapsedTime = elapsedThisSegment;
          } else {
            subtimer.totalElapsedTime += elapsedThisSegment;
          }
          
          subtimer.endTime = now.toISOString();
          this.syncLastPersistedElapsedTime(subtimer, subtimer.totalElapsedTime ?? 0);
          changed = true;
        }
      }
      if (changed) {
        this.activeTimers.delete(timerId);
        await this.saveConfig(config);
      }
    }
  }

  public async stopAllTimers(excludeTimerId?: string): Promise<void> {
    const config = this.getConfigInternal();
    let changed = false;
    const pausedTimerIds = new Set<string>();
    const pauseAllSubtimers = (folders: TimerFolder[]): void => {
      for (const folder of folders) {
        for (const timer of folder.timers) {
          if (excludeTimerId && timer.id === excludeTimerId) {
            continue;
          }
          let timerChanged = false;
          if (timer.subtimers) {
            for (const subtimer of timer.subtimers) {
              if (!subtimer.endTime) {
                // Accumulate elapsed time before stopping
                const now = new Date();
                const lastResumeTime = subtimer.lastResumeTime ? new Date(subtimer.lastResumeTime) : new Date(subtimer.startTime);
                const elapsedThisSegment = now.getTime() - lastResumeTime.getTime();
                
                if (subtimer.totalElapsedTime === undefined) {
                  subtimer.totalElapsedTime = elapsedThisSegment;
                } else {
                  subtimer.totalElapsedTime += elapsedThisSegment;
                }
                
                subtimer.endTime = now.toISOString();
                this.syncLastPersistedElapsedTime(subtimer, subtimer.totalElapsedTime ?? 0);
                this.addLog(timer, `[${subtimer.label}] - Paused`);
                timerChanged = true;
                changed = true;
              }
            }
          }
          if (timerChanged) {
            pausedTimerIds.add(timer.id);
          }
        }
        if (folder.subfolders) {
          pauseAllSubtimers(folder.subfolders);
        }
      }
    };
    pauseAllSubtimers(config.folders);
    for (const pausedId of pausedTimerIds) {
      this.activeTimers.delete(pausedId);
    }
    if (changed) {
      await this.saveConfig(config);
    }
  }

  private findTimerInConfig(config: TimeTrackerConfig, timerId: string): Timer | undefined {
    const searchInFolders = (folders: TimerFolder[]): Timer | undefined => {
      for (const folder of folders) {
        const timer = folder.timers.find(t => t.id === timerId);
        if (timer) return timer;
        if (folder.subfolders) {
          const found = searchInFolders(folder.subfolders);
          if (found) return found;
        }
      }
      return undefined;
    };
    return searchInFolders(config.folders);
  }

  public async editTimer(timerId: string, updates: Partial<Timer>): Promise<void> {
    const config = this.getConfigInternal();
    const timer = this.findTimerInConfig(config, timerId);
    if (timer) {
      // Don't allow editing endTime directly - timers don't have endTime anymore
      if ('endTime' in updates) {
        delete (updates as any).endTime;
      }
      Object.assign(timer, updates);
      await this.saveConfig(config);
      // Update active timers map based on subtimer status
      if (!timer.archived && timer.subtimers && timer.subtimers.some(st => !st.endTime)) {
        this.activeTimers.set(timerId, timer);
      } else {
        this.activeTimers.delete(timerId);
      }
    }
  }

  public async deleteTimer(timerId: string): Promise<void> {
    const config = this.getConfigInternal();
    const deleteFromFolders = (folders: TimerFolder[]): boolean => {
      for (const folder of folders) {
        const index = folder.timers.findIndex(t => t.id === timerId);
        if (index !== -1) {
          folder.timers.splice(index, 1);
          return true;
        }
        if (folder.subfolders && deleteFromFolders(folder.subfolders)) {
          return true;
        }
      }
      return false;
    };
    if (deleteFromFolders(config.folders)) {
      this.activeTimers.delete(timerId);
      await this.saveConfig(config);
    }
  }

  public async resumeTimer(timerId: string): Promise<void> {
    const config = this.getConfigInternal();
    const timer = this.findTimerInConfig(config, timerId);
    if (timer && timer.subtimers && timer.subtimers.length > 0) {
      // Stop any currently running timers (consistent with startTimer behavior)
      await this.stopAllTimers();
      
      // Resume: start the last session (subtimer)
      const lastSubtimer = timer.subtimers[timer.subtimers.length - 1];
      if (lastSubtimer.endTime) {
        await this.startSubTimer(timerId, lastSubtimer.id);
        if (!timer.archived) {
          this.activeTimers.set(timerId, timer);
        }
      }
    }
  }

  public async archiveTimer(timerId: string, archived: boolean): Promise<void> {
    const config = this.getConfigInternal();
    const timer = this.findTimerInConfig(config, timerId);
    if (timer) {
      // If archiving, pause all subtimers first
      if (archived && timer.subtimers) {
        let hasRunningSubtimer = false;
        for (const subtimer of timer.subtimers) {
          if (!subtimer.endTime) {
            // Accumulate elapsed time before archiving
            const now = new Date();
            const lastResumeTime = subtimer.lastResumeTime ? new Date(subtimer.lastResumeTime) : new Date(subtimer.startTime);
            const elapsedThisSegment = now.getTime() - lastResumeTime.getTime();
            
            if (subtimer.totalElapsedTime === undefined) {
              subtimer.totalElapsedTime = elapsedThisSegment;
            } else {
              subtimer.totalElapsedTime += elapsedThisSegment;
            }
            
            subtimer.endTime = now.toISOString();
            this.syncLastPersistedElapsedTime(subtimer, subtimer.totalElapsedTime ?? 0);
            hasRunningSubtimer = true;
          }
        }
        if (hasRunningSubtimer) {
          this.activeTimers.delete(timerId);
        }
      }
      // Update archived status
      timer.archived = archived;
      await this.saveConfig(config);
    }
  }

  public async createFolder(name: string, parentPath?: number[]): Promise<TimerFolder> {
    const config = this.getConfigInternal();
    const folder: TimerFolder = {
      name,
      timers: [],
      subfolders: []
    };

    if (parentPath && parentPath.length > 0) {
      const parent = this.getFolderAtPath(config.folders, parentPath);
      if (parent) {
        if (!parent.subfolders) parent.subfolders = [];
        parent.subfolders.push(folder);
      }
    } else {
      config.folders.push(folder);
    }

    await this.saveConfig(config);
    return folder;
  }

  public async moveTimerByOffset(timerId: string, offset: number): Promise<void> {
    const config = this.getConfigInternal();
    const timer = this.findTimerInConfig(config, timerId);
    if (!timer) return;

    const folderPath = timer.folderPath || [];
    
    // Check if timer is in root level (empty folder name)
    const rootFolder = config.folders.find(f => f.name === '');
    if (folderPath.length === 0 && rootFolder) {
      const currentIndex = rootFolder.timers.findIndex(t => t.id === timerId);
      if (currentIndex === -1) return;
      
      const targetIndex = Math.min(Math.max(currentIndex + offset, 0), rootFolder.timers.length - 1);
      if (targetIndex === currentIndex) return;
      
      // Move timer
      const [movedTimer] = rootFolder.timers.splice(currentIndex, 1);
      rootFolder.timers.splice(targetIndex, 0, movedTimer);
      await this.saveConfig(config);
      return;
    }

    const folder = this.getFolderAtPath(config.folders, folderPath);
    if (!folder) return;

    const currentIndex = folder.timers.findIndex(t => t.id === timerId);
    if (currentIndex === -1) return;

    const targetIndex = Math.min(Math.max(currentIndex + offset, 0), folder.timers.length - 1);
    if (targetIndex === currentIndex) return;

    // Move timer within folder
    const [movedTimer] = folder.timers.splice(currentIndex, 1);
    folder.timers.splice(targetIndex, 0, movedTimer);
    await this.saveConfig(config);
  }

  public async moveTimerToFolder(timerId: string, targetFolderPath?: number[]): Promise<void> {
    const config = this.getConfigInternal();
    const timer = this.findTimerInConfig(config, timerId);
    if (!timer) return;

    // Remove from current location
    const removeFromFolders = (folders: TimerFolder[]): boolean => {
      for (const folder of folders) {
        const index = folder.timers.findIndex(t => t.id === timerId);
        if (index !== -1) {
          folder.timers.splice(index, 1);
          return true;
        }
        if (folder.subfolders && removeFromFolders(folder.subfolders)) {
          return true;
        }
      }
      return false;
    };
    removeFromFolders(config.folders);

    // Add to target location
    if (targetFolderPath && targetFolderPath.length > 0) {
      const targetFolder = this.getFolderAtPath(config.folders, targetFolderPath);
      if (targetFolder) {
        timer.folderPath = targetFolderPath;
        targetFolder.timers.push(timer);
      }
    } else {
      // Root level
      const rootTimers = this.getRootLevelTimers(config);
      timer.folderPath = undefined;
      rootTimers.push(timer);
    }

    await this.saveConfig(config);
  }

  public async handleBranchCheckout(branchName: string): Promise<void> {
    const config = this.getConfigInternal();
    if (config.enabled === false) return; // Don't create timers if disabled
    if (!config.autoCreateOnBranchCheckout) return;

    const ignoredBranches = config.ignoredBranches || [];
    if (ignoredBranches.includes(branchName)) return;

    if (this.currentBranch === branchName) return; // Already on this branch

    // Find the previous branch timer (if switching from another branch)
    let previousBranchTimer: Timer | undefined = undefined;
    if (this.currentBranch) {
      const findBranchTimer = (folders: TimerFolder[]): Timer | undefined => {
        for (const folder of folders) {
          for (const timer of folder.timers) {
            if (timer.branchName === this.currentBranch) {
              return timer;
            }
          }
          if (folder.subfolders) {
            const found = findBranchTimer(folder.subfolders);
            if (found) return found;
          }
        }
        return undefined;
      };
      previousBranchTimer = findBranchTimer(config.folders);
    }

    // Pause any other branch timers and their subtimers (but not manually started timers)
    const pauseBranchTimersAndSubtimers = (folders: TimerFolder[]): void => {
      for (const folder of folders) {
        for (const timer of folder.timers) {
          if (timer.branchName && timer.branchName !== branchName) {
            // Pause all subtimers
            if (timer.subtimers) {
              let hadRunningSubtimer = false;
              for (const subtimer of timer.subtimers) {
                if (!subtimer.endTime) {
                  // Accumulate elapsed time before pausing
                  const now = new Date();
                  const lastResumeTime = subtimer.lastResumeTime ? new Date(subtimer.lastResumeTime) : new Date(subtimer.startTime);
                  const elapsedThisSegment = now.getTime() - lastResumeTime.getTime();
                  
                  if (subtimer.totalElapsedTime === undefined) {
                    subtimer.totalElapsedTime = elapsedThisSegment;
                  } else {
                    subtimer.totalElapsedTime += elapsedThisSegment;
                  }
                  
                  subtimer.endTime = now.toISOString();
                  this.syncLastPersistedElapsedTime(subtimer, subtimer.totalElapsedTime ?? 0);
                  hadRunningSubtimer = true;
                }
              }
              if (hadRunningSubtimer) {
                this.activeTimers.delete(timer.id);
              }
            }
          }
        }
        if (folder.subfolders) {
          pauseBranchTimersAndSubtimers(folder.subfolders);
        }
      }
    };
    pauseBranchTimersAndSubtimers(config.folders);
    await this.saveConfig(config);

    // Find existing timer for this branch
    const findBranchTimer = (folders: TimerFolder[]): Timer | undefined => {
      for (const folder of folders) {
        for (const timer of folder.timers) {
          if (timer.branchName === branchName) {
            return timer;
          }
        }
        if (folder.subfolders) {
          const found = findBranchTimer(folder.subfolders);
          if (found) return found;
        }
      }
      return undefined;
    };

    const existingTimer = findBranchTimer(config.folders);

    if (existingTimer) {
      // Branch already exists - pause last subtimer and create new session
      if (existingTimer.subtimers && existingTimer.subtimers.length > 0) {
        const lastSubtimer = existingTimer.subtimers[existingTimer.subtimers.length - 1];
        if (!lastSubtimer.endTime) {
          // Accumulate elapsed time before pausing
          const now = new Date();
          const lastResumeTime = lastSubtimer.lastResumeTime ? new Date(lastSubtimer.lastResumeTime) : new Date(lastSubtimer.startTime);
          const elapsedThisSegment = now.getTime() - lastResumeTime.getTime();
          
          if (lastSubtimer.totalElapsedTime === undefined) {
            lastSubtimer.totalElapsedTime = elapsedThisSegment;
          } else {
            lastSubtimer.totalElapsedTime += elapsedThisSegment;
          }
          
          lastSubtimer.endTime = now.toISOString();
        }
      }

      // Log branch switch in both timers
      if (this.currentBranch && previousBranchTimer) {
        // Log in the previous branch timer
        this.addLog(previousBranchTimer, `Branch switched from "${this.currentBranch}" to "${branchName}"`);
        // Log in the new branch timer
        this.addLog(existingTimer, `Branch switched from "${this.currentBranch}" to "${branchName}"`);
      } else if (this.currentBranch) {
        // Previous branch timer not found, but we're switching
        this.addLog(existingTimer, `Branch switched from "${this.currentBranch}" to "${branchName}"`);
      } else {
        // First time checking out this branch
        this.addLog(existingTimer, `Branch checked out: "${branchName}"`);
      }

      // Timer will be active once we create the new session, so add it to active timers
      this.activeTimers.set(existingTimer.id, existingTimer);

      // Get next session number
      const sessionNumber = existingTimer.subtimers ? existingTimer.subtimers.length + 1 : 1;
      await this.createSubTimer(existingTimer.id, `Session ${sessionNumber}:`, undefined, true);
    } else {
      // New branch - create timer and first session
      const timer: Timer = {
        id: crypto.randomUUID(),
        label: `Branch: ${branchName}`,
        startTime: new Date().toISOString(),
        archived: false,
        folderPath: undefined,
        branchName: branchName,
        subtimers: [],
        logs: []
      };

      // Add to root level
      const rootTimers = this.getRootLevelTimers(config);
      rootTimers.push(timer);

      // Log branch creation and VS Code start
      this.addLog(timer, `Branch timer created for "${branchName}"`);
      this.addLog(timer, `VS Code opened and started`);
      
      // If switching from another branch, log in the previous branch timer too
      if (this.currentBranch && previousBranchTimer) {
        this.addLog(previousBranchTimer, `Branch switched from "${this.currentBranch}" to "${branchName}"`);
      }

      await this.saveConfig(config);
      this.activeTimers.set(timer.id, timer);

      // Create first session
      await this.createSubTimer(timer.id, 'Session 1:', undefined, true);
    }

    this.currentBranch = branchName;
  }

  public async handleCommit(commitMessage: string): Promise<void> {
    const config = this.getConfigInternal();
    if (config.enabled === false) return; // Don't handle commits if disabled
    if (!this.currentBranch) return;

    // Find the current branch timer
    const findBranchTimer = (folders: TimerFolder[]): Timer | undefined => {
      for (const folder of folders) {
        for (const timer of folder.timers) {
          if (timer.branchName === this.currentBranch) {
            return timer;
          }
        }
        if (folder.subfolders) {
          const found = findBranchTimer(folder.subfolders);
          if (found) return found;
        }
      }
      return undefined;
    };

    const branchTimer = findBranchTimer(config.folders);
    if (!branchTimer || !branchTimer.subtimers || branchTimer.subtimers.length === 0) {
      return; // No branch timer or no subtimers
    }

    // Find the active (running) subtimer
    const activeSubtimer = branchTimer.subtimers.find(st => !st.endTime);
    if (!activeSubtimer) {
      return; // No active subtimer
    }

    // Get the session number from the current subtimer label
    const sessionMatch = activeSubtimer.label.match(/Session (\d+)/);
    const sessionNumber = sessionMatch ? sessionMatch[1] : branchTimer.subtimers.length.toString();

    // Get first line of commit message (remove newlines)
    const firstLineCommitMessage = commitMessage.split('\n')[0].trim();

    // Log commit
    this.addLog(branchTimer, `Commit: "${firstLineCommitMessage}"`);
    
    // Rename the current subtimer to include commit message
    const oldLabel = activeSubtimer.label;
    activeSubtimer.label = `Session ${sessionNumber} - Commit: ${firstLineCommitMessage}`;
    
    // Accumulate elapsed time before pausing
    const now = new Date();
    const lastResumeTime = activeSubtimer.lastResumeTime ? new Date(activeSubtimer.lastResumeTime) : new Date(activeSubtimer.startTime);
    const elapsedThisSegment = now.getTime() - lastResumeTime.getTime();
    
    if (activeSubtimer.totalElapsedTime === undefined) {
      activeSubtimer.totalElapsedTime = elapsedThisSegment;
    } else {
      activeSubtimer.totalElapsedTime += elapsedThisSegment;
    }
    
    // Pause the subtimer
    activeSubtimer.endTime = now.toISOString();
    this.syncLastPersistedElapsedTime(activeSubtimer, activeSubtimer.totalElapsedTime ?? 0);

    // Create a new session (number will be based on existing subtimers count)
    const nextSessionNumber = branchTimer.subtimers.length + 1;
    await this.createSubTimer(branchTimer.id, `Session ${nextSessionNumber}:`, undefined, true);
  }

  public async initializeGitWatcher(): Promise<void> {
    // Watch for git branch changes
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return;

    // Get current branch
    try {
      const { execSync } = require('child_process');
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: workspaceFolders[0].uri.fsPath, encoding: 'utf8' }).trim();
      this.currentBranch = currentBranch;
      
      const timerConfig = this.getConfigInternal();
      if (timerConfig.enabled !== false && timerConfig.autoCreateOnBranchCheckout && !(timerConfig.ignoredBranches || []).includes(currentBranch)) {
        // Check if there's already a timer for this branch
        const findBranchTimer = (folders: TimerFolder[]): Timer | undefined => {
          for (const folder of folders) {
            for (const timer of folder.timers) {
              if (timer.branchName === currentBranch) {
                return timer;
              }
            }
            if (folder.subfolders) {
              const found = findBranchTimer(folder.subfolders);
              if (found) return found;
            }
          }
          return undefined;
        };
        const existingTimer = findBranchTimer(timerConfig.folders);
        if (!existingTimer) {
          await this.handleBranchCheckout(currentBranch);
        } else {
          // Log VS Code startup for existing branch timer
          this.addLog(existingTimer, `VS Code opened and started`);
          
          // Check if timer has running subtimers, if not, resume the last session
          const hasRunningSubtimer = existingTimer.subtimers && existingTimer.subtimers.some(st => !st.endTime);
          if (!hasRunningSubtimer && existingTimer.subtimers && existingTimer.subtimers.length > 0) {
            // Resume the last session
            const lastSubtimer = existingTimer.subtimers[existingTimer.subtimers.length - 1];
            if (lastSubtimer.endTime) {
              lastSubtimer.endTime = undefined;
              this.activeTimers.set(existingTimer.id, existingTimer);
              await this.saveConfig(timerConfig);
            }
          } else if (hasRunningSubtimer) {
            // Make sure it's in active timers
            this.activeTimers.set(existingTimer.id, existingTimer);
            await this.saveConfig(timerConfig);
          } else {
            await this.saveConfig(timerConfig);
          }
        }
      }
    } catch (error) {
      // Not a git repo or git not available
    }

    // Watch .git/HEAD file for branch changes
    const headWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolders[0], '.git/HEAD'));
    
    headWatcher.onDidChange(async () => {
      try {
        const { execSync } = require('child_process');
        const newBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: workspaceFolders[0].uri.fsPath, encoding: 'utf8' }).trim();
        if (newBranch !== this.currentBranch) {
          await this.handleBranchCheckout(newBranch);
        }
      } catch (error) {
        // Git error, ignore
      }
    });

    // Watch .git/logs/HEAD for commits
    const logsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceFolders[0], '.git/logs/HEAD'));
    let lastCommitHash: string | undefined;
    
    // Get initial commit hash
    try {
      const { execSync } = require('child_process');
      const result = execSync('git rev-parse HEAD', { cwd: workspaceFolders[0].uri.fsPath, encoding: 'utf8' }).trim();
      lastCommitHash = result;
    } catch (error) {
      // Ignore
    }

    logsWatcher.onDidChange(async () => {
      try {
        const { execSync } = require('child_process');
        const currentCommitHash = execSync('git rev-parse HEAD', { cwd: workspaceFolders[0].uri.fsPath, encoding: 'utf8' }).trim();
        
        // Only process if commit hash changed (new commit)
        if (currentCommitHash !== lastCommitHash && lastCommitHash) {
          // Get the commit message
          const commitMessage = execSync('git log -1 --pretty=%B', { cwd: workspaceFolders[0].uri.fsPath, encoding: 'utf8' }).trim();
          await this.handleCommit(commitMessage);
        }
        
        lastCommitHash = currentCommitHash;
      } catch (error) {
        // Git error, ignore
      }
    });
  }

  public async pauseAllTimersOnShutdown(): Promise<void> {
    try {
      const config = this.getConfigInternal();
      const autoPausedTimerIds: string[] = [];
      const autoPausedSubtimerIds: Array<{ timerId: string; subtimerId: string }> = [];
      const pauseTime = new Date().toISOString();

      const pauseAll = (folders: TimerFolder[]): void => {
        for (const folder of folders) {
          for (const timer of folder.timers) {
            // Pause running subtimers (timers don't have their own endTime anymore)
            if (timer.subtimers) {
              let hadRunningSubtimer = false;
              for (const subtimer of timer.subtimers) {
                if (!subtimer.endTime) {
                  // Accumulate elapsed time before pausing on shutdown
                  const pauseTimeDate = new Date(pauseTime);
                  const lastResumeTime = subtimer.lastResumeTime ? new Date(subtimer.lastResumeTime) : new Date(subtimer.startTime);
                  const elapsedThisSegment = pauseTimeDate.getTime() - lastResumeTime.getTime();
                  
                  if (subtimer.totalElapsedTime === undefined) {
                    subtimer.totalElapsedTime = elapsedThisSegment;
                  } else {
                    subtimer.totalElapsedTime += elapsedThisSegment;
                  }
                  
                  subtimer.endTime = pauseTime;
                  this.syncLastPersistedElapsedTime(subtimer, subtimer.totalElapsedTime ?? 0);
                  autoPausedSubtimerIds.push({ timerId: timer.id, subtimerId: subtimer.id });
                  hadRunningSubtimer = true;
                }
              }
              if (hadRunningSubtimer) {
                autoPausedTimerIds.push(timer.id);
                this.activeTimers.delete(timer.id);
              }
            }
          }
          if (folder.subfolders) {
            pauseAll(folder.subfolders);
          }
        }
      };

      pauseAll(config.folders);

      if (this.workspaceState) {
        try {
          await this.workspaceState.update('timeTracker.autoPausedTimers', autoPausedTimerIds);
          await this.workspaceState.update('timeTracker.autoPausedSubtimers', autoPausedSubtimerIds);
          await this.workspaceState.update('timeTracker.autoPausedTime', pauseTime);
        } catch (error) {
          if (this.isCancellationError(error)) {
            return;
          }
          throw error;
        }
      }

      try {
        await this.saveConfig(config);
      } catch (error) {
        if (this.isCancellationError(error)) {
          return;
        }
        throw error;
      }
    } catch (error) {
      if (this.isCancellationError(error)) {
        return;
      }
      throw error;
    }
  }

  public async saveTimersPeriodically(): Promise<void> {
    const config = this.getConfigInternal();
    const nowMs = Date.now();
    let changed = false;

    const updateFolders = (folders: TimerFolder[]): void => {
      for (const folder of folders) {
        for (const timer of folder.timers) {
          if (timer.subtimers) {
            for (const subtimer of timer.subtimers) {
              const elapsed = this.calculateCurrentElapsedTime(subtimer, nowMs);
              if (this.syncLastPersistedElapsedTime(subtimer, elapsed)) {
                changed = true;
              }
            }
          }
        }
        if (folder.subfolders) {
          updateFolders(folder.subfolders);
        }
      }
    };

    updateFolders(config.folders);

    if (changed) {
      await this.saveConfig(config);
    }
  }

  public async detectUnexpectedShutdown(): Promise<void> {
    const config = this.getConfigInternal();
    const nowMs = Date.now();
    let updated = false;

    const processFolders = (folders: TimerFolder[]): void => {
      for (const folder of folders) {
        for (const timer of folder.timers) {
          if (!timer.subtimers) {
            continue;
          }

          for (const subtimer of timer.subtimers) {
            const currentElapsed = this.calculateCurrentElapsedTime(subtimer, nowMs);

            if (subtimer.lastPersistedElapsedTime === undefined) {
              if (this.syncLastPersistedElapsedTime(subtimer, currentElapsed)) {
                updated = true;
              }
              continue;
            }

            const drift = Math.abs(currentElapsed - subtimer.lastPersistedElapsedTime);

            if (!subtimer.endTime && drift > TimeTrackerManager.ELAPSED_DRIFT_TOLERANCE_MS) {
              const previousElapsedMs = subtimer.lastPersistedElapsedTime ?? 0;
              const baseline = Math.min(currentElapsed, previousElapsedMs);
              const normalizedBaseline = Math.max(0, Math.floor(baseline));

              subtimer.totalElapsedTime = normalizedBaseline;
              subtimer.lastResumeTime = new Date(nowMs).toISOString();
              subtimer.lastPersistedElapsedTime = normalizedBaseline;

              const previousElapsedFormatted = this.formatElapsedForLog(previousElapsedMs);
              const newElapsedFormatted = this.formatElapsedForLog(normalizedBaseline);
              this.addLog(timer, `[${subtimer.label}] - VS Code closed unexpectedly. Restored elapsed time from ${previousElapsedFormatted} to ${newElapsedFormatted}.`);
              updated = true;
            } else if (this.syncLastPersistedElapsedTime(subtimer, currentElapsed)) {
              updated = true;
            }
          }
        }

        if (folder.subfolders) {
          processFolders(folder.subfolders);
        }
      }
    };

    processFolders(config.folders);

    if (updated) {
      await this.saveConfig(config);
    }
  }

  public async resumeAutoPausedTimers(): Promise<void> {
    if (!this.workspaceState) return;

    const autoPausedTimerIds = this.workspaceState.get<string[]>('timeTracker.autoPausedTimers', []);
    const autoPausedSubtimerIds = this.workspaceState.get<Array<{ timerId: string; subtimerId: string }>>('timeTracker.autoPausedSubtimers', []);
    const autoPausedTime = this.workspaceState.get<string>('timeTracker.autoPausedTime');
    
    if (autoPausedTimerIds.length === 0 && autoPausedSubtimerIds.length === 0) return;

    const config = this.getConfigInternal();
    const resumeTime = new Date(autoPausedTime || new Date().toISOString());
    const now = new Date();
    const timeDiff = now.getTime() - resumeTime.getTime();
    const resumeIso = now.toISOString();

    // Only resume if paused within last 5 minutes (to avoid resuming old sessions)
    if (timeDiff > 5 * 60 * 1000) {
      // Clear the auto-paused state if it's too old
      await this.workspaceState.update('timeTracker.autoPausedTimers', []);
      await this.workspaceState.update('timeTracker.autoPausedSubtimers', []);
      await this.workspaceState.update('timeTracker.autoPausedTime', undefined);
      return;
    }

    const findAndResumeTimer = (folders: TimerFolder[], timerId: string): Timer | undefined => {
      for (const folder of folders) {
        for (const timer of folder.timers) {
          if (timer.id === timerId) {
            return timer;
          }
        }
        if (folder.subfolders) {
          const found = findAndResumeTimer(folder.subfolders, timerId);
          if (found) return found;
        }
      }
      return undefined;
    };

    // Resume timers
    for (const timerId of autoPausedTimerIds) {
      findAndResumeTimer(config.folders, timerId);
    }

    // Resume subtimers
    for (const { timerId, subtimerId } of autoPausedSubtimerIds) {
      const timer = findAndResumeTimer(config.folders, timerId);
      if (timer && timer.subtimers) {
        const subtimer = timer.subtimers.find(st => st.id === subtimerId);
        if (subtimer && subtimer.endTime === autoPausedTime) {
          // Check for unexpected shutdown before resuming (compares last resume time with current time)
          const nowMs = now.getTime();
          this.detectAndHandleUnexpectedShutdown(timer, subtimer, nowMs);
          
          subtimer.endTime = undefined;
          subtimer.lastResumeTime = resumeIso;
          this.syncLastPersistedElapsedTime(subtimer, subtimer.totalElapsedTime ?? 0);
        }
      }
    }

    // Clear the auto-paused state
    await this.workspaceState.update('timeTracker.autoPausedTimers', []);
    await this.workspaceState.update('timeTracker.autoPausedSubtimers', []);
    await this.workspaceState.update('timeTracker.autoPausedTime', undefined);

    await this.saveConfig(config);
  }

  public getAllTimers(includeArchived: boolean = false): Timer[] {
    const config = this.getConfigInternal();
    const timers: Timer[] = [];
    const collectFromFolders = (folders: TimerFolder[]): void => {
      for (const folder of folders) {
        for (const timer of folder.timers) {
          if (includeArchived || !timer.archived) {
            timers.push(timer);
          }
        }
        if (folder.subfolders) {
          collectFromFolders(folder.subfolders);
        }
      }
    };
    collectFromFolders(config.folders);
    return timers;
  }

  public async createSubTimer(timerId: string, label: string, description?: string, startImmediately: boolean = true): Promise<SubTimer> {
    const config = this.getConfigInternal();
    const timer = this.findTimerInConfig(config, timerId);
    if (!timer) {
      throw new Error('Timer not found');
    }

    if (!timer.subtimers) {
      timer.subtimers = [];
    }

    // If starting immediately, pause any other running subtimers (but don't pause the parent timer)
    if (startImmediately) {
      for (const subtimer of timer.subtimers) {
        if (!subtimer.endTime) {
          // Accumulate elapsed time before pausing
          const now = new Date();
          const lastResumeTime = subtimer.lastResumeTime ? new Date(subtimer.lastResumeTime) : new Date(subtimer.startTime);
          const elapsedThisSegment = now.getTime() - lastResumeTime.getTime();
          
          if (subtimer.totalElapsedTime === undefined) {
            subtimer.totalElapsedTime = elapsedThisSegment;
          } else {
            subtimer.totalElapsedTime += elapsedThisSegment;
          }
          
          subtimer.endTime = now.toISOString();
          this.syncLastPersistedElapsedTime(subtimer, subtimer.totalElapsedTime ?? 0);
        }
      }
    }

    const now = new Date().toISOString();
    const subtimer: SubTimer = {
      id: crypto.randomUUID(),
      label: label || 'Untitled SubTimer',
      description: description,
      startTime: now,
      endTime: startImmediately ? undefined : now, // If not starting immediately, set endTime to now (stopped state)
      totalElapsedTime: 0, // Start with 0 elapsed time
      lastResumeTime: startImmediately ? now : undefined, // Track when timer was last started/resumed
      lastPersistedElapsedTime: 0
    };

    timer.subtimers.push(subtimer);
    
    // Log subtimer creation
    const action = startImmediately ? 'Started' : 'Created';
    this.addLog(timer, `[${subtimer.label}] - ${action}`);
    
    await this.saveConfig(config);
    return subtimer;
  }

  public async startSubTimer(timerId: string, subtimerId: string): Promise<void> {
    const config = this.getConfigInternal();
    const timer = this.findTimerInConfig(config, timerId);
    if (!timer || !timer.subtimers) {
      return;
    }

    // Pause any other running subtimers (but don't pause the parent timer)
    for (const subtimer of timer.subtimers) {
      if (subtimer.id !== subtimerId && !subtimer.endTime) {
        // Accumulate elapsed time before pausing
        const now = new Date();
        const lastResumeTime = subtimer.lastResumeTime ? new Date(subtimer.lastResumeTime) : new Date(subtimer.startTime);
        const elapsedThisSegment = now.getTime() - lastResumeTime.getTime();
        
        if (subtimer.totalElapsedTime === undefined) {
          subtimer.totalElapsedTime = elapsedThisSegment;
        } else {
          subtimer.totalElapsedTime += elapsedThisSegment;
        }
        
        subtimer.endTime = now.toISOString();
        this.syncLastPersistedElapsedTime(subtimer, subtimer.totalElapsedTime ?? 0);
      }
    }

    // Start the requested subtimer
    const subtimer = timer.subtimers.find(st => st.id === subtimerId);
    if (subtimer && subtimer.endTime) {
      // Resume: clear endTime to make it running again
      // Note: elapsed time was already accumulated when it was paused, so we don't need to do it here
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      
      // Initialize totalElapsedTime if not set (for backward compatibility with old subtimers)
      if (subtimer.totalElapsedTime === undefined) {
        // For backward compatibility: calculate elapsed time from start to pause
        const start = new Date(subtimer.startTime);
        const pauseTime = new Date(subtimer.endTime);
        subtimer.totalElapsedTime = pauseTime.getTime() - start.getTime();
      }
      
      // Check for unexpected shutdown before resuming (compares last resume time with current time)
      this.detectAndHandleUnexpectedShutdown(timer, subtimer, nowMs);
      
      // Set new resume time (now)
      subtimer.endTime = undefined;
      subtimer.lastResumeTime = now;
      this.syncLastPersistedElapsedTime(subtimer, subtimer.totalElapsedTime ?? 0);
      
      // Log subtimer resume
      this.addLog(timer, `[${subtimer.label}] - Resumed`);
    } else if (subtimer && !subtimer.endTime) {
      // Already running, do nothing
      return;
    }

    await this.saveConfig(config);
  }

  public async stopSubTimer(timerId: string, subtimerId: string): Promise<void> {
    const config = this.getConfigInternal();
    const timer = this.findTimerInConfig(config, timerId);
    if (!timer || !timer.subtimers) {
      return;
    }

    const subtimer = timer.subtimers.find(st => st.id === subtimerId);
    if (subtimer && !subtimer.endTime) {
      const now = new Date();
      const lastResumeTime = subtimer.lastResumeTime ? new Date(subtimer.lastResumeTime) : new Date(subtimer.startTime);
      
      // Calculate elapsed time from last resume until now
      const elapsedThisSegment = now.getTime() - lastResumeTime.getTime();
      
      // Initialize totalElapsedTime if not set (for backward compatibility)
      if (subtimer.totalElapsedTime === undefined) {
        subtimer.totalElapsedTime = elapsedThisSegment;
      } else {
        // Accumulate the elapsed time from this running segment
        subtimer.totalElapsedTime += elapsedThisSegment;
      }
      
      // Pause the subtimer
      subtimer.endTime = now.toISOString();
      this.syncLastPersistedElapsedTime(subtimer, subtimer.totalElapsedTime ?? 0);
      
      // Log subtimer pause
      this.addLog(timer, `[${subtimer.label}] - Paused`);
      await this.saveConfig(config);
    }
  }

  public async editSubTimer(timerId: string, subtimerId: string, updates: Partial<SubTimer>): Promise<void> {
    const config = this.getConfigInternal();
    const timer = this.findTimerInConfig(config, timerId);
    if (!timer || !timer.subtimers) {
      return;
    }

    const subtimer = timer.subtimers.find(st => st.id === subtimerId);
    if (subtimer) {
      const oldLabel = subtimer.label;
      Object.assign(subtimer, updates);
      
      // Log subtimer edit
      if (updates.label && updates.label !== oldLabel) {
        this.addLog(timer, `[${oldLabel}] - Renamed to [${updates.label}]`);
      } else if (updates.description !== undefined || updates.label) {
        this.addLog(timer, `[${subtimer.label}] - Edited`);
      }
      
      await this.saveConfig(config);
    }
  }

  public async deleteSubTimer(timerId: string, subtimerId: string): Promise<void> {
    const config = this.getConfigInternal();
    const timer = this.findTimerInConfig(config, timerId);
    if (!timer || !timer.subtimers) {
      return;
    }

    const index = timer.subtimers.findIndex(st => st.id === subtimerId);
    if (index !== -1) {
      const deletedSubtimer = timer.subtimers[index];
      const description = deletedSubtimer.description ? ` ${deletedSubtimer.description}` : '';
      timer.subtimers.splice(index, 1);
      
      // Log subtimer deletion
      this.addLog(timer, `[${deletedSubtimer.label}] - Deleted${description}`);
      
      // Ensure timer always has at least one subtimer - create a default one if empty
      if (timer.subtimers.length === 0) {
        // Create a default "Session 1" subtimer
        const defaultSubtimer: SubTimer = {
          id: crypto.randomUUID(),
          label: 'Session 1:',
          startTime: new Date().toISOString(),
          endTime: new Date().toISOString() // Start as stopped
        };
        timer.subtimers.push(defaultSubtimer);
      }
      await this.saveConfig(config);
    }
  }

  public async updateTimerDates(timerId: string, startTime?: string, endTime?: string): Promise<void> {
    const config = this.getConfigInternal();
    const timer = this.findTimerInConfig(config, timerId);
    if (!timer) {
      throw new Error('Timer not found');
    }

    if (startTime !== undefined) {
      timer.startTime = startTime;
    }
    // Note: Timers no longer have endTime - they reflect subtimer status
    // endTime parameter is ignored for timers

    // Update active timers map based on subtimer status
    if (!timer.archived && timer.subtimers && timer.subtimers.some(st => !st.endTime)) {
      this.activeTimers.set(timerId, timer);
    } else {
      this.activeTimers.delete(timerId);
    }

    await this.saveConfig(config);
  }

  public async updateSubTimerDates(timerId: string, subtimerId: string, startTime?: string, endTime?: string): Promise<void> {
    const config = this.getConfigInternal();
    const timer = this.findTimerInConfig(config, timerId);
    if (!timer || !timer.subtimers) {
      throw new Error('Timer or subtimer not found');
    }

    const subtimer = timer.subtimers.find(st => st.id === subtimerId);
    if (!subtimer) {
      throw new Error('SubTimer not found');
    }

    if (startTime !== undefined) {
      subtimer.startTime = startTime;
    }
    if (endTime !== undefined) {
      subtimer.endTime = endTime;
    }
    this.syncLastPersistedElapsedTime(subtimer, this.calculateCurrentElapsedTime(subtimer, Date.now()));

    await this.saveConfig(config);
  }

  public async reorderSubTimers(timerId: string, subtimerIds: string[]): Promise<void> {
    const config = this.getConfigInternal();
    const timer = this.findTimerInConfig(config, timerId);
    if (!timer || !timer.subtimers) {
      throw new Error('Timer not found or has no subtimers');
    }

    // Validate that all subtimer IDs exist and match
    if (subtimerIds.length !== timer.subtimers.length) {
      throw new Error('SubTimer count mismatch');
    }

    const subtimerMap = new Map(timer.subtimers.map(st => [st.id, st]));
    const reordered: SubTimer[] = [];

    for (const id of subtimerIds) {
      const subtimer = subtimerMap.get(id);
      if (!subtimer) {
        throw new Error(`SubTimer ${id} not found`);
      }
      reordered.push(subtimer);
    }

    timer.subtimers = reordered;
    await this.saveConfig(config);
  }

  private isCancellationError(error: unknown): boolean {
    if (!error) {
      return false;
    }
    if (error instanceof vscode.CancellationError) {
      return true;
    }
    if (typeof error === 'object') {
      const candidate = error as { name?: string; message?: string };
      if (candidate.name === 'Canceled' || candidate.message === 'Canceled') {
        return true;
      }
    }
    return false;
  }
}
