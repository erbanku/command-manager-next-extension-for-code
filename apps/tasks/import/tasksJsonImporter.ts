import { parse } from 'jsonc-parser';
import * as path from 'path';
import { Command } from '../../../src/types';

interface TaskJson {
  label?: string;
  command?: string;
  args?: Array<string | { value?: string } | undefined> | string;
  type?: string;
  script?: string;
  detail?: string;
  options?: {
    cwd?: string;
  };
  presentation?: {
    reveal?: string;
  };
  problemMatcher?: unknown;
  dependsOn?: unknown;
  path?: string;
  notation?: string;
  identifier?: string;
}

interface TasksFile {
  version?: string;
  tasks?: TaskJson[];
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null) {
    return [];
  }
  return [value];
}

function normaliseArg(value: string | { value?: string } | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && typeof value.value === 'string') {
    return value.value;
  }
  return undefined;
}

function quoteArg(arg: string): string {
  if (!arg) {
    return arg;
  }
  const needsQuote = /\s|"/.test(arg);
  if (!needsQuote) {
    return arg;
  }
  const escaped = arg.replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function buildCommandLine(task: TaskJson): string | undefined {
  if (typeof task.command === 'string' && task.command.trim().length > 0) {
    const args = toArray(task.args)
      .map(normaliseArg)
      .filter((arg): arg is string => typeof arg === 'string' && arg.length > 0)
      .map(quoteArg);

    if (args.length > 0) {
      return `${task.command} ${args.join(' ')}`.trim();
    }
    return task.command.trim();
  }

  if (task.type === 'npm' && typeof task.script === 'string' && task.script.trim().length > 0) {
    const prefix = task.path ? `npm --prefix ${task.path}` : 'npm';
    const args = toArray(task.args)
      .map(normaliseArg)
      .filter((arg): arg is string => typeof arg === 'string' && arg.length > 0)
      .map(quoteArg);

    const base = `${prefix} run ${task.script.trim()}`;
    if (args.length === 0) {
      return base;
    }
    return `${base} ${args.join(' ')}`;
  }

  return undefined;
}

function slugify(input: string, fallback: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || fallback;
}

export function convertTasksJsonContent(content: string, workspaceRoot?: string): Command[] {
  if (!content || !content.trim()) {
    return [];
  }

  let parsed: TasksFile | TaskJson;
  try {
    parsed = parse(content);
  } catch {
    return [];
  }

  const tasksArray: TaskJson[] = Array.isArray((parsed as TasksFile).tasks)
    ? ((parsed as TasksFile).tasks as TaskJson[])
    : toArray(parsed as TaskJson);

  const commands: Command[] = [];
  const usedIds = new Set<string>();

  tasksArray.forEach((task, index) => {
    if (!task || typeof task !== 'object') {
      return;
    }

    const label = task.label?.trim() || buildCommandLine(task) || `task-${index + 1}`;
    const commandLine = buildCommandLine(task);
    if (!commandLine) {
      return;
    }

    let idBase = slugify(label, `task-${index + 1}`);
    if (task.type) {
      idBase = `${slugify(task.type, 'task')}-${idBase}`;
    }

    let uniqueId = `vscode-task-${idBase}`;
    let dedupeCounter = 1;
    while (usedIds.has(uniqueId)) {
      uniqueId = `vscode-task-${idBase}-${dedupeCounter += 1}`;
    }
    usedIds.add(uniqueId);

    const terminalName = `VS Code Task: ${label}`;
    const cwd = task.options?.cwd;
    const resolvedCwd =
      cwd && cwd.trim().length > 0
        ? path.isAbsolute(cwd) || !workspaceRoot
          ? cwd
          : path.join(workspaceRoot, cwd)
        : undefined;

    const command: Command = {
      id: uniqueId,
      label,
      command: commandLine,
      description: `Imported from tasks.json${task.type ? ` (${task.type})` : ''}`,
      terminal: {
        type: 'vscode-new',
        name: terminalName,
        ...(resolvedCwd ? { cwd: resolvedCwd } : {})
      },
      readOnly: true,
      source: 'vscode-task'
    };

    commands.push(command);
  });

  return commands;
}
