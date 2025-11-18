# Changelog

All notable changes to the Task and Documentation Hub extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.3] - 2025-01-13

### Fixed
- Fixed timer config file being cleared on PC restart - now only creates file if it doesn't exist, never overwrites on failure
- Improved backup restore messaging - shows clear message when using backup file
- Changed unexpected shutdown detection to check on resume instead of only on startup - detects VS Code closure when resuming subtimers

## [1.4.2] - 2025-01-XX

### Added
- Automatic import of VS Code tasks from `tasks.json` into Tasks panel
- Tasks from `tasks.json` appear in read-only "tasks.json" folder
- Convert imported tasks to editable tasks via context menu
- Support for pinning imported tasks to status bar

### Changed
- Tasks App now automatically imports and displays tasks from `.vscode/tasks.json`

## [1.4.1] - 2025-01-XX

### Added
- Drag-and-drop support for reorganising folders and commands directly inside the
  Task and Documentation Hub command tree view.
- Status bar enhancements with a hoverable command menu and support for pinning
  frequently used commands as dedicated status bar shortcuts.
- Dedicated **Test Runner** side panel with configuration webview, inline test actions,
  and automatic code lenses next to discovered tests.

### Changed
- The default status bar shortcut now displays the full command hierarchy on
  hover instead of opening a quick pick list.

### Deprecated
- Nothing yet

### Removed
- Manual "keep terminal open" and "clear before running" options from the command
  editors. Terminals now always stay open and output is preserved between runs.

### Fixed
- Improved command execution reliability for external Command Prompt and
  PowerShell sessions.
- Dedicated VS Code terminals no longer depend on optional terminal names to
  persist between runs and automatically generate unique names when collisions occur.

### Security
- Nothing yet

---

## [1.0.0] - 2024-01-XX

### Added

#### Core Command Management
- **Command Creation & Editing**
  - Rich command editor with webview interface
  - Support for command labels, descriptions, and icons
  - Custom terminal configuration per command
  - Command duplication functionality

- **Folder Organization**
  - Hierarchical folder structure for command organization
  - Support for nested subfolders
  - Folder-specific icons and descriptions
  - Drag-and-drop command organization

- **Command Execution**
  - Multiple terminal types:
    - VSCode integrated terminal (current/new)
    - External Command Prompt
    - External PowerShell
  - Custom working directory support
  - Terminal management (keep open, clear before run)
  - Progress tracking with visual feedback

#### Variable System
- **Global Variables**
  - Workspace-wide variable definitions
  - Persistent storage across sessions
  - Built-in variables: `${PROJECT_ROOT}`, `${CURRENT_FILE}`

- **Shared Variables**
  - Reusable variables across multiple commands
  - Support for different data types
  - Centralized variable management

- **Command Variables**
  - Command-specific variable definitions
  - Input types: fixed values, user input, option selection
  - Dynamic variable resolution during execution

#### Documentation Hub
- **Markdown Integration**
  - Automatic discovery of markdown files in workspace
  - Tree and flat view modes for documentation browsing
  - Real-time file watching for changes

- **Smart Navigation**
  - Section detection in markdown files
  - Clickable section links in tooltips
  - Direct navigation to specific lines in files

- **Command Extraction**
  - Extract commands from README code blocks
  - Automatic folder creation from documentation
  - Support for multiple shell languages

- **Hide/Unhide System** 🆕
  - Hide individual folders and README files
  - Context menu options for hide/unhide actions
  - "Unhide All" button in view toolbar
  - Smart filtering of empty folders after hiding

#### User Interface
- **Tree Views**
  - Commands, Documentation Hub, and Test Runner views inside the activity bar container
  - Collapsible folder structure
  - Context menus for all item types

- **Webview Interfaces**
  - Command editor with rich form controls
  - Folder editor for organization
  - Configuration manager for global settings
  - Real-time validation and error handling

- **Quick Actions**
  - Quick run command (`Ctrl+Shift+C`)
  - Status bar integration
  - Command palette integration

#### Import/Export
- **Configuration Management**
  - JSON-based configuration storage
  - Import/export command configurations
  - Version control friendly format
  - Backup and restore functionality

#### Advanced Features
- **Command Chaining**
  - Execute multiple commands in sequence
  - Support for conditional execution
  - Error handling in command chains

- **Search & Filtering**
  - Documentation search functionality
  - Command filtering by name and description
  - Real-time search results

- **Performance Optimizations**
  - Efficient tree rendering for large command sets
  - Lazy loading of documentation content
  - Memory management for long-running sessions

### Technical Implementation

#### Architecture
- **TypeScript-based**
  - Full type safety throughout the codebase
  - Modern ES6+ features
  - Comprehensive error handling

- **VS Code Extension API**
  - TreeDataProvider for custom views
  - Webview API for rich interfaces
  - Command registration and execution
  - File system watching

- **Configuration Management**
  - JSON schema validation
  - Workspace and user settings integration
  - Migration support for configuration updates

#### Testing
- **Unit Tests**
  - Command execution testing
  - Variable resolution testing
  - Configuration management testing

- **Integration Tests**
  - End-to-end command execution
  - Webview interaction testing
  - File system integration testing

- **UI Tests**
  - Playwright-based UI testing
  - WebDriver-based automation
  - Cross-platform compatibility testing

#### Performance
- **Memory Management**
  - Efficient data structures for large command sets
  - Proper disposal of resources
  - Garbage collection optimization

- **Execution Performance**
  - Asynchronous command execution
  - Non-blocking UI updates
  - Progress reporting for long-running commands

### Configuration

#### Settings
- **Documentation Hub**
  - `commandManager.documentationHub.viewMode`: Tree or flat view
  - `commandManager.documentationHub.position`: Above or below command list

#### File Structure
```
.vscode/
├── commands.json          # Command configurations
└── settings.json          # Extension settings
```

### Breaking Changes
- None (initial release)

### Migration Guide
- None (initial release)

---

## [0.1.0] - 2024-01-XX (Pre-release)

### Added
- Initial project setup
- Basic command execution framework
- TypeScript configuration
- Build and development scripts

---

## Release Notes

### Version 1.0.0
This is the initial stable release of Task and Documentation Hub (formerly Command Manager). The extension provides a comprehensive solution for managing and executing commands in VS Code with advanced features like variable substitution, command chaining, documentation integration, and a configurable test runner.

**Key Highlights:**
- Complete command management system
- Advanced variable system with multiple types
- Integrated documentation hub with hide/unhide functionality
- Multiple terminal support
- Rich webview interfaces
- Import/export capabilities

**System Requirements:**
- VS Code 1.85.0 or higher
- Node.js 16.0 or higher (for development)
- Windows, macOS, or Linux

**Known Issues:**
- None at this time

**Future Roadmap:**
- Command templates and snippets
- Team collaboration features
- Advanced terminal customization
- Plugin system for extensions
