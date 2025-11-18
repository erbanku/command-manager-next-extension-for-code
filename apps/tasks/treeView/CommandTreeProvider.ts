import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CommandConfig, Folder, Command, ExecutionState } from '../../../src/types';
import { ConfigManager } from '../../../src/config/ConfigManager';
import { CommandTreeItem } from './CommandTreeItem';
import {
  CommandDestination,
  CommandDescriptor,
  FolderDestination,
  FolderDescriptor,
  DropPosition,
  getFolderAtPath,
  getFolderCollection,
  isAncestorPath,
  moveCommandInConfig,
  moveFolderInConfig,
  pathsEqual
} from './moveOperations';
import { convertTasksJsonContent } from '../import/tasksJsonImporter';

const TREE_MIME_TYPE = 'application/vnd.code.tree.commandmanagertree';

type DraggedTreeItem =
  | { kind: 'folder'; path: number[] }
  | { kind: 'command'; path: number[]; commandId: string };

export class CommandTreeProvider implements vscode.TreeDataProvider<CommandTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<CommandTreeItem | undefined | null | void> = new vscode.EventEmitter<CommandTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<CommandTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private configManager: ConfigManager;
  private commandTreeItems: Map<string, CommandTreeItem> = new Map();
  private importedTasks: Command[] = [];
  private tasksWatcher?: vscode.FileSystemWatcher;
  private workspaceRoot?: string;
  public readonly dragAndDropController: vscode.TreeDragAndDropController<CommandTreeItem>;

  constructor() {
    this.configManager = ConfigManager.getInstance();
    this.configManager.setOnConfigChange(() => this.refresh());
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!this.workspaceRoot) {
      const overrideRoot = process.env.COMMAND_MANAGER_CONFIG_ROOT;
      if (overrideRoot) {
        this.workspaceRoot = path.resolve(path.join(overrideRoot, '..'));
      }
    }
    void this.initializeWorkspaceTasks();
    this.dragAndDropController = {
      dragMimeTypes: [TREE_MIME_TYPE],
      dropMimeTypes: [TREE_MIME_TYPE],
      handleDrag: (source, dataTransfer) => this.handleDrag(source, dataTransfer),
      handleDrop: (target, dataTransfer) => this.handleDrop(target, dataTransfer)
    };
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public getTreeItem(element: CommandTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: CommandTreeItem): Thenable<CommandTreeItem[]> {
    if (!element) {
      // Root level - show all folders
      return this.getRootFolders();
    } else if (element.isFolder()) {
      // Folder level - show commands and subfolders
      return this.getFolderChildren(element);
    } else {
      // Command level - no children
      return Promise.resolve([]);
    }
  }

  private async getRootFolders(): Promise<CommandTreeItem[]> {
    const config = this.configManager.getConfig();
    const items: CommandTreeItem[] = [];

    config.folders.forEach((folder, index) => {
      const folderItem = new CommandTreeItem(folder, 'folder', undefined, [index]);
      items.push(folderItem);
    });

    if (this.importedTasks.length > 0) {
      const virtualFolder: Folder = {
        name: 'tasks.json',
        icon: '$(tasklist)',
        description: 'Imported VS Code tasks',
        commands: this.importedTasks,
        readOnly: true,
        source: 'vscode-task'
      };
      const folderItem = new CommandTreeItem(virtualFolder, 'folder', undefined, [-1]);
      items.push(folderItem);
    }

    return items;
  }

  private async getFolderChildren(folderElement: CommandTreeItem): Promise<CommandTreeItem[]> {
    const folder = folderElement.getFolder();
    if (!folder) {
      return [];
    }

    const items: CommandTreeItem[] = [];

    // Add subfolders first
    if (folder.subfolders) {
      folder.subfolders.forEach((subfolder, index) => {
        const subfolderItem = new CommandTreeItem(subfolder, 'folder', folderElement, [...folderElement.getFolderPath(), index]);
        items.push(subfolderItem);
      });
    }

    // Add commands
    folder.commands.forEach((command, index) => {
      const commandItem = new CommandTreeItem(command, 'command', folderElement, folderElement.getFolderPath(), index);
      // Track command items for state updates
      this.commandTreeItems.set(command.id, commandItem);
      items.push(commandItem);
    });

    return items;
  }

  public getParent(element: CommandTreeItem): vscode.ProviderResult<CommandTreeItem> {
    return element.parent;
  }

  public async findCommandById(commandId: string): Promise<Command | undefined> {
    const config = this.configManager.getConfig();
    return this.findCommandInFolders(commandId, config.folders);
  }

  private findCommandInFolders(commandId: string, folders: Folder[]): Command | undefined {
    for (const folder of folders) {
      // Check commands in this folder
      for (const command of folder.commands) {
        if (command.id === commandId) {
          return command;
        }
      }

      // Check subfolders
      if (folder.subfolders) {
        const found = this.findCommandInFolders(commandId, folder.subfolders);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  }

  public async findFolderByName(folderName: string): Promise<Folder | undefined> {
    const config = this.configManager.getConfig();
    return this.findFolderInFolders(folderName, config.folders);
  }

  private findFolderInFolders(folderName: string, folders: Folder[]): Folder | undefined {
    for (const folder of folders) {
      if (folder.name === folderName) {
        return folder;
      }

      if (folder.subfolders) {
        const found = this.findFolderInFolders(folderName, folder.subfolders);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  }

  public async getAllCommands(): Promise<Command[]> {
    const config = this.configManager.getConfig();
    return [...this.getAllCommandsFromFolders(config.folders), ...this.importedTasks];
  }

  private getAllCommandsFromFolders(folders: Folder[]): Command[] {
    const commands: Command[] = [];
    
    for (const folder of folders) {
      commands.push(...folder.commands);
      
      if (folder.subfolders) {
        commands.push(...this.getAllCommandsFromFolders(folder.subfolders));
      }
    }
    
    return commands;
  }

  public async getAllFolders(): Promise<Folder[]> {
    const config = this.configManager.getConfig();
    return this.getAllFoldersRecursive(config.folders);
  }

  private getAllFoldersRecursive(folders: Folder[]): Folder[] {
    const allFolders: Folder[] = [];

    for (const folder of folders) {
      allFolders.push(folder);

      if (folder.subfolders) {
        allFolders.push(...this.getAllFoldersRecursive(folder.subfolders));
      }
    }

    return allFolders;
  }

  public setCommandExecutionState(commandId: string, state: ExecutionState): void {
    const treeItem = this.commandTreeItems.get(commandId);
    if (treeItem) {
      treeItem.executionState = state;
      this._onDidChangeTreeData.fire(treeItem);
    }
  }

  public setCommandRunning(commandId: string): void {
    this.setCommandExecutionState(commandId, ExecutionState.Running);
  }

  public setCommandSuccess(commandId: string): void {
    this.setCommandExecutionState(commandId, ExecutionState.Success);
    // Auto-reset to idle after 3 seconds
    setTimeout(() => {
      this.setCommandExecutionState(commandId, ExecutionState.Idle);
    }, 3000);
  }

  public setCommandError(commandId: string): void {
    this.setCommandExecutionState(commandId, ExecutionState.Error);
    // Auto-reset to idle after 5 seconds
    setTimeout(() => {
      this.setCommandExecutionState(commandId, ExecutionState.Idle);
    }, 5000);
  }

  private handleDrag(source: readonly CommandTreeItem[], dataTransfer: vscode.DataTransfer): void {
    const dragItems: DraggedTreeItem[] = [];

    source.forEach(item => {
      if (item.isCommand()) {
        const command = item.getCommand();
        if (command && !command.readOnly) {
          dragItems.push({
            kind: 'command',
            path: item.getFolderPath(),
            commandId: command.id
          });
        }
      } else if (item.isFolder()) {
        const folder = item.getFolder();
        if (folder && !folder.readOnly) {
          dragItems.push({
            kind: 'folder',
            path: item.getFolderPath()
          });
        }
      }
    });

    if (dragItems.length > 0) {
      dataTransfer.set(TREE_MIME_TYPE, new vscode.DataTransferItem(JSON.stringify(dragItems)));
    }
  }

  private async handleDrop(
    target: CommandTreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token?: vscode.CancellationToken
  ): Promise<void> {
    const transferItem = dataTransfer.get(TREE_MIME_TYPE);
    if (!transferItem) {
      return;
    }

    let dragItems: DraggedTreeItem[] | undefined;

    if (Array.isArray(transferItem.value)) {
      dragItems = transferItem.value as DraggedTreeItem[];
    } else {
      try {
        const raw = await transferItem.asString();
        dragItems = JSON.parse(raw) as DraggedTreeItem[];
      } catch (error) {
        return;
      }
    }

    if (!dragItems || dragItems.length === 0) {
      return;
    }

    const config = this.configManager.getConfig();
    let changed = false;

    const dropPosition = this.extractDropPosition(dataTransfer);

    for (const item of dragItems) {
      if (item.kind === 'command') {
        if (this.moveCommand(config, item, target, dropPosition)) {
          changed = true;
        }
      } else if (item.kind === 'folder') {
        if (this.moveFolder(config, item, target, dropPosition)) {
          changed = true;
        }
      }
    }

    if (changed) {
      try {
        await this.configManager.saveConfig(config);
        this.refresh();
      } catch (error) {
        void vscode.window.showErrorMessage(`Failed to move item: ${error}`);
      }
    }
  }

  private moveCommand(
    config: CommandConfig,
    item: Extract<DraggedTreeItem, { kind: 'command' }>,
    target: CommandTreeItem | undefined,
    dropPosition: DropPosition
  ): boolean {
    const descriptor: CommandDescriptor = {
      path: item.path,
      commandId: item.commandId
    };

    const destination = this.resolveCommandDestination(target, item.path, dropPosition);
    if (!destination) {
      return false;
    }

    return moveCommandInConfig(config, descriptor, destination);
  }

  private moveFolder(
    config: CommandConfig,
    item: Extract<DraggedTreeItem, { kind: 'folder' }>,
    target: CommandTreeItem | undefined,
    dropPosition: DropPosition
  ): boolean {
    const descriptor: FolderDescriptor = { path: item.path };

    const destination = this.resolveFolderDestination(target, item.path, dropPosition);
    if (!destination) {
      return false;
    }

    if (target?.isFolder() && pathsEqual(target.getFolderPath(), item.path) && dropPosition !== 'into') {
      return false;
    }

    return moveFolderInConfig(config, descriptor, destination);
  }

  private resolveCommandDestination(
    target: CommandTreeItem | undefined,
    fallbackPath: number[],
    dropPosition: DropPosition
  ): CommandDestination | undefined {
    if (!target) {
      return { folderPath: [...fallbackPath], position: dropPosition };
    }

    if (target.isFolder()) {
      return {
        folderPath: target.getFolderPath(),
        position: dropPosition === 'after' ? 'after' : 'into'
      };
    }

    if (target.isCommand()) {
      return {
        folderPath: target.getFolderPath(),
        index: target.getCommandIndex(),
        position: dropPosition === 'after' ? 'after' : 'before'
      };
    }

    return undefined;
  }

  private resolveFolderDestination(
    target: CommandTreeItem | undefined,
    sourcePath: number[],
    dropPosition: DropPosition
  ): FolderDestination | undefined {
    if (!target) {
      return { parentPath: [], position: dropPosition };
    }

    if (target.isCommand()) {
      return { parentPath: target.getFolderPath(), position: dropPosition === 'after' ? 'after' : 'into' };
    }

    if (target.isFolder()) {
      const targetPath = target.getFolderPath();
      const targetParentPath = targetPath.slice(0, -1);
      const sameParent = pathsEqual(targetParentPath, sourcePath.slice(0, -1));

      if (sameParent) {
        return {
          parentPath: targetParentPath,
          index: targetPath[targetPath.length - 1],
          position: dropPosition === 'after' ? 'after' : 'before'
        };
      }

      return {
        parentPath: targetPath,
        position: dropPosition === 'after' ? 'after' : 'into'
      };
    }

    return undefined;
  }

  private extractDropPosition(dataTransfer: vscode.DataTransfer): DropPosition {
    const metadataItem = dataTransfer.get('application/vnd.code.tree.dropmetadata');
    if (!metadataItem) {
      return 'before';
    }

    try {
      const rawValue = metadataItem.value;
      if (typeof rawValue === 'string') {
        const parsed = JSON.parse(rawValue) as { dropPosition?: DropPosition };
        if (parsed?.dropPosition) {
          return parsed.dropPosition;
        }
      } else if (rawValue && typeof rawValue === 'object' && 'dropPosition' in rawValue) {
        const position = (rawValue as { dropPosition?: DropPosition }).dropPosition;
        if (position) {
          return position;
        }
      }
    } catch (error) {
      // Silent fail
    }

    return 'before';
  }

  public async moveItemByOffset(item: CommandTreeItem, offset: number): Promise<void> {
    const { DebugLogger, DebugTag } = await import('../../../src/utils/DebugLogger');
    DebugLogger.log(DebugTag.MOVE, `Starting move operation`, {
      itemType: item.isCommand() ? 'command' : 'folder',
      itemLabel: item.label,
      offset,
      folderPath: item.getFolderPath()
    });

    if (item.isCommand()) {
      const command = item.getCommand();
      if (command?.readOnly) {
        DebugLogger.log(DebugTag.MOVE, 'Move skipped: command is read-only');
        return;
      }
    } else if (item.isFolder()) {
      const folder = item.getFolder();
      if (folder?.readOnly) {
        DebugLogger.log(DebugTag.MOVE, 'Move skipped: folder is read-only');
        return;
      }
    }

    const config = this.configManager.getConfig();
    let changed = false;

    if (item.isCommand()) {
      const folderPath = item.getFolderPath();
      const folder = getFolderAtPath(config, folderPath);
      const command = item.getCommand();
      if (!folder || !command) {
        DebugLogger.log(DebugTag.MOVE, 'Command move failed: folder or command not found');
        return;
      }

      const currentIndex = folder.commands.findIndex(existing => existing.id === command.id);
      if (currentIndex === -1) {
        DebugLogger.log(DebugTag.MOVE, 'Command move failed: command not found in folder');
        return;
      }

      const targetIndex = Math.min(Math.max(currentIndex + offset, 0), folder.commands.length - 1);
      if (targetIndex === currentIndex) {
        DebugLogger.log(DebugTag.MOVE, 'Command move skipped: target index equals current index');
        return;
      }

      DebugLogger.log(DebugTag.MOVE, `Moving command`, {
        commandId: command.id,
        fromIndex: currentIndex,
        toIndex: targetIndex,
        currentOrder: folder.commands.map(c => c.id)
      });

      changed = moveCommandInConfig(
        config,
        { path: folderPath, commandId: command.id },
        { folderPath, index: targetIndex, position: 'before' }
      );

      DebugLogger.log(DebugTag.MOVE, `Command move result`, {
        changed,
        newOrder: folder.commands.map(c => c.id)
      });
    } else if (item.isFolder()) {
      const parentPath = item.getFolderPath().slice(0, -1);
      const collection = getFolderCollection(config, parentPath);
      const currentIndex = item.getFolderPath()[item.getFolderPath().length - 1];
      if (!collection || currentIndex === undefined) {
        DebugLogger.log(DebugTag.MOVE, 'Folder move failed: collection or currentIndex not found');
        return;
      }

      const targetIndex = Math.min(Math.max(currentIndex + offset, 0), collection.length - 1);
      if (targetIndex === currentIndex) {
        DebugLogger.log(DebugTag.MOVE, 'Folder move skipped: target index equals current index');
        return;
      }

      DebugLogger.log(DebugTag.MOVE, `Moving folder`, {
        folderName: item.label,
        fromIndex: currentIndex,
        toIndex: targetIndex,
        currentOrder: collection.map(f => f.name)
      });

      changed = moveFolderInConfig(
        config,
        { path: item.getFolderPath() },
        { parentPath, index: targetIndex, position: 'before' }
      );

      DebugLogger.log(DebugTag.MOVE, `Folder move result`, {
        changed,
        newOrder: collection.map(f => f.name)
      });
    }

    if (changed) {
      await this.saveAndRefresh(config);
    }
  }

  public async moveItemToFolder(item: CommandTreeItem, destinationPath: number[]): Promise<void> {
    const config = this.configManager.getConfig();
    let changed = false;

    if (item.isCommand()) {
      const command = item.getCommand();
      if (!command || command.readOnly) {
        return;
      }

      if (destinationPath.length === 0) {
        void vscode.window.showWarningMessage('Tasks must be placed inside a folder.');
        return;
      }

      changed = moveCommandInConfig(config, { path: item.getFolderPath(), commandId: command.id }, { folderPath: destinationPath });
    } else if (item.isFolder()) {
      const folder = item.getFolder();
      if (!folder || folder.readOnly) {
        return;
      }
      if (isAncestorPath(item.getFolderPath(), destinationPath)) {
        void vscode.window.showWarningMessage('Cannot move a folder into its own subfolder.');
        return;
      }

      changed = moveFolderInConfig(
        config,
        { path: item.getFolderPath() },
        { parentPath: destinationPath, position: 'into' }
      );
    }

    if (changed) {
      await this.saveAndRefresh(config);
    }
  }

  public async saveAndRefresh(config: CommandConfig): Promise<void> {
    await this.configManager.saveConfig(config);
    this.refresh();
  }

  public async getFolderQuickPickItems(
    includeRoot: boolean,
    excludePath?: number[]
  ): Promise<Array<{ label: string; path: number[] }>> {
    const config = this.configManager.getConfig();
    const items: Array<{ label: string; path: number[] }> = [];

    if (includeRoot) {
      items.push({ label: 'Root', path: [] });
    }

    const traverse = (folders: Folder[], depth: number, path: number[] = []) => {
      folders.forEach((folder, index) => {
        const currentPath = [...path, index];
        if (excludePath && (pathsEqual(excludePath, currentPath) || isAncestorPath(excludePath, currentPath))) {
          return;
        }
        const indent = depth > 0 ? `${'  '.repeat(depth - 1)}• ` : '';
        items.push({
          label: `${indent}${folder.name}`,
          path: currentPath
        });

        if (folder.subfolders?.length) {
          traverse(folder.subfolders, depth + 1, currentPath);
        }
      });
    };

    traverse(config.folders || [], 0, []);
    return items;
  }

  public dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.commandTreeItems.clear();
    this.configManager = null as any;
    this.tasksWatcher?.dispose();
  }

  private async initializeWorkspaceTasks(): Promise<void> {
    await this.reloadWorkspaceTasks();
    this.setupWorkspaceTasksWatcher();
  }

  private async reloadWorkspaceTasks(): Promise<void> {
    const tasksUri = this.getTasksFileUri();
    if (!tasksUri) {
      this.importedTasks = [];
      this.refresh();
      return;
    }

    try {
      const content = await fs.promises.readFile(tasksUri.fsPath, 'utf8');
      this.importedTasks = convertTasksJsonContent(content, this.workspaceRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.importedTasks = [];
      }
      // For parse errors we simply skip importing without surfacing to the user.
    }
    this.refresh();
  }

  private setupWorkspaceTasksWatcher(): void {
    if (!this.workspaceRoot) {
      return;
    }

    const pattern = new vscode.RelativePattern(this.workspaceRoot, '.vscode/tasks.json');
    this.tasksWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    const reload = () => void this.reloadWorkspaceTasks();

    this.tasksWatcher.onDidChange(reload);
    this.tasksWatcher.onDidCreate(reload);
    this.tasksWatcher.onDidDelete(() => {
      this.importedTasks = [];
      this.refresh();
    });
  }

  private getTasksFileUri(): vscode.Uri | undefined {
    if (!this.workspaceRoot) {
      return undefined;
    }
    const tasksPath = path.join(this.workspaceRoot, '.vscode', 'tasks.json');
    if (!fs.existsSync(tasksPath)) {
      return undefined;
    }
    return vscode.Uri.file(tasksPath);
  }
}
