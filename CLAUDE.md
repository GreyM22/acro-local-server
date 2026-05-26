# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An Electron desktop app that runs a local HTTP video server during acrobatics competitions. Phones POST video recordings to it; judges GET and stream them back — no cloud upload lag. Videos auto-delete after 10 minutes and are wiped on app exit.

## Commands

```bash
npm install       # install dependencies
npm start         # run in development (opens Electron window)

npm run build:mac   # package as macOS .dmg → dist/
npm run build:win   # package as Windows .nsis installer → dist/
npm run build:linux # package as Linux binary → dist/
```

There are no tests and no linter configured.

## Architecture

This is a two-process Electron app — the distinction matters when making changes:

**Main process (`main.js`)** — runs Node.js, owns all privileged resources (entry point declared in `package.json#main`):
- Starts an Express HTTP server on `0.0.0.0:3000` (network-wide) on app ready
- Tracks uploaded files in an in-memory `Map` (`uploadedFiles`) — not persisted to disk
- Stores video files in `app.getPath('userData')/videos` (OS-specific, survives restarts but the Map doesn't)
- Schedules auto-deletion with `setTimeout`; clears all timers and files on `window-all-closed`
- Exposes three IPC handlers to the renderer: `get-server-info`, `get-file-list`, `delete-file`
- Pushes real-time updates to the renderer via `mainWindow.webContents.send('file-list-updated', files)`

**Renderer (`index.html`)** — a self-contained HTML/CSS/JS file, no build step:
- Calls `window.api.*` (never Node.js directly — context isolation is on, nodeIntegration is off)
- Receives live file-list updates via `window.api.onFileListUpdated`
- Refreshes the countdown display every 30 seconds via polling

**Preload (`preload.js`)** — the only bridge between processes:
- Uses `contextBridge.exposeInMainWorld('api', ...)` to safely expose IPC calls to the renderer

## Key Constraints

- `SERVER_PORT` (3000) and `AUTO_DELETE_MS` (10 min) are constants at the top of `main.js`
- Multer accepts only `video/mp4`, `video/quicktime`, `video/webm`, `video/x-msvideo` up to 500 MB
- The HTTP server returns absolute URLs using the machine's first non-loopback IPv4 address (`getLocalIP()`); if the organizer has multiple network interfaces, this may pick the wrong one
- File state lives only in the `uploadedFiles` Map — restarting the app loses track of files already on disk (though the files themselves remain until deleted)