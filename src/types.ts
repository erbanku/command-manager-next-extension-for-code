export interface SubTimer {
  id: string;
  label: string;
  description?: string;
  startTime: string; // ISO timestamp (when subtimer was first created)
  endTime?: string; // ISO timestamp (undefined if running)
  totalElapsedTime?: number; // Total milliseconds elapsed (accumulated across all run segments, excluding pause time)
  lastResumeTime?: string; // ISO timestamp of when subtimer was last resumed/started (for calculating current running segment)
  lastPersistedElapsedTime?: number; // Last elapsed time snapshot persisted during periodic saves
}

export interface Timer {
  id: string;
  label: string;
  startTime: string; // ISO timestamp (when timer was created)
  branchName?: string; // Git branch name if auto-created
  archived: boolean;
  folderPath?: number[]; // Path to folder in hierarchy, undefined for root level
  subtimers: SubTimer[]; // Subtimers for this timer (always at least 1)
  logs?: string[]; // Log entries for timer events
  // Note: Timer state is determined by its subtimers - timer itself doesn't have endTime
}

export interface TimerFolder {
  name: string;
  icon?: string;
  timers: Timer[];
  subfolders?: TimerFolder[];
}

export interface TimeTrackerConfig {
  folders: TimerFolder[];
  ignoredBranches?: string[]; // Branches to ignore for auto-timer creation (default: ['master', 'main'])
  autoCreateOnBranchCheckout?: boolean; // Default: true
  enabled?: boolean; // Default: true - whether time tracking is enabled
}

export interface CommandConfig {
  folders: Folder[];
  globalVariables?: VariablePreset[];
  sharedVariables?: SharedVariable[];
  sharedLists?: SharedList[];
  testRunners?: TestRunnerConfig[];
  pinnedCommands?: string[];
  version?: number;
  lastModified?: string;
}

export interface Folder {
  name: string;
  icon?: string;
  description?: string;
  commands: Command[];
  subfolders?: Folder[];
  readOnly?: boolean;
  source?: 'config' | 'vscode-task';
}

export interface Command {
  id: string;
  label: string;
  command: string;
  terminal: TerminalConfig;
  variables?: CommandVariable[];
  description?: string;
  icon?: string;
  readOnly?: boolean;
  source?: 'config' | 'vscode-task';
}

export interface TerminalConfig {
  type: 'vscode-current' | 'vscode-new' | 'external-cmd' | 'external-powershell';
  name?: string;
  cwd?: string;
}

export interface CommandVariable {
  key: string;
  value: string;
  label?: string;
  type: 'fixed' | 'options' | 'file';
  description?: string;
}

export interface TestRunnerConfig {
  id: string;
  activated: boolean;
  title: string;
  fileType: 'javascript' | 'typescript' | 'python';
  workingDirectory?: string;
  fileNamePattern: string;
  testNamePattern: string;
  ignoreList?: string;
  runTestCommand: string;
  terminalName?: string;
  allowNonTest?: boolean; // Default: true
  autoFind?: boolean; // Default: true
  inlineButton?: boolean; // Default: true
}


export interface VariablePreset {
  key: string;
  value: string;
}

export interface ResolvedVariable {
  key: string;
  value: string;
}

export interface ExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  exitCode?: number;
}


export interface SharedVariable {
  key: string;
  label: string;
  value: string;
  description?: string;
}

export interface SharedList {
  key: string;
  label: string;
  options: string[];
  description?: string;
}

export enum ExecutionState {
  Idle = 'idle',
  Running = 'running',
  Success = 'success',
  Error = 'error'
}
