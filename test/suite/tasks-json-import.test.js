const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');

async function activateExtension() {
  const extension = vscode.extensions.getExtension('your-name.command-manager');
  if (extension && !extension.isActive) {
    await extension.activate();
  }
}

function writeTasksFile(tasksPath, content) {
  fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
  fs.writeFileSync(tasksPath, content, 'utf8');
}

async function delay(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

suite('tasks.json import', () => {
  let tempWorkspaceRoot;
  let overrideConfigRoot;
  let previousOverrideRoot;
  let tasksPath;
  let CommandTreeProvider;
  let ConfigManager;
  let configManager;

  suiteSetup(async () => {
    tempWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-manager-tasks-'));
    overrideConfigRoot = path.join(tempWorkspaceRoot, '.vscode');
    fs.mkdirSync(overrideConfigRoot, { recursive: true });

    previousOverrideRoot = process.env.COMMAND_MANAGER_CONFIG_ROOT;
    process.env.COMMAND_MANAGER_CONFIG_ROOT = overrideConfigRoot;

    ({ CommandTreeProvider } = require('../../apps/tasks/treeView/CommandTreeProvider'));
    ({ ConfigManager } = require('../../src/config/ConfigManager'));

    ConfigManager.resetForTests();
    await activateExtension();
    configManager = ConfigManager.getInstance();
    await configManager.initialize();

    tasksPath = path.join(tempWorkspaceRoot, '.vscode', 'tasks.json');
  });

  setup(() => {
    if (fs.existsSync(tasksPath)) {
      fs.unlinkSync(tasksPath);
    }
  });

  teardown(() => {
    if (fs.existsSync(tasksPath)) {
      fs.unlinkSync(tasksPath);
    }
  });

  suiteTeardown(() => {
    ConfigManager.resetForTests();
    if (previousOverrideRoot) {
      process.env.COMMAND_MANAGER_CONFIG_ROOT = previousOverrideRoot;
    } else {
      delete process.env.COMMAND_MANAGER_CONFIG_ROOT;
    }
    if (tempWorkspaceRoot) {
      fs.rmSync(tempWorkspaceRoot, { recursive: true, force: true });
    }
    try {
      delete require.cache[require.resolve('../../apps/tasks/treeView/CommandTreeProvider')];
      delete require.cache[require.resolve('../../src/config/ConfigManager')];
    } catch (error) {
      // ignore cache cleanup errors
    }
  });

  test('imports VS Code tasks into read-only folder', async () => {
    const sampleContent = `// Sample tasks.json created by tests
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Echo Hello",
      "type": "shell",
      "command": "echo",
      "args": ["Hello from tasks"]
    },
    {
      "label": "Run npm test",
      "type": "npm",
      "script": "test",
      "args": ["--", "--watch=false"]
    }
  ]
}`;

    writeTasksFile(tasksPath, sampleContent);

    const treeProvider = new CommandTreeProvider();

    let importedCommands = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const allCommands = await treeProvider.getAllCommands();
      importedCommands = allCommands.filter(command => command.source === 'vscode-task');
      if (importedCommands.length === 2) {
        break;
      }
      await delay(50);
    }

    assert.strictEqual(importedCommands.length, 2, 'Expected two commands imported from tasks.json');

    const rootItems = await treeProvider.getChildren();
    const tasksFolder = rootItems.find(item => item.label === 'tasks.json');
    assert.ok(tasksFolder, 'tasks.json virtual folder should exist');
    assert.strictEqual(tasksFolder.contextValue, 'folder.imported', 'tasks.json folder should be read-only');

    const folderChildren = await treeProvider.getChildren(tasksFolder);
    assert.strictEqual(folderChildren.length, 2, 'tasks.json folder should list imported tasks');

    folderChildren.forEach(item => {
      assert.strictEqual(item.contextValue, 'command.imported', 'Imported task should be marked read-only');
      const command = item.getCommand();
      assert.ok(command, 'Tree item should expose command data');
      assert.strictEqual(command.readOnly, true, 'Imported task command should be read-only');
      assert.strictEqual(command.source, 'vscode-task', 'Imported task command should be tagged with vscode-task source');
    });

    treeProvider.dispose();
  });
});


