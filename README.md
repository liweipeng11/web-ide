# Mini AI Web Editor

Mini AI Web Editor is a local web-based AI code editor. The browser UI talks to a local Node.js server, and the server is the only part allowed to read and write files inside the configured workspace.

## Features

- Browse a single configured local workspace.
- Switch the current project folder from the web UI by clicking Open and choosing a local folder.
- Open a file in Monaco Editor.
- Ask AI to modify the current file only.
- Chat with AI about the current file with persisted file-scoped conversation history.
- Preview a line diff before writing anything.
- Apply or reject the pending patch.
- Protect file writes by checking the file has not changed since the patch was generated.

## Setup

```bash
pnpm install
cp .env.example .env
```

Edit `.env` and set:

```env
AI_API_KEY=your_api_key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4.1-mini
SERVER_PORT=3001
```

The app starts without a project folder the first time. On Windows, clicking Open asks the local Node server to show a native folder picker, then switches the workspace to the selected directory. The selected folder is saved locally and restored the next time the app starts. If there is no saved folder, the file tree and editor stay blank.

The server only reads and writes files below the currently opened project folder.

## Run

```bash
pnpm dev
```

- Web: http://localhost:5173
- Server: http://localhost:3001

Vite proxies `/api` requests to the local server.

## First Version Scope

This version intentionally does not include terminal execution, Git operations, LSP, Tree-sitter, vector search, MCP, cloud deployment, login, multiple workspaces, or multi-file edits.

The only write path is:

1. Generate an AI edit for the currently selected file.
2. Show a diff preview.
3. Apply only after the user clicks Apply.
4. Before writing, confirm the current file still matches the original content.
