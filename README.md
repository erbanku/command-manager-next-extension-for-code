# Commands Manager Next

> Manage tasks, run tests, browse docs, and track time in one VS Code sidebar.

<p align="center">
  <img src="resources/Tasks.gif" height="400" width="400"/>
  <img src="resources/Tests.gif" height="400" width="400"/>
</p>

---

## Features

**📋 Tasks** - Create reusable commands with variables, organize in folders, pin to status bar

**🧪 Test Runner** - Auto-discover tests, parallel execution (6 concurrent), pattern matching with preview

**📚 Docs Hub** - Browse markdown files, search content, extract commands from code blocks

**⏱️ Time Tracker** - Track sessions with pause/resume, Git branch automation, commit logging

---

## Installation

```bash
git clone <your-repo-url>
cd command-manager-next-extension-for-code
npm install
```

Press `F5` in VS Code to run in development mode, or package with `vsce package`

## Quick Start

### Tasks

1. Open sidebar → Click `+` to create command
2. Use `{{variableName}}` for dynamic values
3. Run with `Ctrl+Shift+C` or from tree view

### Test Runner

1. Click `+` to create test configuration
2. Set patterns: `**/*.test.js` or `tests/test_*`
3. Use placeholders: `$test`, `$test_file`, `$executable_test_path`
4. Click "Find Tests" or enable auto-discovery

**Example configs:**

```bash
# Jest
npm test -- $test

# Pytest
pytest -k "$test"

# Mocha
npm run test -- --grep "$test"
```

## Configuration

All settings stored in `.vscode/commands.json`

**Storage options:**

-   `workspace` - Local to project (default)
-   `global` - Shared across projects
-   `both` - Merged view

**Key settings:**

```json
{
    "commandManager.storageLocation": "workspace",
    "commandManager.autoCreateCommandsDirectory": true,
    "commandManager.addCommandsToGitignore": false,
    "commandManager.documentationHub.viewMode": "tree"
}
```

## Development

```bash
git clone <your-repo-url>
npm install && npm run compile
npm test  # Run tests
```

Press `F5` in VS Code to launch Extension Development Host

## License

MIT License - see [LICENSE](./LICENSE)

## Credits

Fork and Continue Development of [Leos-Shared-Commands](https://github.com/Leonardo8133/Leos-Shared-Commands) by **Leonardo de Souza Chaves** ([@Leonardo8133](https://github.com/Leonardo8133))

---

[⬆ Back to Top](#commands-manager-next)
