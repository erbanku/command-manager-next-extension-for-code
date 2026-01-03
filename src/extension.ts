import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager } from './config/ConfigManager';
import { CommandTreeProvider } from '../apps/tasks/treeView/CommandTreeProvider';
import { CommandExecutor } from '../apps/tasks/execution/CommandExecutor';
import { WebviewManager } from './ui/webview/WebviewManager';
import { CommandTreeItem } from '../apps/tasks/treeView/CommandTreeItem';
import { DocumentationTreeProvider } from '../apps/documentation/DocumentationTreeProvider';
import { StatusBarManager } from './ui/StatusBarManager';
import { TestRunnerConfig, Timer, SubTimer, Folder, Command } from './types';
import { TestRunnerTreeProvider } from '../apps/testRunner/TestRunnerTreeProvider';
import { TestRunnerTreeItem } from '../apps/testRunner/TestRunnerTreeItem';
import { TestRunnerCodeLensProvider } from '../apps/testRunner/TestRunnerCodeLensProvider';
import { DiscoveredTest, TestRunnerManager } from '../apps/testRunner/TestRunnerManager';
import { TimeTrackerManager } from '../apps/timeTracker/TimeTrackerManager';
import { TimeTrackerTreeProvider } from '../apps/timeTracker/TimeTrackerTreeProvider';
import { TimeTrackerTreeItem } from '../apps/timeTracker/TimeTrackerTreeItem';
import { TimeTrackerStatusBar } from '../apps/timeTracker/TimeTrackerStatusBar';
type DocumentationPosition = 'top' | 'bottom';

async function applyDocumentationViewPosition(position: DocumentationPosition): Promise<void> {
    try {
        if (position === 'top') {
            await vscode.commands.executeCommand('vscode.moveViews', {
                viewIds: ['documentationHubTree'],
                destinationId: 'command-manager',
                position: { before: 'commandManagerTree' }
            });
        } else {
            await vscode.commands.executeCommand('vscode.moveViews', {
                viewIds: ['documentationHubTree'],
                destinationId: 'command-manager',
                position: { after: 'commandManagerTree' }
            });
        }
    } catch (error) {
        // Silent fail
    }
}

export async function activate(context: vscode.ExtensionContext) {

    // Initialize managers
    const configManager = ConfigManager.getInstance();
    const commandExecutor = CommandExecutor.getInstance();
    const webviewManager = WebviewManager.getInstance();

    // Initialize configuration
    await configManager.initialize();

    // Check if this is the first time the extension is activated
    const hasShownWelcome = context.globalState.get<boolean>('hasShownWelcome', false);
    if (!hasShownWelcome) {
        const action = await vscode.window.showInformationMessage(
            'Welcome to Commands Manager Next! Configure global settings to get started.',
            'Open Settings',
            'Dismiss'
        );

        if (action === 'Open Settings') {
            await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:erbanku.commands-manager-next');
        }

        // Mark that we've shown the welcome message
        await context.globalState.update('hasShownWelcome', true);
    }

    // Create tree provider
    const treeProvider = new CommandTreeProvider();
    const commandTreeView = vscode.window.createTreeView('commandManagerTree', {
        treeDataProvider: treeProvider,
        dragAndDropController: treeProvider.dragAndDropController
    });

    const documentationProvider = new DocumentationTreeProvider(configManager, context.workspaceState);
    const documentationTreeView = vscode.window.createTreeView('documentationHubTree', {
        treeDataProvider: documentationProvider,
        showCollapseAll: true
    });

    const testRunnerManager = TestRunnerManager.getInstance();
    const testRunnerProvider = new TestRunnerTreeProvider(testRunnerManager);
    const testRunnerTreeView = vscode.window.createTreeView('testRunnerTree', {
        treeDataProvider: testRunnerProvider,
        showCollapseAll: true
    });

    const timeTrackerManager = TimeTrackerManager.getInstance();
    timeTrackerManager.setWorkspaceState(context.workspaceState);
    const timeTrackerProvider = new TimeTrackerTreeProvider();
    const timeTrackerTreeView = vscode.window.createTreeView('timeTrackerTree', {
        treeDataProvider: timeTrackerProvider,
        showCollapseAll: true
    });

    // Handle double-click on timer to open edit page
    let lastClickItem: { id: string; time: number } | null = null;
    timeTrackerTreeView.onDidChangeSelection(async (e) => {
        if (e.selection.length > 0) {
            const item = e.selection[0];
            if (item.isTimer()) {
                const timer = item.getTimer();
                if (timer && item.id) {
                    const now = Date.now();
                    // Check if this is a double-click (same item clicked within 300ms)
                    if (lastClickItem && lastClickItem.id === item.id && (now - lastClickItem.time) < 300) {
                        webviewManager.showTimerEditor(timer.id);
                        lastClickItem = null; // Reset to prevent triple-click
                    } else {
                        lastClickItem = { id: item.id, time: now };
                    }
                }
            }
        }
    });

    // Detect unexpected shutdown gaps before resuming timers
    await timeTrackerManager.detectUnexpectedShutdown();

    // Resume auto-paused timers from previous session
    await timeTrackerManager.resumeAutoPausedTimers();

    // Persist initial elapsed-time snapshot immediately on startup
    await timeTrackerManager.saveTimersPeriodically();

    // Initialize git watcher for time tracker
    await timeTrackerManager.initializeGitWatcher();

    // Periodic save to ensure timers are saved even if deactivate isn't called
    const periodicSave = setInterval(async () => {
        try {
            await timeTrackerManager.saveTimersPeriodically();
        } catch (error) {
            // Silently fail - periodic save shouldn't interrupt user
        }
    }, 30000); // Save every 30 seconds
    context.subscriptions.push({ dispose: () => clearInterval(periodicSave) });

    // Try to catch process exit events (if available in extension host)
    // This is a fallback in case deactivate() isn't called
    if (typeof process !== 'undefined' && process.on) {
        const processExitHandler = async () => {
            try {
                await timeTrackerManager.pauseAllTimersOnShutdown();
            } catch (error) {
                // Silently fail - process is exiting
            }
        };

        process.on('beforeExit', processExitHandler);
        process.on('SIGINT', processExitHandler);
        process.on('SIGTERM', processExitHandler);

        context.subscriptions.push({
            dispose: () => {
                if (typeof process !== 'undefined' && process.removeListener) {
                    process.removeListener('beforeExit', processExitHandler);
                    process.removeListener('SIGINT', processExitHandler);
                    process.removeListener('SIGTERM', processExitHandler);
                }
            }
        });
    }

    // Initialize time tracker status bar
    const timeTrackerStatusBar = new TimeTrackerStatusBar(context);
    context.subscriptions.push(timeTrackerStatusBar);

    // Function to expand running timers
    const expandRunningTimers = async () => {
        if (!timeTrackerTreeView.visible) {
            return;
        }
        try {
            const config = timeTrackerManager.getConfig();
            if (!config) {
                return;
            }
            const runningTimers: Timer[] = [];

            // Collect all running timers
            const findRunningTimers = (folders: any[]) => {
                for (const folder of folders) {
                    for (const timer of folder.timers) {
                        const hasRunningSubtimer = timer.subtimers && timer.subtimers.some((st: SubTimer) => !st.endTime);
                        if (hasRunningSubtimer) {
                            runningTimers.push(timer);
                        }
                    }
                    if (folder.subfolders) {
                        findRunningTimers(folder.subfolders);
                    }
                }
            };
            findRunningTimers(config.folders || []);

            // Expand each running timer
            for (const timer of runningTimers) {
                try {
                    // Get root items
                    const rootItems = await timeTrackerProvider.getChildren(undefined);

                    // Search for the timer item recursively
                    const findTimerItem = async (items: TimeTrackerTreeItem[]): Promise<TimeTrackerTreeItem | null> => {
                        for (const item of items) {
                            if (item.isTimer()) {
                                const itemTimer = item.getTimer();
                                if (itemTimer && itemTimer.id === timer.id) {
                                    return item;
                                }
                            }
                            if (item.isFolder()) {
                                const children = await timeTrackerProvider.getChildren(item);
                                const found = await findTimerItem(children);
                                if (found) return found;
                            }
                        }
                        return null;
                    };

                    if (!timeTrackerTreeView.visible) {
                        return;
                    }

                    const timerItem = await findTimerItem(rootItems);
                    if (timerItem) {
                        await timeTrackerTreeView.reveal(timerItem, { expand: true, select: false, focus: false });
                    }
                } catch (error) {
                    // Item might not be visible yet, ignore
                }
            }
        } catch (error) {
            // Ignore errors during expansion
        }
    };

    // Update status bar when tree refreshes and expand running timers
    const originalRefresh = timeTrackerProvider.refresh.bind(timeTrackerProvider);
    timeTrackerProvider.refresh = () => {
        originalRefresh();
        timeTrackerStatusBar.update();
        // Expand running timers after a short delay to ensure tree is updated
        setTimeout(() => {
            expandRunningTimers().catch(() => {
                // Ignore errors
            });
        }, 100);
    };

    // Initially expand running timers after tree is ready
    setTimeout(() => {
        expandRunningTimers().catch(() => {
            // Ignore errors
        });
    }, 500);

    // Discover tests for configs with autoFind enabled on extension load
    const configs = testRunnerManager.getConfigs().filter(c => c.activated && c.autoFind !== false);
    for (const config of configs) {
        await testRunnerManager.discoverAndCacheTests(config, testRunnerProvider);
    }

    const codeLensProvider = new TestRunnerCodeLensProvider(testRunnerManager);
    const codeLensSelectors: vscode.DocumentSelector = [
        { language: 'javascript', scheme: 'file' },
        { language: 'javascriptreact', scheme: 'file' },
        { language: 'typescript', scheme: 'file' },
        { language: 'typescriptreact', scheme: 'file' },
        { language: 'python', scheme: 'file' }
    ];
    const codeLensRegistration = vscode.languages.registerCodeLensProvider(codeLensSelectors, codeLensProvider);

    // Set tree provider in executor for icon updates
    commandExecutor.setTreeProvider(treeProvider);
    commandExecutor.setWebviewManager(webviewManager);
    webviewManager.setTreeProvider(treeProvider);
    webviewManager.setTestRunnerTreeProvider(testRunnerProvider);
    webviewManager.setTimeTrackerTreeProvider(timeTrackerProvider);

    const statusBarManager = new StatusBarManager(context, treeProvider, configManager);
    context.subscriptions.push(
        statusBarManager,
        documentationProvider,
        documentationTreeView,
        commandTreeView,
        testRunnerProvider,
        testRunnerTreeView,
        timeTrackerTreeView,
        codeLensProvider,
        codeLensRegistration
    );

    // Editor decorations for test status
    const decorationTypes = {
        running: vscode.window.createTextEditorDecorationType({
            isWholeLine: false,
            before: { contentText: '⏳ ', color: new vscode.ThemeColor('charts.yellow'), margin: '0 6px 0 0' }
        }),
        passed: vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.file(path.join(__dirname, '..', '..', 'resources', 'yes_9426997.png')),
            gutterIconSize: 'contain'
        }),
        failed: vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.file(path.join(__dirname, '..', '..', 'resources', 'remove_16597122.png')),
            gutterIconSize: 'contain'
        })
    };

    type TestEditorStatus = 'running' | 'passed' | 'failed';
    const testStatusById = new Map<string, TestEditorStatus>();

    function updateEditorDecorationsForDocument(document: vscode.TextDocument): void {
        const editors = vscode.window.visibleTextEditors.filter(e => e.document.uri.toString() === document.uri.toString());
        if (editors.length === 0) {
            return;
        }

        const configs = testRunnerManager.getConfigsForDocument(document);
        if (configs.length === 0) {
            for (const editor of editors) {
                editor.setDecorations(decorationTypes.running, []);
                editor.setDecorations(decorationTypes.passed, []);
                editor.setDecorations(decorationTypes.failed, []);
            }
            return;
        }

        const running: vscode.DecorationOptions[] = [];
        const passed: vscode.DecorationOptions[] = [];
        const failed: vscode.DecorationOptions[] = [];

        for (const config of configs) {
            const tests = testRunnerManager.extractTestsFromDocument(document, config);
            for (const test of tests) {
                const id = `${config.id}:${document.uri.toString()}:${test.line}`;
                const status = testStatusById.get(id);
                if (!status) continue;
                const target: vscode.DecorationOptions = { range: test.range };
                if (status === 'running') running.push(target);
                if (status === 'passed') passed.push(target);
                if (status === 'failed') failed.push(target);
            }
        }

        for (const editor of editors) {
            editor.setDecorations(decorationTypes.running, running);
            editor.setDecorations(decorationTypes.passed, passed);
            editor.setDecorations(decorationTypes.failed, failed);
        }
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) updateEditorDecorationsForDocument(editor.document);
        }),
        vscode.workspace.onDidChangeTextDocument(e => {
            updateEditorDecorationsForDocument(e.document);
        }),
        decorationTypes.running,
        decorationTypes.passed,
        decorationTypes.failed
    );

    const applyPosition = () => {
        const configuration = vscode.workspace.getConfiguration('commands-manager-next.documentationHub');
        const desiredPosition = configuration.get<DocumentationPosition>('position', 'bottom');
        void applyDocumentationViewPosition(desiredPosition);
    };

    applyPosition();

    const configurationListener = vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('commands-manager-next.documentationHub.position')) {
            applyPosition();
        }
    });
    context.subscriptions.push(configurationListener);

    // Register commands
    const runCommand = vscode.commands.registerCommand('commands-manager-next.tasks.runCommand', async (item: CommandTreeItem) => {
        if (item && item.isCommand()) {
            const command = item.getCommand();
            if (command) {
                try {
                    await commandExecutor.executeCommandWithProgress(command);
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to execute command: ${error}`);
                }
            }
        }
    });

    const runCommandById = vscode.commands.registerCommand('commands-manager-next.tasks.runCommandById', async (payload: string | { commandId: string }) => {
        const commandId = typeof payload === 'string' ? payload : payload?.commandId;
        if (!commandId) {
            return;
        }

        const command = await treeProvider.findCommandById(commandId);
        if (!command) {
            vscode.window.showWarningMessage(`Command "${commandId}" not found.`);
            return;
        }

        try {
            await commandExecutor.executeCommandWithProgress(command);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to execute command: ${error}`);
        }
    });

    const pinToStatusBar = vscode.commands.registerCommand('commands-manager-next.tasks.pinToStatusBar', async (item: CommandTreeItem) => {
        if (!item || !item.isCommand()) {
            return;
        }

        const command = item.getCommand();
        if (!command) {
            return;
        }

        await statusBarManager.togglePin(command);
    });

    const moveItemUp = vscode.commands.registerCommand('commands-manager-next.tasks.moveItemUp', async (item: CommandTreeItem) => {
        if (!item) {
            return;
        }

        await treeProvider.moveItemByOffset(item, -1);
    });

    const moveItemDown = vscode.commands.registerCommand('commands-manager-next.tasks.moveItemDown', async (item: CommandTreeItem) => {
        if (!item) {
            return;
        }

        await treeProvider.moveItemByOffset(item, 1);
    });

    const moveItemToFolder = vscode.commands.registerCommand('commands-manager-next.tasks.moveItemToFolder', async (item: CommandTreeItem) => {
        if (!item) {
            return;
        }

        const includeRoot = item.isFolder();
        const excludePath = item.isFolder() ? item.getFolderPath() : undefined;
        const quickPickItems = await treeProvider.getFolderQuickPickItems(includeRoot, excludePath);

        if (!includeRoot) {
            const foldersOnly = quickPickItems.filter(entry => entry.path.length > 0);
            quickPickItems.splice(0, quickPickItems.length, ...foldersOnly);
        }

        if (quickPickItems.length === 0) {
            void vscode.window.showWarningMessage('No available folders to move the item to.');
            return;
        }

        const selection = await vscode.window.showQuickPick(
            quickPickItems.map(entry => ({
                label: entry.label,
                description: entry.path.length === 0 ? 'Top level' : '',
                detail: entry.path.length ? `Path indexes: ${entry.path.join(' > ')}` : undefined,
                pathKey: JSON.stringify(entry.path)
            })),
            {
                placeHolder: item.isFolder() ? 'Select destination folder' : 'Select folder for this command'
            }
        );

        if (!selection) {
            return;
        }

        const target = quickPickItems.find(entry => JSON.stringify(entry.path) === (selection as any).pathKey);
        if (!target) {
            return;
        }

        await treeProvider.moveItemToFolder(item, target.path);
    });

    const editCommand = vscode.commands.registerCommand('commands-manager-next.tasks.editCommand', async (item: CommandTreeItem) => {
        if (item && item.isCommand()) {
            const command = item.getCommand();
            if (command) {
                webviewManager.showCommandEditor(command, {
                    folderPath: item.getFolderPath(),
                    commandIndex: item.getCommandIndex()
                });
            }
        } else {
            webviewManager.showCommandEditor();
        }
    });

    const newCommand = vscode.commands.registerCommand('commands-manager-next.tasks.newCommand', async (item?: CommandTreeItem) => {
        let contextInfo: { folderPath: number[] } | undefined;
        if (item) {
            if (item.isFolder()) {
                contextInfo = { folderPath: item.getFolderPath() };
            } else if (item.isCommand() && item.parent && item.parent.isFolder()) {
                contextInfo = { folderPath: item.parent.getFolderPath() };
            }
        }
        webviewManager.showCommandEditor(undefined, contextInfo);
    });

    const newFolder = vscode.commands.registerCommand('commands-manager-next.tasks.newFolder', async (item?: CommandTreeItem) => {
        let contextInfo: { parentPath?: number[] } | undefined;
        if (item) {
            if (item.isFolder()) {
                contextInfo = { parentPath: item.getFolderPath() };
            } else if (item.parent && item.parent.isFolder()) {
                contextInfo = { parentPath: item.parent.getFolderPath() };
            }
        }
        webviewManager.showFolderEditor(undefined, contextInfo);
    });

    const duplicateCommand = vscode.commands.registerCommand('commands-manager-next.tasks.duplicateCommand', async (item: CommandTreeItem) => {
        if (item && item.isCommand()) {
            const command = item.getCommand();
            if (command) {
                const newCommand = {
                    ...command,
                    id: `${command.id}-copy-${Date.now()}`,
                    label: `${command.label} (Copy)`
                };
                webviewManager.showCommandEditor(newCommand, {
                    folderPath: item.getFolderPath()
                });
            }
        }
    });

    const convertWorkspaceTask = vscode.commands.registerCommand('commands-manager-next.tasks.convertWorkspaceTask', async (item: CommandTreeItem) => {
        if (!item || !item.isCommand()) {
            return;
        }

        const command = item.getCommand();
        if (!command || !command.readOnly || command.source !== 'vscode-task') {
            return;
        }

        const config = configManager.getConfig();

        const collectIds = (folders: Folder[], bucket: Set<string>): void => {
            for (const folder of folders) {
                folder.commands.forEach(cmd => bucket.add(cmd.id));
                if (folder.subfolders?.length) {
                    collectIds(folder.subfolders, bucket);
                }
            }
        };

        const existingIds = new Set<string>();
        collectIds(config.folders, existingIds);

        const slugify = (value: string): string =>
            value
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '') || `converted-${Date.now()}`;

        const baseId = slugify(command.label || command.id || 'task');
        let candidateId = baseId;
        let counter = 1;
        while (existingIds.has(candidateId)) {
            candidateId = `${baseId}-${counter++}`;
        }

        const destinationFolderName = 'Converted Tasks';
        let destinationFolder = config.folders.find(folder => folder.name === destinationFolderName);
        if (!destinationFolder) {
            destinationFolder = {
                name: destinationFolderName,
                icon: '$(edit)',
                commands: [],
                subfolders: []
            };
            config.folders.push(destinationFolder);
        }

        const editableCommand: Command = {
            id: candidateId,
            label: command.label,
            command: command.command,
            description: command.description?.replace('Imported from tasks.json', 'Converted from tasks.json') ?? 'Converted from tasks.json',
            terminal: { ...command.terminal },
            variables: command.variables ? command.variables.map(variable => ({ ...variable })) : undefined,
            icon: command.icon,
            source: 'config'
        };

        destinationFolder.commands.push(editableCommand);

        try {
            await configManager.saveConfig(config);
            treeProvider.refresh();
            vscode.window.showInformationMessage(`Converted "${command.label}" into an editable task.`);
            webviewManager.showCommandEditor(editableCommand);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to convert task: ${error}`);
        }
    });

    const editFolder = vscode.commands.registerCommand('commands-manager-next.tasks.editFolder', async (item: CommandTreeItem) => {
        if (item && item.isFolder()) {
            const folder = item.getFolder();
            if (folder) {
                webviewManager.showFolderEditor(folder, { path: item.getFolderPath() });
            }
        }
    });

    const quickRun = vscode.commands.registerCommand('commands-manager-next.tasks.quickRun', async () => {
        const commands = await treeProvider.getAllCommands();
        if (commands.length === 0) {
            vscode.window.showInformationMessage('No commands configured yet. Create one from the Commands Manager Next view.');
            return;
        }

        const selection = await vscode.window.showQuickPick(commands.map(command => ({
            label: command.label,
            description: command.description || '',
            detail: command.command,
            command
        })), {
            placeHolder: 'Select a command to run'
        });

        if (selection?.command) {
            try {
                await commandExecutor.executeCommandWithProgress(selection.command);
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to execute command: ${error}`);
            }
        }
    });

    const deleteItem = vscode.commands.registerCommand('commands-manager-next.tasks.deleteItem', async (item: CommandTreeItem) => {
        if (!item) return;

        if (item.isCommand()) {
            const command = item.getCommand();
            if (command?.readOnly) {
                void vscode.window.showInformationMessage('Imported tasks from tasks.json cannot be deleted. Convert them to editable tasks first.');
                return;
            }
        } else if (item.isFolder()) {
            const folder = item.getFolder();
            if (folder?.readOnly) {
                void vscode.window.showInformationMessage('The tasks.json folder is read-only.');
                return;
            }
        }

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete "${item.label}"?`,
            { modal: true },
            'Delete'
        );

        if (confirm === 'Delete') {
            try {
                const config = configManager.getConfig();

                if (item.isCommand()) {
                    const command = item.getCommand();
                    if (command) {
                        deleteCommandFromConfig(config, command.id);
                    }
                } else if (item.isFolder()) {
                    const folder = item.getFolder();
                    if (folder) {
                        deleteFolderFromConfig(config, folder.name);
                    }
                }

                await configManager.saveConfig(config);
                treeProvider.refresh();
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to delete item: ${error}`);
            }
        }
    });

    const openConfig = vscode.commands.registerCommand('commands-manager-next.tasks.openConfig', async () => {
        await configManager.openConfigFile();
    });

    const refresh = vscode.commands.registerCommand('commands-manager-next.tasks.refresh', async () => {
        await configManager.loadConfig();
        treeProvider.refresh();
    });

    // Webview commands
    const openConfiguration = vscode.commands.registerCommand('commands-manager-next.tasks.openConfiguration', () => {
        webviewManager.showConfigurationManager();
    });

    // Import/Export commands
    const importCommands = vscode.commands.registerCommand('commands-manager-next.tasks.importCommands', async () => {
        const fileUri = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            filters: {
                'JSON Files': ['json']
            }
        });

        if (fileUri && fileUri[0]) {
            try {
                await configManager.importCommands(fileUri[0].fsPath);
                treeProvider.refresh();
                vscode.window.showInformationMessage('Tasks imported successfully');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to import commands: ${error}`);
            }
        }
    });

    const exportCommands = vscode.commands.registerCommand('commands-manager-next.tasks.exportCommands', async () => {
        const fileUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('commands.json'),
            filters: {
                'JSON Files': ['json']
            }
        });

        if (fileUri) {
            try {
                await configManager.exportCommands(fileUri.fsPath);
                vscode.window.showInformationMessage('Tasks exported successfully');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to export commands: ${error}`);
            }
        }
    });

    // Helper methods for deletion
    function deleteCommandFromConfig(config: any, commandId: string): void {
        for (const folder of config.folders) {
            const commandIndex = folder.commands.findIndex((cmd: any) => cmd.id === commandId);
            if (commandIndex !== -1) {
                folder.commands.splice(commandIndex, 1);
                return;
            }

            if (folder.subfolders) {
                deleteCommandFromSubfolders(folder.subfolders, commandId);
            }
        }
    }

    function deleteCommandFromSubfolders(subfolders: any[], commandId: string): void {
        for (const subfolder of subfolders) {
            const commandIndex = subfolder.commands.findIndex((cmd: any) => cmd.id === commandId);
            if (commandIndex !== -1) {
                subfolder.commands.splice(commandIndex, 1);
                return;
            }

            if (subfolder.subfolders) {
                deleteCommandFromSubfolders(subfolder.subfolders, commandId);
            }
        }
    }

    function deleteFolderFromConfig(config: any, folderName: string): void {
        const folderIndex = config.folders.findIndex((folder: any) => folder.name === folderName);
        if (folderIndex !== -1) {
            config.folders.splice(folderIndex, 1);
            return;
        }

        deleteFolderFromSubfolders(config.folders, folderName);
    }

    function deleteFolderFromSubfolders(folders: any[], folderName: string): void {
        for (const folder of folders) {
            if (folder.subfolders) {
                const subfolderIndex = folder.subfolders.findIndex((subfolder: any) => subfolder.name === folderName);
                if (subfolderIndex !== -1) {
                    folder.subfolders.splice(subfolderIndex, 1);
                    return;
                }

                deleteFolderFromSubfolders(folder.subfolders, folderName);
            }
        }
    }

    // Register context menu for tree view
    vscode.window.registerTreeDataProvider('commandManagerTree', treeProvider);

    // Add all commands to context
    context.subscriptions.push(
        runCommand,
        editCommand,
        newCommand,
        newFolder,
        editFolder,
        duplicateCommand,
        convertWorkspaceTask,
        runCommandById,
        pinToStatusBar,
        moveItemUp,
        moveItemDown,
        moveItemToFolder,
        deleteItem,
        openConfig,
        refresh,
        openConfiguration,
        quickRun,
        importCommands,
        exportCommands
    );

    const newTestRunnerConfiguration = vscode.commands.registerCommand(
        'commands-manager-next.tests.newConfiguration',
        () => {
            webviewManager.showTestRunnerEditor();
        }
    );

    const openTestRunnerConfiguration = vscode.commands.registerCommand(
        'commands-manager-next.tests.openConfiguration',
        (item?: TestRunnerTreeItem) => {
            const configId = item && item.isConfig() ? item.config.id : undefined;
            webviewManager.showTestRunnerEditor(configId);
        }
    );

    const runAllTestsCommand = vscode.commands.registerCommand('commands-manager-next.tests.runAll', async () => {
        await testRunnerManager.runAll(undefined, testRunnerProvider);
    });

    const stopAllTestsCommand = vscode.commands.registerCommand('commands-manager-next.tests.stopAll', () => {
        testRunnerManager.cancelRunAll();
        vscode.window.showInformationMessage('Stopping all tests...');
    });

    const runConfigurationCommand = vscode.commands.registerCommand(
        'commands-manager-next.tests.runConfiguration',
        async (item: TestRunnerTreeItem) => {
            if (!item || !item.isConfig()) {
                return;
            }
            await testRunnerManager.runAll(item.config, testRunnerProvider);
        }
    );

    const runFolderCommand = vscode.commands.registerCommand(
        'commands-manager-next.tests.runFolder',
        async (item: TestRunnerTreeItem) => {
            if (!item || item.itemType !== 'folder' || !item.folderPath) {
                return;
            }
            const tests = testRunnerProvider.getTestsForFolder(item.config, item.folderPath);
            if (tests.length === 0) {
                vscode.window.showInformationMessage('No tests found in this folder.');
                return;
            }

            // Set all tests and parent to running
            testRunnerProvider.setTestsStatus(tests, 'running');
            testRunnerProvider.setParentStatus(item.config.id, 'folder', item.folderPath, 'running');
            // Refresh the config to ensure all children (folders, files, testcases, and tests) are recreated
            const configItem = new TestRunnerTreeItem('config', item.config);
            testRunnerProvider.refresh();

            try {
                // Use resolver to run all tests in folder with a single command
                const passed = await testRunnerManager.runTestsInPathWithResult(item.config, tests, 'folder', item.folderPath);

                // Update all tests and parent to passed/failed
                testRunnerProvider.setTestsStatus(tests, passed ? 'passed' : 'failed');
                testRunnerProvider.setParentStatus(item.config.id, 'folder', item.folderPath, passed ? 'passed' : 'failed');
                // Refresh the config to ensure all children are recreated with updated statuses
                testRunnerProvider.refresh();
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Test execution failed: ${errorMessage}`);
                testRunnerProvider.setTestsStatus(tests, 'failed');
                testRunnerProvider.setParentStatus(item.config.id, 'folder', item.folderPath, 'failed');
                // Refresh the config to ensure all children are recreated with updated statuses
                testRunnerProvider.refresh();
            }
        }
    );

    const runFileCommand = vscode.commands.registerCommand(
        'commands-manager-next.tests.runFile',
        async (item: TestRunnerTreeItem) => {
            if (!item || item.itemType !== 'file' || !item.folderPath || !item.fileName) {
                return;
            }
            const tests = testRunnerProvider.getTestsForFile(item.config, item.folderPath, item.fileName);
            if (tests.length === 0) {
                vscode.window.showInformationMessage('No tests found in this file.');
                return;
            }

            // Set all tests and parent to running
            const fileKey = `${item.folderPath}/${item.fileName}`;
            testRunnerProvider.setTestsStatus(tests, 'running');
            testRunnerProvider.setParentStatus(item.config.id, 'file', fileKey, 'running');
            // Refresh the parent folder to ensure all children (files, testcases, and tests) are recreated
            const parentFolderItem = new TestRunnerTreeItem('folder', item.config, undefined, undefined, item.folderPath);
            testRunnerProvider.refresh();

            try {
                // Use resolver to run all tests in file with a single command
                const passed = await testRunnerManager.runTestsInPathWithResult(item.config, tests, 'file');

                // Update all tests and parent to passed/failed
                testRunnerProvider.setTestsStatus(tests, passed ? 'passed' : 'failed');
                testRunnerProvider.setParentStatus(item.config.id, 'file', fileKey, passed ? 'passed' : 'failed');
                // Refresh the parent folder to ensure all children are recreated with updated statuses
                testRunnerProvider.refresh();
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Test execution failed: ${errorMessage}`);
                testRunnerProvider.setTestsStatus(tests, 'failed');
                testRunnerProvider.setParentStatus(item.config.id, 'file', fileKey, 'failed');
                // Refresh the parent folder to ensure all children are recreated with updated statuses
                testRunnerProvider.refresh();
            }
        }
    );

    const runTestCaseCommand = vscode.commands.registerCommand(
        'commands-manager-next.tests.runTestCase',
        async (item: TestRunnerTreeItem) => {
            if (!item || item.itemType !== 'testcase' || !item.folderPath || !item.fileName || !item.testCaseName) {
                return;
            }
            const tests = testRunnerProvider.getTestsForTestCase(item.config, item.folderPath, item.fileName, item.testCaseName);
            if (tests.length === 0) {
                vscode.window.showInformationMessage('No tests found in this test case.');
                return;
            }

            // Set all tests and parent to running
            const testCaseKey = `${item.folderPath}/${item.fileName}/${item.testCaseName}`;
            testRunnerProvider.setTestsStatus(tests, 'running');
            testRunnerProvider.setParentStatus(item.config.id, 'testcase', testCaseKey, 'running');
            // Refresh both the testcase item and its parent file to ensure all children are recreated
            const parentFileItem = new TestRunnerTreeItem('file', item.config, undefined, undefined, item.folderPath, item.fileName);
            testRunnerProvider.refresh();

            try {
                // Use resolver to run all tests in test case with a single command
                const passed = await testRunnerManager.runTestsInPathWithResult(item.config, tests, 'testcase', undefined, item.testCaseName);

                // Update all tests and parent to passed/failed
                testRunnerProvider.setTestsStatus(tests, passed ? 'passed' : 'failed');
                testRunnerProvider.setParentStatus(item.config.id, 'testcase', testCaseKey, passed ? 'passed' : 'failed');
                // Refresh both the testcase item and its parent file to ensure all children are recreated with updated statuses
                testRunnerProvider.refresh();
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Test execution failed: ${errorMessage}`);
                testRunnerProvider.setTestsStatus(tests, 'failed');
                testRunnerProvider.setParentStatus(item.config.id, 'testcase', testCaseKey, 'failed');
                // Refresh both the testcase item and its parent file to ensure all children are recreated with updated statuses
                testRunnerProvider.refresh();
            }
        }
    );

    const moveTestRunnerUp = vscode.commands.registerCommand('commands-manager-next.tests.moveUp', async (item: TestRunnerTreeItem) => {
        if (!item || !item.isConfig()) {
            return;
        }

        const configs = testRunnerManager.getConfigs();
        const index = configs.findIndex(config => config.id === item.config.id);
        if (index > 0) {
            await testRunnerManager.moveConfig(item.config.id, index - 1);
        }
    });

    const moveTestRunnerDown = vscode.commands.registerCommand('commands-manager-next.tests.moveDown', async (item: TestRunnerTreeItem) => {
        if (!item || !item.isConfig()) {
            return;
        }

        const configs = testRunnerManager.getConfigs();
        const index = configs.findIndex(config => config.id === item.config.id);
        if (index !== -1 && index < configs.length - 1) {
            await testRunnerManager.moveConfig(item.config.id, index + 1);
        }
    });

    const moveTestRunnerTo = vscode.commands.registerCommand('commands-manager-next.tests.moveTo', async (item: TestRunnerTreeItem) => {
        if (!item || !item.isConfig()) {
            return;
        }

        const configs = testRunnerManager.getConfigs();
        const picks: Array<vscode.QuickPickItem & { index: number }> = configs.map((config, idx) => ({
            label: `${idx + 1}. ${config.title}`,
            description: config.id === item.config.id ? 'Current position' : undefined,
            index: idx
        }));

        const selection = (await vscode.window.showQuickPick(picks, {
            placeHolder: 'Select the new position for this configuration'
        })) as (typeof picks)[number] | undefined;

        if (!selection) {
            return;
        }

        await testRunnerManager.moveConfig(item.config.id, selection.index);
    });

    const hideTestRunnerConfiguration = vscode.commands.registerCommand('commands-manager-next.tests.disableConfiguration', async (item: TestRunnerTreeItem) => {
        if (!item || !item.isConfig()) {
            return;
        }

        await testRunnerManager.setActivation(item.config.id, false);
    });

    const unhideTestRunnerConfiguration = vscode.commands.registerCommand(
        'commands-manager-next.tests.enableConfiguration',
        async (item: TestRunnerTreeItem) => {
            if (!item || !item.isConfig()) {
                return;
            }

            await testRunnerManager.setActivation(item.config.id, true);
        }
    );

    const runSingleTestCommand = vscode.commands.registerCommand(
        'commands-manager-next.tests.runTest',
        async (arg1: TestRunnerTreeItem | TestRunnerConfig, arg2?: DiscoveredTest) => {
            let config: TestRunnerConfig | undefined;
            let test: DiscoveredTest | undefined;
            let treeItem: TestRunnerTreeItem | undefined;

            if (arg1 instanceof TestRunnerTreeItem) {
                if (!arg1.isTest() || !arg1.test) {
                    return;
                }
                config = arg1.config;
                test = arg1.test;
                treeItem = arg1;
            } else {
                config = arg1;
                test = arg2;
            }

            if (!config || !test) {
                return;
            }

            // Update test status to running
            if (treeItem) {
                treeItem.setStatus('running');
                testRunnerProvider.refresh(treeItem);
            }

            // Editor decoration: set running
            try {
                const id = `${config.id}:${test.file.toString()}:${test.line}`;
                testStatusById.set(id, 'running');
                const doc = await vscode.workspace.openTextDocument(test.file);
                updateEditorDecorationsForDocument(doc);
            } catch { }

            try {
                const passed = await testRunnerManager.runTestWithResult(config, test.label, {
                    file: test.file.fsPath,
                    line: String(test.line + 1)
                });

                // Update test status to actual result
                if (treeItem) {
                    treeItem.setStatus(passed ? 'passed' : 'failed');
                    testRunnerProvider.refresh(treeItem);
                }

                // Editor decoration: set passed
                try {
                    const id = `${config.id}:${test.file.toString()}:${test.line}`;
                    testStatusById.set(id, passed ? 'passed' : 'failed');
                    const doc = await vscode.workspace.openTextDocument(test.file);
                    updateEditorDecorationsForDocument(doc);
                } catch { }
            } catch (error) {
                // Show error message to user
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Test execution failed: ${errorMessage}`);

                // Update test status to failed
                if (treeItem) {
                    treeItem.setStatus('failed');
                    testRunnerProvider.refresh(treeItem);
                }

                // Editor decoration: set failed
                try {
                    const id = `${config.id}:${test.file.toString()}:${test.line}`;
                    testStatusById.set(id, 'failed');
                    const doc = await vscode.workspace.openTextDocument(test.file);
                    updateEditorDecorationsForDocument(doc);
                } catch { }
            }
        }
    );

    const ignoreTestCommand = vscode.commands.registerCommand(
        'commands-manager-next.tests.ignoreTest',
        async (arg1: TestRunnerTreeItem | TestRunnerConfig, arg2?: DiscoveredTest) => {
            let config: TestRunnerConfig | undefined;
            let test: DiscoveredTest | undefined;

            if (arg1 instanceof TestRunnerTreeItem) {
                if (!arg1.isTest() || !arg1.test) {
                    return;
                }
                config = arg1.config;
                test = arg1.test;
            } else {
                config = arg1;
                test = arg2;
            }

            if (!config || !test) {
                return;
            }

            await testRunnerManager.addIgnoredTest(config.id, test.label);
            vscode.window.showInformationMessage(`Ignored "${test.label}" in ${config.title}.`);
        }
    );

    const gotoTestCommand = vscode.commands.registerCommand(
        'commands-manager-next.tests.gotoTest',
        async (arg1: TestRunnerTreeItem | TestRunnerConfig, arg2?: DiscoveredTest) => {
            let test: DiscoveredTest | undefined;

            if (arg1 instanceof TestRunnerTreeItem) {
                if (!arg1.isTest() || !arg1.test) {
                    return;
                }
                test = arg1.test;
            } else {
                test = arg2;
            }

            if (!test) {
                return;
            }

            const document = await vscode.workspace.openTextDocument(test.file);
            const editor = await vscode.window.showTextDocument(document);
            const position = new vscode.Position(test.line, 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }
    );

    const expandAllTestRunners = vscode.commands.registerCommand('commands-manager-next.tests.expandAll', async (item?: TestRunnerTreeItem) => {
        if (item) {
            // Expand specific item and all its children recursively (up to 3 levels)
            await testRunnerTreeView.reveal(item, { expand: 3, focus: false });
        } else {
            // Expand all configs
            const configs = testRunnerManager.getConfigs();
            for (const config of configs) {
                const configItem = new TestRunnerTreeItem('config', config);
                try {
                    await testRunnerTreeView.reveal(configItem, { expand: 3, focus: false });
                } catch (error) {
                    // Item might not be visible yet, continue with next
                }
            }
        }
    });

    const collapseAllTestRunners = vscode.commands.registerCommand('commands-manager-next.tests.collapseAll', async (item?: TestRunnerTreeItem) => {
        if (item) {
            // Collapse specific item - refresh it to reset its state
            testRunnerProvider.refresh(item);
            setTimeout(() => {
                testRunnerProvider.refresh(item);
            }, 50);
        } else {
            // Collapse all - refresh the entire tree
            testRunnerProvider.refresh();
            setTimeout(() => {
                testRunnerProvider.refresh();
            }, 50);
        }
    });

    const refreshTestRunners = vscode.commands.registerCommand('commands-manager-next.tests.refresh', async () => {
        // Clear all test statuses to reset icons
        testRunnerProvider.clearAllStatuses();
        // Discover tests only for configs with AutoFind ON
        const configs = testRunnerManager.getConfigs().filter(c => c.activated && c.autoFind !== false);
        for (const config of configs) {
            await testRunnerManager.discoverAndCacheTests(config, testRunnerProvider);
        }
        testRunnerProvider.refresh();
    });

    const findTestsForConfig = vscode.commands.registerCommand('commands-manager-next.tests.findTests', async (item: TestRunnerTreeItem) => {
        if (!item || !item.isConfig()) {
            return;
        }

        // Discover tests and cache them in the tree provider
        const tests = await testRunnerManager.discoverAndCacheTests(item.config, testRunnerProvider);
        vscode.window.showInformationMessage(`Found ${tests.length} test(s) for "${item.config.title}". Please Refresh the Test Runner to see the tests in the tree view.`);
        setTimeout(() => { void vscode.commands.executeCommand('commands-manager-next.tests.refresh'); }, 200);
    });

    const searchTests = vscode.commands.registerCommand('commands-manager-next.tests.search', async () => {
        await testRunnerProvider.setSearchQuery();
    });

    context.subscriptions.push(
        newTestRunnerConfiguration,
        openTestRunnerConfiguration,
        runAllTestsCommand,
        runConfigurationCommand,
        stopAllTestsCommand,
        runFolderCommand,
        runFileCommand,
        runTestCaseCommand,
        moveTestRunnerUp,
        moveTestRunnerDown,
        moveTestRunnerTo,
        hideTestRunnerConfiguration,
        unhideTestRunnerConfiguration,
        runSingleTestCommand,
        ignoreTestCommand,
        gotoTestCommand,
        expandAllTestRunners,
        collapseAllTestRunners,
        refreshTestRunners,
        findTestsForConfig,
        searchTests
    );

    // Documentation hub commands
    const openDocumentation = vscode.commands.registerCommand('commands-manager-next.docs.openFile', async (uri: vscode.Uri) => {
        await documentationProvider.openFile(uri);
    });

    const copyDocumentationPath = vscode.commands.registerCommand('commands-manager-next.docs.copyPath', async (uri: vscode.Uri) => {
        await documentationProvider.copyFilePath(uri);
    });

    const extractDocumentationCommands = vscode.commands.registerCommand(
        'commands-manager-next.docs.extractCommands',
        async (uri: vscode.Uri) => {
            await documentationProvider.extractCommandsFromReadme(uri);
        }
    );

    const searchDocumentation = vscode.commands.registerCommand('commands-manager-next.docs.search', async () => {
        await documentationProvider.setSearchQuery();
    });

    const toggleDocumentationViewMode = vscode.commands.registerCommand('commands-manager-next.docs.toggleViewMode', () => {
        documentationProvider.toggleViewMode();
    });

    const refreshDocumentation = vscode.commands.registerCommand('commands-manager-next.docs.refresh', async () => {
        await documentationProvider.reload();
    });

    const openDocumentationSection = vscode.commands.registerCommand(
        'commands-manager-next.docs.openSection',
        async (target: { path: string; line: number }) => {
            await documentationProvider.openSection(target);
        }
    );

    const hideDocumentationItem = vscode.commands.registerCommand('commands-manager-next.docs.hideItem', async (item: any) => {
        if (item && (item.type === 'folder' || item.type === 'file')) {
            documentationProvider.hideItem(item);
        }
    });

    const unhideDocumentationItem = vscode.commands.registerCommand('commands-manager-next.docs.unhideItem', async (item: any) => {
        if (item && (item.type === 'folder' || item.type === 'file')) {
            documentationProvider.unhideItem(item);
        }
    });

    const unhideAllDocumentation = vscode.commands.registerCommand('commands-manager-next.docs.unhideAll', () => {
        documentationProvider.unhideAll();
    });

    // Time Tracker commands
    const startTimerCommand = vscode.commands.registerCommand('commands-manager-next.time.startTimer', async (item?: TimeTrackerTreeItem) => {
        const label = await vscode.window.showInputBox({
            prompt: 'Enter timer label',
            placeHolder: 'Timer name'
        });
        if (label === undefined) return;

        const folderPath = item && item.isFolder() ? item.getFolderPath() : undefined;
        await timeTrackerManager.startTimer(label, folderPath);
        timeTrackerProvider.refresh();
        timeTrackerStatusBar.update();
        vscode.window.showInformationMessage(`Timer "${label}" started`);
    });

    const stopTimerCommand = vscode.commands.registerCommand('commands-manager-next.time.stopTimer', async (item: TimeTrackerTreeItem) => {
        if (!item || !item.isTimer()) return;
        const timer = item.getTimer();
        if (!timer) return;
        // Check if timer has any running subtimers
        const hasRunningSubtimer = timer.subtimers && timer.subtimers.some(st => !st.endTime);
        if (!hasRunningSubtimer) return;

        await timeTrackerManager.stopTimer(timer.id);
        timeTrackerProvider.refresh();
        timeTrackerStatusBar.update();
        vscode.window.showInformationMessage(`Timer "${timer.label}" stopped`);
    });

    const stopAllTimersCommand = vscode.commands.registerCommand('commands-manager-next.time.stopAll', async () => {
        await timeTrackerManager.stopAllTimers();
        timeTrackerProvider.refresh();
        timeTrackerStatusBar.update();
        vscode.window.showInformationMessage('All timers stopped');
    });

    const editTimerCommand = vscode.commands.registerCommand('commands-manager-next.time.editTimer', async (item: TimeTrackerTreeItem) => {
        if (!item || !item.isTimer()) return;
        const timer = item.getTimer();
        if (!timer) return;

        webviewManager.showTimerEditor(timer.id);
    });

    const deleteTimerCommand = vscode.commands.registerCommand('commands-manager-next.time.deleteTimer', async (item: TimeTrackerTreeItem) => {
        if (!item || !item.isTimer()) return;
        const timer = item.getTimer();
        if (!timer) return;

        const confirmed = await vscode.window.showWarningMessage(
            `Delete timer "${timer.label}"?`,
            { modal: true },
            'Delete'
        );
        if (confirmed !== 'Delete') return;

        await timeTrackerManager.deleteTimer(timer.id);
        timeTrackerProvider.refresh();
        vscode.window.showInformationMessage('Timer deleted');
    });

    const archiveTimerCommand = vscode.commands.registerCommand('commands-manager-next.time.archiveTimer', async (item: TimeTrackerTreeItem) => {
        if (!item || !item.isTimer()) return;
        const timer = item.getTimer();
        if (!timer) return;

        const wasArchived = timer.archived;
        await timeTrackerManager.archiveTimer(timer.id, !timer.archived);
        timeTrackerProvider.refresh();
        vscode.window.showInformationMessage(wasArchived ? 'Timer unarchived' : 'Timer archived');
    });

    const newFolderCommand = vscode.commands.registerCommand('commands-manager-next.time.newFolder', async (item?: TimeTrackerTreeItem) => {
        const name = await vscode.window.showInputBox({
            prompt: 'Enter folder name',
            placeHolder: 'Folder name'
        });
        if (!name) return;

        const parentPath = item && item.isFolder() ? item.getFolderPath() : undefined;
        await timeTrackerManager.createFolder(name, parentPath);
        timeTrackerProvider.refresh();
    });

    const moveTimerToFolderCommand = vscode.commands.registerCommand('commands-manager-next.time.moveToFolder', async (timerItem: TimeTrackerTreeItem, folderItem?: TimeTrackerTreeItem) => {
        if (!timerItem || !timerItem.isTimer()) return;
        const timer = timerItem.getTimer();
        if (!timer) return;

        // If folderItem is provided, use it; otherwise show quick pick
        if (folderItem && folderItem.isFolder()) {
            const folderPath = folderItem.getFolderPath();
            await timeTrackerManager.moveTimerToFolder(timer.id, folderPath);
            timeTrackerProvider.refresh();
        } else {
            // Show quick pick to select folder
            const configManager = ConfigManager.getInstance();
            const config = configManager.getTimeTrackerConfig();

            const folderOptions: Array<{ label: string; path?: number[]; description?: string }> = [
                { label: '$(folder-opened) Root Level', description: 'No category', path: undefined }
            ];

            const collectFolders = (folders: typeof config.folders, parentPath: number[] = [], prefix: string = ''): void => {
                folders.forEach((folder, index) => {
                    if (folder.name) { // Skip root folder (empty name)
                        const path = [...parentPath, index];
                        folderOptions.push({
                            label: `${prefix}${folder.name}`,
                            path: path,
                            description: `Path: ${path.join(' > ')}`
                        });
                        if (folder.subfolders) {
                            collectFolders(folder.subfolders, path, `${prefix}  `);
                        }
                    }
                });
            };
            collectFolders(config.folders);

            const selection = await vscode.window.showQuickPick(folderOptions, {
                placeHolder: 'Select folder for timer'
            });

            if (selection) {
                await timeTrackerManager.moveTimerToFolder(timer.id, selection.path);
                timeTrackerProvider.refresh();
            }
        }
    });

    const resumeTimerCommand = vscode.commands.registerCommand('commands-manager-next.time.resumeTimer', async (item: TimeTrackerTreeItem) => {
        if (!item || !item.isTimer()) return;
        const timer = item.getTimer();
        if (!timer) return;
        // Check if timer has any running subtimers (if so, it's already running)
        const hasRunningSubtimer = timer.subtimers && timer.subtimers.some(st => !st.endTime);
        if (hasRunningSubtimer) return; // Can only resume stopped timers

        // Resume the timer (start the last subtimer)
        await timeTrackerManager.resumeTimer(timer.id);
        timeTrackerProvider.refresh();
        timeTrackerStatusBar.update();
        vscode.window.showInformationMessage(`Timer "${timer.label}" resumed`);
    });

    const moveTimerUpCommand = vscode.commands.registerCommand('commands-manager-next.time.moveTimerUp', async (item: TimeTrackerTreeItem) => {
        if (!item || !item.isTimer()) return;
        const timer = item.getTimer();
        if (!timer) return;

        await timeTrackerManager.moveTimerByOffset(timer.id, -1);
        timeTrackerProvider.refresh();
    });

    const moveTimerDownCommand = vscode.commands.registerCommand('commands-manager-next.time.moveTimerDown', async (item: TimeTrackerTreeItem) => {
        if (!item || !item.isTimer()) return;
        const timer = item.getTimer();
        if (!timer) return;

        await timeTrackerManager.moveTimerByOffset(timer.id, 1);
        timeTrackerProvider.refresh();
    });

    const createSubTimerCommand = vscode.commands.registerCommand('commands-manager-next.time.createSubTimer', async (item: TimeTrackerTreeItem) => {
        if (!item || !item.isTimer()) return;
        const timer = item.getTimer();
        if (!timer) return;

        // Calculate next session number
        const sessionNumber = timer.subtimers ? timer.subtimers.length + 1 : 1;
        const label = `Session ${sessionNumber}`;

        try {
            // Only start immediately if parent timer is running (has running subtimers)
            const hasRunningSubtimer = timer.subtimers && timer.subtimers.some(st => !st.endTime);
            const startImmediately = hasRunningSubtimer;
            await timeTrackerManager.createSubTimer(timer.id, label, undefined, startImmediately);
            timeTrackerProvider.refresh();
            timeTrackerStatusBar.update();
            if (startImmediately) {
                vscode.window.showInformationMessage(`SubTimer "${label}" created and started`);
            } else {
                vscode.window.showInformationMessage(`SubTimer "${label}" created`);
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create subtimer: ${error}`);
        }
    });

    const startSubTimerCommand = vscode.commands.registerCommand('commands-manager-next.time.startSubTimer', async (item: TimeTrackerTreeItem) => {
        if (!item || !item.isSubTimer()) return;
        const subtimer = item.getSubTimer();
        if (!subtimer) return;

        const parentTimer = item.parent?.getTimer();
        if (!parentTimer) return;

        await timeTrackerManager.startSubTimer(parentTimer.id, subtimer.id);
        timeTrackerProvider.refresh();
        timeTrackerStatusBar.update();
        vscode.window.showInformationMessage(`SubTimer "${subtimer.label}" started`);
    });

    const stopSubTimerCommand = vscode.commands.registerCommand('commands-manager-next.time.stopSubTimer', async (item: TimeTrackerTreeItem) => {
        if (!item || !item.isSubTimer()) return;
        const subtimer = item.getSubTimer();
        if (!subtimer || subtimer.endTime) return;

        const parentTimer = item.parent?.getTimer();
        if (!parentTimer) return;

        await timeTrackerManager.stopSubTimer(parentTimer.id, subtimer.id);
        timeTrackerProvider.refresh();
        timeTrackerStatusBar.update();
        vscode.window.showInformationMessage(`SubTimer "${subtimer.label}" stopped`);
    });

    const editSubTimerCommand = vscode.commands.registerCommand('commands-manager-next.time.editSubTimer', async (item: TimeTrackerTreeItem) => {
        if (!item || !item.isSubTimer()) return;
        const subtimer = item.getSubTimer();
        if (!subtimer) return;

        const parentTimer = item.parent?.getTimer();
        if (!parentTimer) return;

        const newLabel = await vscode.window.showInputBox({
            prompt: 'Enter new subtimer label',
            value: subtimer.label
        });
        if (newLabel === undefined) return;

        const newDescription = await vscode.window.showInputBox({
            prompt: 'Enter new subtimer description (optional)',
            value: subtimer.description || ''
        });

        const updates: Partial<typeof subtimer> = {};
        if (newLabel !== subtimer.label) {
            updates.label = newLabel;
        }
        if (newDescription !== (subtimer.description || '')) {
            updates.description = newDescription || undefined;
        }

        if (Object.keys(updates).length > 0) {
            await timeTrackerManager.editSubTimer(parentTimer.id, subtimer.id, updates);
            timeTrackerProvider.refresh();
        }
    });

    const deleteSubTimerCommand = vscode.commands.registerCommand('commands-manager-next.time.deleteSubTimer', async (item: TimeTrackerTreeItem) => {
        if (!item || !item.isSubTimer()) return;
        const subtimer = item.getSubTimer();
        if (!subtimer) return;

        const parentTimer = item.parent?.getTimer();
        if (!parentTimer) return;

        const confirmed = await vscode.window.showWarningMessage(
            `Delete subtimer "${subtimer.label}"?`,
            { modal: true },
            'Delete'
        );
        if (confirmed !== 'Delete') return;

        await timeTrackerManager.deleteSubTimer(parentTimer.id, subtimer.id);
        timeTrackerProvider.refresh();
        vscode.window.showInformationMessage('SubTimer deleted');
    });

    const refreshTimeTrackerCommand = vscode.commands.registerCommand('commands-manager-next.time.refresh', () => {
        timeTrackerProvider.refresh();
        timeTrackerStatusBar.update();
    });

    const toggleEnabledCommand = vscode.commands.registerCommand('commands-manager-next.time.toggleEnabled', async () => {
        const isEnabled = timeTrackerManager.isEnabled();
        await timeTrackerManager.setEnabled(!isEnabled);
        timeTrackerProvider.refresh();
        timeTrackerStatusBar.update();
        vscode.window.showInformationMessage(`Time tracking ${!isEnabled ? 'enabled' : 'disabled'}`);
    });

    const toggleBranchAutomationCommand = vscode.commands.registerCommand('commands-manager-next.time.toggleBranchAutomation', async () => {
        const isEnabled = timeTrackerManager.isAutoCreateOnBranchCheckoutEnabled();
        await timeTrackerManager.setAutoCreateOnBranchCheckout(!isEnabled);
        timeTrackerProvider.refresh();
        vscode.window.showInformationMessage(`Branch automation ${!isEnabled ? 'enabled' : 'disabled'}`);
    });

    const focusViewCommand = vscode.commands.registerCommand('commands-manager-next.time.focusView', () => {
        timeTrackerTreeView.reveal(timeTrackerTreeView.selection[0] || null, { focus: true, select: false });
    });

    context.subscriptions.push(
        toggleBranchAutomationCommand,
        startTimerCommand,
        stopTimerCommand,
        stopAllTimersCommand,
        editTimerCommand,
        deleteTimerCommand,
        archiveTimerCommand,
        resumeTimerCommand,
        moveTimerUpCommand,
        moveTimerDownCommand,
        moveTimerToFolderCommand,
        newFolderCommand,
        createSubTimerCommand,
        startSubTimerCommand,
        stopSubTimerCommand,
        editSubTimerCommand,
        deleteSubTimerCommand,
        refreshTimeTrackerCommand
    );

    context.subscriptions.push(
        openDocumentation,
        copyDocumentationPath,
        extractDocumentationCommands,
        searchDocumentation,
        toggleDocumentationViewMode,
        refreshDocumentation,
        openDocumentationSection,
        hideDocumentationItem,
        unhideDocumentationItem,
        unhideAllDocumentation
    );
}

export async function deactivate() {
    try {
        // Pause all running timers and subtimers before shutdown
        const timeTrackerManager = TimeTrackerManager.getInstance();
        await timeTrackerManager.pauseAllTimersOnShutdown();
    } catch (error) {
        // Silently fail - extension is shutting down
        console.error('Error pausing timers on shutdown:', error);
    }

    // Clean up resources
    try {
        const configManager = ConfigManager.getInstance();
        configManager.dispose();
    } catch (error) {
        // Silently fail - extension is shutting down
        console.error('Error disposing config manager:', error);
    }
}
