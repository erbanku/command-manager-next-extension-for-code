# Tasks, Tests & Doc Hub

<div align="center">

[![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/LeonardoSouza.command-manager?label=VS%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=LeonardoSouza.command-manager)
[![Open VSX Registry](https://img.shields.io/open-vsx/v/LeonardoSouza/command-manager?label=Open%20VSX&logo=open-vsx)](https://open-vsx.org/extension/LeonardoSouza/command-manager)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/LeonardoSouza.command-manager?label=Installs&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=LeonardoSouza.command-manager)
[![Build Status](https://img.shields.io/github/actions/workflow/status/Leonardo8133/Leos-Shared-Commands/ci.yml?label=Build&logo=github)](https://github.com/Leonardo8133/Leos-Shared-Commands/actions)

</div>

A productivity-focused VS Code extension that centralizes reusable commands, project documentation, automated test execution, and time tracking into a single activity bar container. Streamline your workflow by managing tasks, browsing docs, running tests, and tracking your time all in one place.

---

# Managing Tasks
<div align="center">
  <img src="https://raw.githubusercontent.com/Leonardo8133/Leos-Shared-Commands/master/resources/Tasks.gif" alt="Tasks, Tests & Doc Hub Demo" width="800">
</div>

# Running Tests

<div align="center">
  <img src="https://raw.githubusercontent.com/Leonardo8133/Leos-Shared-Commands/master/resources/Tests.gif" alt="Tasks, Tests & Doc Hub Demo" width="800">
</div>

# Browsing Documentation

<div align="center">
  <img src="https://raw.githubusercontent.com/Leonardo8133/Leos-Shared-Commands/master/resources/Readme.gif" alt="Tasks, Tests & Doc Hub Demo" width="800">
</div>

# Time Tracking

<div align="center">
  <img src="https://raw.githubusercontent.com/Leonardo8133/Leos-Shared-Commands/master/resources/TimeTracker.gif" alt="Time Tracker Demo" width="800">
</div>

# Pinning Commands to the Status Bar

<div align="center">
  <img src="https://raw.githubusercontent.com/Leonardo8133/Leos-Shared-Commands/master/resources/StatusBar.gif" alt="Tasks, Tests & Doc Hub Demo" width="800">
</div>

---

## ✨ Features

### 📋 Command Management

Organize and execute reusable commands with a powerful task management system.
- **Rich Editor** - Configure commands with icons, descriptions, and terminal preferences
- **Organized Folders** - Group related automation scripts into folders and subfolders for better organization
- **Variable Support** - Use variables including shared lists and global presets for dynamic command execution
- **Status Bar Pinning** - Pin frequently used commands to the status bar for instant access

### 🧪 Test Runner

Discover and execute tests with configurable test suites and intelligent pattern matching.
- **Choose the run Command** - Choose the command to run the tests
- **Configurable Suites** - Multiple test runner configurations with file/test patterns, ignore lists, terminal name, and working directory

- **Pattern-Based Discovery** - Real-time preview widget showing matching files as you type patterns
- **Path Pattern Support** - Use `/` in file patterns to match specific directories (e.g., `tests/test_*`)
- **Parallel Execution** - Run All executes up to 6 tests concurrently for faster test runs
- **Auto Find Control** - When OFF, tests only discovered on manual "Find Tests" click
- **Code Lenses** - Green run button appears next to each matched test inside the editor
- **Search Tests** - Search bar to filter tests by name, folder, file, or test case

### 📚 Documentation Hub

Browse and navigate your project documentation with ease.

- **Markdown Explorer** - View documentation in tree or flat list mode
- **Search Functionality** - Search by file name, section title, or content to quickly find what you need
- **Deep Linking** - Jump directly to specific sections within markdown files
- **Hide/Unhide Controls** - Hide folders or files you don't need - state persists across reloads
- **Folder Structure** - Navigate your documentation structure naturally

### ⏱️ Time Tracker

Track time spent on tasks, branches, and projects with automatic Git integration.

- **Manual Timers** - Create timers with custom labels and organize them into folders
- **Sessions (Subtimers)** - Each timer supports multiple sessions with pause/resume functionality
- **Pause/Resume Support** - Accurate elapsed time calculation that excludes pause periods
- **Git Branch Integration** - Automatically creates timers when checking out Git branches
- **Commit Tracking** - Sessions are automatically renamed with commit messages
- **Special Folders** - "Archived" folder for archived timers, "Git Branches" folder for branch timers
- **Activity Logs** - Each timer maintains a log of all actions (start, pause, resume, edits, branch changes, commits)
- **Status Bar Integration** - Shows the first running timer in the status bar with elapsed time
- **Auto-expand Running Timers** - Running timers are automatically expanded in the tree view
- **Enable/Disable Controls** - Global toggle to enable/disable time tracking, branch automation toggle
- **Persistence** - Timers are paused on VS Code close and can be resumed on startup

---

## 📦 Installation

### From VS Code Marketplace

1. Open VS Code or Cursor
2. Go to Extensions (`Ctrl+Shift+X` or `Cmd+Shift+X`)
3. Search for **"Tasks, Tests & Doc Hub"** or **"LeonardoSouza.command-manager"**
4. Click **Install**

### From Open VSX Registry

1. Open your VS Code-compatible editor (Cursor, VSCodium, etc.)
2. Go to Extensions
3. Search for **"Tasks, Tests & Doc Hub"**
4. Click **Install**

## 🚀 Quick Start

### 1. Manage Tasks

Create and organize reusable commands:

1. Open the **Task and Documentation Hub** container in the activity bar
2. Click the **+** icon or use the context menu to create a new folder or command
3. Configure your command:
   - **Command Text**: The shell command to execute
   - **Variables**: Use `{{variableName}}` syntax for dynamic values
   - **Icon**: Choose from a wide selection of icons
   - **Description**: Add helpful descriptions
   - **Terminal**: Select integrated, CMD, or PowerShell
4. Run commands directly from the tree view or use `Ctrl+Shift+C` for quick access

### 2. Configure Test Runners

Set up and run tests with intelligent discovery:

1. Open the **Test Runner** tree
2. Click the **+** icon to create a new test runner configuration
3. Configure your test runner:
   - **Title**: Display name for your configuration
   - **File Type**: JavaScript, TypeScript, or Python
   - **File Name Pattern**: Pattern to match test files (e.g., `**/*.test.js`, `tests/test_*`)
     - Use path patterns like `tests/test_*` to match specific directories
     - Patterns are extension-agnostic (automatically ignore extensions)
     - Real-time preview widget shows matching files as you type
   - **Test Name Pattern**: Regex pattern to match test names (e.g., `(it|test|describe)\(`)
   - **Run Test Command**: Command to execute tests (use `$test_name`, `$test_file`, `$executable_test_path` placeholders)
     - Use `$executable_test_path:trimparent=1` to remove parent segments (e.g., remove `src.` prefix)
   - **Ignore List**: Patterns to exclude tests, files, or folders (supports wildcards, matches folder paths)
   - **Auto Find**: Toggle automatic test discovery on extension load
4. Save the configuration (stored in `.vscode/commands.json`)
5. Click **Find Tests** to discover tests (or wait for auto-discovery if enabled)
6. Run tests:
   - **Run All**: Execute all tests with confirmation dialog
   - **Run Folder/File/TestCase**: Run specific groups of tests
   - **Run Test**: Execute individual tests

**Example Test Runner Configurations:**

**Jest (JavaScript/TypeScript):**
- File Pattern: `**/*.test.{js,ts}`
- Test Pattern: `(it|test|describe)\(`
- Command: `npm test -- $test`

**Pytest (Python):**
- File Pattern: `tests/test_*.py`
- Test Pattern: `def test_`
- Command: `pytest -k "$test"`

**Mocha:**
- File Pattern: `**/*.spec.js`
- Test Pattern: `(it|describe)\(`
- Command: `npm run test -- --grep "$test"`

### 3. Search Tests

Use the search bar to quickly find tests:

1. Click the **Search tests...** item at the top of the Test Runner tree
2. Type your search query
3. Results filter by:
   - Configuration name
   - Folder name
   - File name
   - Test case name
   - Test name
4. Clear the search to show all tests again

---

### 4. Browse Documentation

Navigate your project documentation:

1. Switch to the **Documentation Hub** tree within the same container
2. Browse markdown files organized by folder structure
3. Use the search bar to filter files and sections
4. Click on files or sections to jump directly to them
5. Hide folders/files you don't need - they'll stay hidden across reloads
6. Toggle between tree and flat view modes

**Features:**
- Search by filename, section title, or content
- Extract commands from README code blocks
- Deep link to specific sections
- Persistent hide/unhide state

### 5. Track Time

Manage time tracking with manual and automatic timers:

1. Open the **Time Tracker** tree within the same container
2. **Manual Timers**:
   - Click the **+** icon or use context menu to create a new timer
   - Timers automatically start with "Session 1"
   - Create additional sessions (subtimers) as needed
   - Pause/resume sessions - elapsed time excludes pause periods
3. **Git Branch Timers** (automatic):
   - Enable branch automation in the "Git Branches" folder
   - Timers are automatically created when checking out new branches
   - New sessions are created when switching branches
   - Sessions are renamed with commit messages on commits
4. **Organize Timers**:
   - Create folders to organize timers
   - Move timers between folders
   - Archive timers (moved to "Archived" folder)
5. **Edit Timers**:
   - Double-click a timer to open the edit page
   - Edit timer label, archived status
   - Manage subtimers (reorder, edit, delete, create new)
   - View logs of all timer actions
   - View subtimer intervals and elapsed times

**Features:**
- **Pause/Resume**: Accurate elapsed time tracking that excludes pause periods
- **Session Management**: Multiple sessions per timer, only one session running at a time
- **Branch Automation**: Automatic timer creation and session management for Git branches
- **Activity Logs**: Complete history of all timer actions
- **Status Bar**: First running timer shown in status bar with elapsed time
- **Auto-expand**: Running timers automatically expanded in tree view
- **Persistence**: Timers paused on VS Code close, can be resumed on startup


## ⚙️ Configuration

### Global Variables & Shared Lists

Manage shared variables and lists that commands can reference:

1. Open the configuration webview (gear icon in Tasks tree)
2. Navigate to **Global Variables** or **Shared Lists**
3. Create variables with:
   - **Fixed values**: Static text values
   - **Options**: Dropdown lists with predefined choices
   - **File picker**: Browse and select files
4. Use variables in commands with `{{variableName}}` syntax

### Documentation Hub Settings

Customize your documentation browsing experience:

- **View Mode**: Switch between tree and flat list view
- **Position**: Display documentation above or below the command list

### Time Tracker Settings

Time tracker configuration is stored in `.vscode/commands.json`:

```json
{
  "timeTracker": {
    "folders": [
      {
        "name": "My Folder",
        "timers": [
          {
            "id": "unique-id",
            "label": "My Timer",
            "startTime": "2024-01-01T00:00:00.000Z",
            "archived": false,
            "subtimers": [
              {
                "id": "subtimer-id",
                "label": "Session 1:",
                "startTime": "2024-01-01T00:00:00.000Z",
                "endTime": "2024-01-01T01:00:00.000Z",
                "totalElapsedTime": 3600000,
                "lastResumeTime": "2024-01-01T00:00:00.000Z"
              }
            ],
            "logs": [
              "1:00:00 PM - Timer created",
              "1:00:00 PM - VS Code opened and started",
              "1:00:00 PM - [Session 1:] - Started"
            ]
          }
        ],
        "subfolders": []
      }
    ],
    "ignoredBranches": [],
    "autoCreateOnBranchCheckout": true,
    "enabled": true
  }
}
```

**Key Features:**
- **Timer Structure**: Each timer contains multiple subtimers (sessions)
- **Elapsed Time**: `totalElapsedTime` tracks running time excluding pauses
- **Pause/Resume**: `lastResumeTime` tracks when timer was last resumed
- **Logs**: Each timer maintains a log of all actions
- **Branch Timers**: Timers with `branchName` are shown in "Git Branches" folder
- **Auto-save**: Timer state saved every 30 seconds

**Git Integration:**
- **New Branch**: Creates timer "Branch: {name}", starts "Session 1"
- **Branch Switch**: Pauses other branch timers, creates new session
- **Commit**: Renames active session with commit message, creates new session
- **Branch Logging**: Logs branch switches in both source and destination timers

### Test Runner Settings

All test runner configurations are stored in `.vscode/commands.json`:

```json
{
  "testRunners": [
    {
      "id": "unique-id",
      "activated": true,
      "title": "My Test Suite",
      "fileType": "javascript",
      "fileNamePattern": "**/*.test.js",
      "testNamePattern": "(it|test|describe)\\(",
      "runTestCommand": "npm test -- $test",
      "workingDirectory": "./",
      "terminalName": "Test Terminal",
      "ignoreList": "**/node_modules/**",
      "autoFind": true
    }
  ]
}
```

**Pattern Features:**
- **Path patterns**: Use `/` to match files in specific directories (e.g., `tests/test_*`)
- **Extension-agnostic**: Patterns ignore file extensions (e.g., `test_*` matches `.py`, `.js`, `.ts`)
- **Parent directory matching**: `tests*/*` matches any folder starting with `tests`
- **Real-time preview**: Widget shows matching file count and first 10 files

**Execution Features:**
- **Parallel execution**: Run All executes up to 6 tests concurrently
- **Optimized batch execution**: Run Folder/File/TestCase uses resolvers for single-command execution
- **Single terminal**: Run All uses shared terminal panel
- **Confirmation dialog**: Shows test count breakdown before execution

**Status Icons:**
- Parent items (folders/files/testcases) show pass icon if **all** child tests have run and passed
- Parent items show error icon if any child test failed
- Test counts displayed as "X tests found" format

---

## ⚙️ Configuration Settings

### Command Storage Location

Control where your commands are saved:

```json
{
  "commandManager.storageLocation": "workspace", // or "global" or "both"
  "commandManager.preferGlobalCommands": false,
  "commandManager.autoCreateCommandsDirectory": true,
  "commandManager.addCommandsToGitignore": false
}
```

**Storage Location Options:**
- `workspace` (default): Saves commands to `.vscode/commands/` in the current workspace
- `global`: Saves commands to `~/.vscode/commands/` globally (shared across all projects)
- `both`: Uses both workspace and global commands (merged view)

**Prefer Global Commands:**
When `storageLocation` is set to `both`, enabling this option makes global commands appear as defaults instead of built-in samples.

**Auto-Create Commands Directory:**
- When enabled (default): The commands directory is created automatically when opening a workspace
- When disabled: The directory is only created when you explicitly create a command

**Add Commands to .gitignore:**
When enabled, automatically adds `.vscode/commands/` to your `.gitignore` file if the workspace is a Git repository. This helps keep local commands private and out of version control.

### Documentation Hub

```json
{
  "commandManager.documentationHub.viewMode": "tree", // or "flat"
  "commandManager.documentationHub.position": "bottom" // or "top"
}
```

---

## 📋 Usage Examples

### Command Variables

```bash
# Input variable
git commit -m "{{input:commitMessage}}"

# Options variable
npm run {{select:buildType}}  # Options: dev, prod, staging

# File picker variable
python {{file:scriptPath}}

# Shared list variable
docker build -t {{list:imageTags}}
```

### Test Runner Patterns

```bash
# Match all test files
**/*.test.js

# Match tests in specific folder
tests/test_*.py

# Match any folder starting with "test"
test*/*.spec.js

# Match files in nested structure
**/integration/**/*.test.js
```

### Test Execution Placeholders

```bash
# Run specific test
npm test -- $test

# Run all tests in file
pytest $test_file

# Run with executable path
python $executable_test_path
```
---

## 🔧 Development

### Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- VS Code

### Setup

```bash
# Clone the repository
git clone https://github.com/Leonardo8133/Leos-Shared-Commands.git
cd Leos-Shared-Commands

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Run tests
npm test
```

### Debugging

1. Open the project in VS Code
2. Press `F5` to launch Extension Development Host
3. Use the debug console for logs
4. Set breakpoints in TypeScript files

---

## 📝 Changelog

See [CHANGELOG.md](./CHANGELOG.md) for detailed version history and updates.

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

---

## 👤 Author

**Leonardo de Souza Chaves**

- Email: leonardo2sc@gmail.com
- GitHub: [@Leonardo8133](https://github.com/Leonardo8133)

---

## 🙏 Acknowledgments

- VS Code Extension API
- Eclipse Open VSX Registry
- All contributors and users

---

<div align="center">

**⭐ If you find this extension helpful, please consider giving it a star on GitHub!**

[⬆ Back to Top](#tasks-tests--doc-hub)

</div>
