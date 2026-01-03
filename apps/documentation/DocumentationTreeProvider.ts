import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigManager } from '../../src/config/ConfigManager';
import { Command } from '../../src/types';
import { DocumentationFileMetadata, DocumentationSection, DocumentationTreeItem } from './DocumentationTreeItem';

interface MarkdownFileEntry {
  uri: vscode.Uri;
  relativePath: string;
  sections: DocumentationSection[];
  lowerContent: string;
}

type ViewMode = 'tree' | 'flat';

export class DocumentationTreeProvider implements vscode.TreeDataProvider<DocumentationTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<DocumentationTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private markdownFiles: MarkdownFileEntry[] = [];
  private searchQuery = '';
  private viewMode: ViewMode = 'tree';
  private watcher?: vscode.FileSystemWatcher;
  private hiddenItems: Set<string> = new Set();
  private readonly storageKey = 'documentationHub.hiddenItems';

  constructor(private readonly configManager: ConfigManager, private readonly storage: vscode.Memento) {
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    this.viewMode = this.getConfiguredViewMode();
    this.hiddenItems = new Set(this.storage.get<string[]>(this.storageKey, []));
    await this.refreshMarkdownFiles();
    this.setupFileWatcher();

    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('commands-manager-next.documentationHub.viewMode')) {
        this.viewMode = this.getConfiguredViewMode();
        this.refresh();
      }
    });

    this.refresh();
  }

  private getConfiguredViewMode(): ViewMode {
    const configuration = vscode.workspace.getConfiguration('commands-manager-next.documentationHub');
    const value = configuration.get<'tree' | 'flat'>('viewMode', 'tree');
    return value;
  }

  private async refreshMarkdownFiles(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
      this.markdownFiles = [];
      return;
    }

    const files = await vscode.workspace.findFiles('**/*.md', '**/{node_modules,.git}/**');
    const fileEntries: MarkdownFileEntry[] = [];

    for (const file of files) {
      const relativePath = vscode.workspace.asRelativePath(file);
      const { sections, content } = await this.getSectionsForFile(file);
      fileEntries.push({ uri: file, relativePath, sections, lowerContent: content.toLowerCase() });
    }

    this.markdownFiles = fileEntries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  private setupFileWatcher(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*.md');
    const handler = async () => {
      await this.refreshMarkdownFiles();
      this.refresh();
    };

    this.watcher.onDidCreate(handler);
    this.watcher.onDidChange(handler);
    this.watcher.onDidDelete(handler);
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  public async reload(): Promise<void> {
    await this.refreshMarkdownFiles();
    this.refresh();
  }

  public async getTreeItem(element: DocumentationTreeItem): Promise<vscode.TreeItem> {
    return element;
  }

  public async getChildren(element?: DocumentationTreeItem): Promise<DocumentationTreeItem[]> {
    if (!element) {
      const items: DocumentationTreeItem[] = [];
      items.push(this.createSearchItem());

      const fileEntries = this.getFilteredMarkdownFiles();
      if (this.viewMode === 'flat') {
        const fileItems = fileEntries.map(entry => this.createFileItem(entry));
        items.push(...fileItems.filter(item => !this.isHidden(item)));
      } else {
        const tree = this.buildFolderTree(fileEntries);
        items.push(...tree.filter(item => !this.isHidden(item)));
      }

      if (items.length === 1) {
        return [items[0], this.createEmptyStateItem()];
      }

      return items;
    }

    if (element.type === 'folder') {
      const children = element.children ?? [];
      return children.filter(child => !this.isHidden(child));
    }

    return [];
  }

  private createEmptyStateItem(): DocumentationTreeItem {
    const item = new DocumentationTreeItem('search', 'No markdown files found', vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('book');
    item.description = '';
    item.command = undefined;
    item.contextValue = 'documentationEmpty';
    return item;
  }

  private createSearchItem(): DocumentationTreeItem {
    const label = this.searchQuery ? `Search: ${this.searchQuery}` : 'Search documentation...';
    const item = new DocumentationTreeItem('search', label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('search');
    item.command = {
      command: 'documentationHub.search',
      title: 'Search Documentation'
    };
    return item;
  }

  private createFileItem(entry: MarkdownFileEntry): DocumentationTreeItem {
    const metadata: DocumentationFileMetadata = {
      uri: entry.uri,
      relativePath: entry.relativePath,
      sections: entry.sections
    };
    const label = path.basename(entry.relativePath);
    const item = new DocumentationTreeItem('file', label, vscode.TreeItemCollapsibleState.None, metadata);
    item.description = path.dirname(entry.relativePath) === '.' ? '' : path.dirname(entry.relativePath);
    return item;
  }

  private buildFolderTree(entries: MarkdownFileEntry[]): DocumentationTreeItem[] {
    interface FolderNode {
      name: string;
      children: Map<string, FolderNode>;
      files: MarkdownFileEntry[];
      path: string;
    }

    const root: FolderNode = {
      name: '',
      children: new Map(),
      files: [],
      path: ''
    };

    for (const entry of entries) {
      const segments = entry.relativePath.split('/');
      const fileName = segments.pop();
      if (!fileName) {
        continue;
      }

      let current = root;
      let currentPath = '';
      for (const segment of segments) {
        currentPath = currentPath ? `${currentPath}/${segment}` : segment;
        if (!current.children.has(segment)) {
          current.children.set(segment, {
            name: segment,
            children: new Map(),
            files: [],
            path: currentPath
          });
        }
        current = current.children.get(segment)!;
      }

      current.files.push(entry);
    }

    const buildItems = (node: FolderNode): DocumentationTreeItem[] => {
      const folderItems: DocumentationTreeItem[] = [];
      const sortedFolders = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));

      for (const folder of sortedFolders) {
        const children = [...buildItems(folder), ...folder.files.map(file => this.createFileItem(file))];
        const collapsibleState = this.searchQuery
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;

        const item = new DocumentationTreeItem(
          'folder',
          folder.name,
          collapsibleState,
          undefined,
          children,
          folder.path
        );
        item.iconPath = new vscode.ThemeIcon('folder');
        item.description = folder.path;
        
        // Only add folder if it's not hidden and has visible children
        const visibleChildren = children.filter(child => !this.isHidden(child));
        if (!this.isHidden(item) && visibleChildren.length > 0) {
          folderItems.push(item);
        }
      }

      return folderItems;
    };

    const rootItems = [...buildItems(root), ...root.files.map(file => this.createFileItem(file))];
    const visibleRootItems = rootItems.filter(item => !this.isHidden(item));
    
    if (!visibleRootItems.length) {
        const emptyItem = new DocumentationTreeItem('search', 'No documentation found', vscode.TreeItemCollapsibleState.None);
      emptyItem.iconPath = new vscode.ThemeIcon('book');
      emptyItem.command = undefined;
      return [emptyItem];
    }

    return visibleRootItems;
  }

  private getFilteredMarkdownFiles(): MarkdownFileEntry[] {
    if (!this.searchQuery) {
      return this.markdownFiles;
    }

    const query = this.searchQuery.toLowerCase();
    return this.markdownFiles.filter(entry => {
      if (entry.relativePath.toLowerCase().includes(query)) {
        return true;
      }

      if (entry.sections.some(section => section.label.toLowerCase().includes(query))) {
        return true;
      }

      if (entry.lowerContent.includes(query)) {
        return true;
      }

      return false;
    });
  }

  private async getSectionsForFile(uri: vscode.Uri): Promise<{ sections: DocumentationSection[]; content: string }>
  {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const sections: DocumentationSection[] = [];

      for (let line = 0; line < document.lineCount; line++) {
        const textLine = document.lineAt(line);
        const match = /^(#{1,6})\s+(.+)$/.exec(textLine.text);
        if (match) {
          sections.push({
            label: match[2].trim(),
            level: match[1].length,
            line
          });
        }
      }

      return { sections, content: document.getText() };
    } catch (error) {
      return { sections: [], content: '' };
    }
  }

  public async setSearchQuery(): Promise<void> {
    const input = await vscode.window.showInputBox({
      prompt: 'Search markdown documentation',
      placeHolder: 'Type to filter by file name or section title',
      value: this.searchQuery
    });

    if (typeof input === 'undefined') {
      return;
    }

    this.searchQuery = input.trim();
    this.refresh();
  }

  public toggleViewMode(): void {
    this.viewMode = this.viewMode === 'tree' ? 'flat' : 'tree';
    const configuration = vscode.workspace.getConfiguration('commands-manager-next.documentationHub');
    void configuration.update('viewMode', this.viewMode, vscode.ConfigurationTarget.Workspace);
    this.refresh();
  }

  public async openFile(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });

    const query = this.searchQuery.trim();
    if (!query) {
      return;
    }

    const text = document.getText();
    const matchIndex = text.toLowerCase().indexOf(query.toLowerCase());
    if (matchIndex === -1) {
      return;
    }

    const startPosition = document.positionAt(matchIndex);
    const endPosition = document.positionAt(matchIndex + query.length);
    const range = new vscode.Range(startPosition, endPosition);

    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

    await vscode.commands.executeCommand('actions.findWithSelection');
  }

  public async openSection(target: { path: string; line: number }): Promise<void> {
    const uri = vscode.Uri.file(target.path);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const position = new vscode.Position(target.line, 0);
    const range = new vscode.Range(position, position);
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
  }

  public async copyFilePath(uri: vscode.Uri): Promise<void> {
    await vscode.env.clipboard.writeText(uri.fsPath);
    vscode.window.showInformationMessage('Documentation path copied to clipboard');
  }

  public async extractCommandsFromReadme(uri: vscode.Uri): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      const commands = this.parseCommands(document);

      if (!commands.length) {
        vscode.window.showInformationMessage('No commands found in the selected documentation.');
        return;
      }

      const config = this.configManager.getConfig();
      const folderName = this.generateFolderName(uri, config.folders.map(folder => folder.name));

      config.folders.push({
        name: folderName,
        description: `Tasks extracted from ${path.basename(uri.fsPath)}`,
        commands: commands.map((command, index) => this.createCommandFromSnippet(command, folderName, index))
      });

      await this.configManager.saveConfig(config);
      vscode.window.showInformationMessage(`Created folder "${folderName}" with ${commands.length} commands.`);
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to extract commands: ${error}`);
    }
  }

  private parseCommands(document: vscode.TextDocument): string[] {
    const commands: string[] = [];
    const text = document.getText();
    const fenceRegex = /```(\w+)?\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = fenceRegex.exec(text))) {
      const language = (match[1] || '').toLowerCase();
      if (!language || ['bash', 'sh', 'shell', 'zsh', 'powershell', 'cmd', 'bat'].includes(language)) {
        const content = match[2]
          .split('\n')
          .map(line => line.replace(/^\$\s*/, '').trim())
          .filter(line => !!line)
          .join(' && ')
          .trim();
        if (content) {
          commands.push(content);
        }
      }
    }

    return commands;
  }

  private generateFolderName(uri: vscode.Uri, existingNames: string[]): string {
    const base = path.basename(uri.fsPath, path.extname(uri.fsPath));
    let name = `${this.toTitleCase(base)} Tasks`;
    let counter = 1;
    while (existingNames.includes(name)) {
      counter += 1;
      name = `${this.toTitleCase(base)} Tasks ${counter}`;
    }
    return name;
  }

  private toTitleCase(value: string): string {
    return value
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  private createCommandFromSnippet(snippet: string, folderName: string, index: number): Command {
    return {
      id: `${folderName.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${index}`,
      label: snippet.length > 40 ? `${snippet.slice(0, 37)}...` : snippet,
      command: snippet,
      description: `Extracted from ${folderName}`,
      terminal: {
        type: 'vscode-new',
        name: folderName
      }
    };
  }

  public hideItem(item: DocumentationTreeItem): void {
    const key = this.getItemKey(item);
    this.hiddenItems.add(key);
    void this.persistHiddenItems();
    this.refresh();
  }

  public unhideItem(item: DocumentationTreeItem): void {
    const key = this.getItemKey(item);
    this.hiddenItems.delete(key);
    void this.persistHiddenItems();
    this.refresh();
  }

  public unhideAll(): void {
    this.hiddenItems.clear();
    void this.persistHiddenItems();
    this.refresh();
  }

  public isHidden(item: DocumentationTreeItem): boolean {
    const key = this.getItemKey(item);
    return this.hiddenItems.has(key);
  }

  private getItemKey(item: DocumentationTreeItem): string {
    if (item.type === 'file' && item.metadata) {
      return `file:${item.metadata.relativePath}`;
    } else if (item.type === 'folder') {
      const identifier = item.folderPath || item.labelText;
      return `folder:${identifier}`;
    }
    return `search:${item.labelText}`;
  }

  private async persistHiddenItems(): Promise<void> {
    await this.storage.update(this.storageKey, Array.from(this.hiddenItems));
  }

  public dispose(): void {
    this._onDidChangeTreeData.dispose();
    this.watcher?.dispose();
  }
}
