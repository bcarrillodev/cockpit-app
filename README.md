# Cockpit

![Cockpit Screenshot](screenshots/screenshot1.avif)

Cockpit is a desktop app for working with GitHub Copilot CLI from a native GUI instead of the terminal. It wraps Copilot chat, project context, and basic git workflows in a macOS-first Electron app built with Vue 3 and TypeScript.

The app lets you add local repositories, create and reopen chat threads, send prompts to Copilot, review streamed responses, handle tool permission requests, and keep thread history saved between launches. It also shows repository status for the active project so you can review changed files and run a simple commit and push flow from the same interface.

## Features

- **Native Desktop Experience**: macOS-first Electron app with a clean, intuitive interface
- **Project Management**: Add and manage local Git repositories
- **Chat Threads**: Create, save, and reopen conversation threads with preserved context
- **Copilot Integration**: Full integration with GitHub Copilot CLI via ACP (Agent Client Protocol)
- **Model Selection**: Per-thread model selection with dynamic discovery from Copilot CLI
- **Git Workflow**: View repository status, review changed files, and commit/push from the app
- **Permission Management**: Approve or deny Copilot tool/trust requests from the GUI
- **Persistence**: All projects, threads, and settings saved between app launches

## Requirements

- **macOS** (primary platform)
- **Node.js** 22 LTS or later
- **GitHub Copilot CLI** installed and authenticated
- **Git** for repository management

## Installation

### Prerequisites

1. Install Node.js 22 LTS or later
2. Install GitHub Copilot CLI:
   ```bash
   # Install via npm
   npm install -g @githubnext/github-copilot-cli
   
   # Authenticate with GitHub
   copilot auth login
   ```

### Build from Source

1. Clone the repository:
   ```bash
   git clone https://github.com/bcarrillodev/cockpit-app.git
   cd cockpit-app
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Run in development mode:
   ```bash
   npm run dev
   ```

4. Build for production:
   ```bash
   npm run build
   ```

## Usage

1. **Launch Cockpit** - Start the app and it will detect your Copilot CLI installation
2. **Add Projects** - Click "Add Project" to select local Git repositories
3. **Create Threads** - Select a project and create a new chat thread
4. **Chat with Copilot** - Send prompts and receive streaming responses
5. **Manage Models** - Switch between available Copilot models per thread
6. **Git Operations** - Review changed files and commit/push directly from the app

## Development

### Tech Stack

- **Framework**: Electron with Vue 3 Composition API
- **Language**: TypeScript
- **Styling**: Tailwind CSS with PrimeVue components
- **State Management**: Pinia
- **Testing**: Vitest with Vue Test Utils
- **Build Tool**: electron-vite

### Project Structure

```
src/
├── main/           # Electron main process
├── preload/        # Preload scripts for IPC
├── renderer/       # Vue 3 frontend
└── shared/         # Shared types and utilities
```

### Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run test` - Run tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:ui` - Open Vitest UI
- `npm run typecheck` - Type check all code
- `npm run coverage` - Generate test coverage report

### Testing

The project includes comprehensive testing:

- **Unit Tests**: Store serialization, CLI health parsing, git operations
- **Service Tests**: ACP integration, streaming responses, permission handling
- **Component Tests**: UI components, user interactions
- **Manual QA**: Fresh install scenarios, auth flows, git workflows

## Configuration

Cockpit stores data in Electron's `userData` directory:
- Projects and threads as JSON
- Message history as append-only JSONL files
- Settings and preferences
- Git metadata and status

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please ensure:
- All tests pass (`npm run check`)
- Code follows the existing TypeScript and Vue patterns
- Commits are properly formatted
- Documentation is updated as needed

## Support

For issues and questions:
- Check the [GitHub Issues](https://github.com/bcarrillodev/cockpit-app/issues)
- Review the [development plan](PLAN.md) for technical details
- Ensure Copilot CLI is properly installed and authenticated
