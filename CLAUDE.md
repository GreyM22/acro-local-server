# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An Electron desktop app that runs a local HTTP video server during acrobatics competitions. Phones POST video recordings to it; judges GET and stream them back — no cloud upload lag. Videos are kept until manually deleted.

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
- Tracks videos in an in-memory `Map` (`uploadedFiles`): `id` (the exerciseId, unique) → `{ name, uploadedAt, size }`. `name` is the readable filename on disk
- Stores videos in `~/Desktop/AcroVideos` under their readable name (`Name.mp4`, or `Name (2).mp4` if another id owns that name). `.metadata.json` in that folder persists id → name; `hydrateFromDisk()` rebuilds the Map from it at startup, and unknown video files get id = filename
- Upload: `POST /upload/:id` (or `POST /upload` with an `id` field), multipart `video` + optional `name`. Same id overwrites. Fetch with `GET /videos/:id`; `DELETE /videos/:id`; `GET /list`
- Exposes three IPC handlers to the renderer: `get-server-info`, `get-file-list`, `delete-file`
- Pushes real-time updates to the renderer via `mainWindow.webContents.send('file-list-updated', files)`

**Renderer (`index.html`)** — a self-contained HTML/CSS/JS file, no build step:
- Calls `window.api.*` (never Node.js directly — context isolation is on, nodeIntegration is off)
- Receives live file-list updates via `window.api.onFileListUpdated`
- Refreshes the countdown display every 30 seconds via polling

**Preload (`preload.js`)** — the only bridge between processes:
- Uses `contextBridge.exposeInMainWorld('api', ...)` to safely expose IPC calls to the renderer

## Key Constraints

- `SERVER_PORT` (3000) is a constant at the top of `main.js`
- Multer accepts only `video/mp4`, `video/quicktime`, `video/webm`, `video/x-msvideo` up to 500 MB
- The HTTP server returns absolute URLs using the machine's first non-loopback IPv4 address (`getLocalIP()`); if the organizer has multiple network interfaces, this may pick the wrong one
- Names are sanitized before touching disk; request params are never joined into paths (lookups go through the Map)
