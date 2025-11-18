const assert = require('assert');
const path = require('path');

const { convertTasksJsonContent } = require('../../apps/tasks/import/tasksJsonImporter');

suite('VS Code tasks.json importer', () => {
  test('converts shell task with arguments into read-only command', () => {
    const content = `{
      "version": "2.0.0",
      "tasks": [
        {
          "label": "Build",
          "type": "shell",
          "command": "npm run build",
          "args": ["--", "--prod"],
          "options": {
            "cwd": "apps/client"
          }
        }
      ]
    }`;

    const commands = convertTasksJsonContent(content, '/workspace');
    assert.strictEqual(commands.length, 1, 'one task should be converted');

    const command = commands[0];
    assert.strictEqual(command.label, 'Build');
    assert.strictEqual(command.command, 'npm run build -- --prod');
    assert.ok(command.terminal, 'terminal config should be defined');
    assert.strictEqual(command.terminal.type, 'vscode-new');
    assert.strictEqual(command.terminal.name, 'VS Code Task: Build');
    assert.strictEqual(command.terminal.cwd, path.join('/workspace', 'apps/client'));
    assert.strictEqual(command.readOnly, true, 'command should be marked as read-only');
    assert.strictEqual(command.source, 'vscode-task');
  });

  test('converts npm task script when command is not provided', () => {
    const content = `{
      "tasks": [
        {
          "label": "Test Suite",
          "type": "npm",
          "script": "test",
          "args": ["--", "--watch"]
        }
      ]
    }`;

    const commands = convertTasksJsonContent(content, undefined);
    assert.strictEqual(commands.length, 1, 'npm task should be converted');

    const command = commands[0];
    assert.strictEqual(command.label, 'Test Suite');
    assert.strictEqual(command.command, 'npm run test -- --watch');
    assert.strictEqual(command.terminal.type, 'vscode-new');
    assert.strictEqual(command.readOnly, true);
  });

  test('ignores tasks without command information', () => {
    const content = `{
      "tasks": [
        {
          "label": "No Command",
          "type": "shell"
        }
      ]
    }`;

    const commands = convertTasksJsonContent(content, undefined);
    assert.strictEqual(commands.length, 0, 'tasks without command or script should be ignored');
  });
});
