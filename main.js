const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

// ─── Config ────────────────────────────────────────────────
const SERVER_PORT = 3000;

// ─── Video storage directory ───────────────────────────────
const videosDir = path.join(app.getPath('desktop'), 'AcroVideos');
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir, { recursive: true });
}

// ─── Track uploaded files ──────────────────────────────────
// id (exerciseId) -> { name, uploadedAt, size }. `name` is the readable filename on disk.
const uploadedFiles = new Map();
let mainWindow = null;
const wsClients = new Set();

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi'];
const MIME_EXTENSIONS = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-msvideo': '.avi',
};

// ─── Metadata sidecar (id -> name, uploadedAt) ─────────────
const METADATA_FILE = path.join(videosDir, '.metadata.json');

function loadMetadata() {
  try {
    const data = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Ignoring unreadable metadata file:', err.message);
    return {};
  }
}

function saveMetadata() {
  const data = {};
  for (const [id, info] of uploadedFiles) {
    data[id] = { name: info.name, uploadedAt: info.uploadedAt };
  }
  try {
    const tmp = `${METADATA_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, METADATA_FILE);
  } catch (err) {
    console.error('Failed to save metadata:', err.message);
  }
}

// ─── Rehydrate file list from disk ─────────────────────────
function hydrateFromDisk() {
  try {
    const meta = loadMetadata();
    const referenced = new Set();
    let changed = false;

    for (const [id, entry] of Object.entries(meta)) {
      const name = entry && typeof entry.name === 'string' ? entry.name : null;
      if (!name || name !== path.basename(name)) { changed = true; continue; }
      try {
        const stat = fs.statSync(path.join(videosDir, name));
        if (!stat.isFile()) throw new Error('not a file');
        uploadedFiles.set(id, {
          name,
          uploadedAt: Number(entry.uploadedAt) || stat.mtimeMs,
          size: stat.size,
        });
        referenced.add(name.toLowerCase());
      } catch {
        changed = true; // file was removed while the app was off
      }
    }

    for (const filename of fs.readdirSync(videosDir)) {
      if (filename.startsWith('.upload-')) {
        try { fs.unlinkSync(path.join(videosDir, filename)); } catch {}
        continue;
      }
      if (filename.startsWith('.')) continue;
      if (!VIDEO_EXTENSIONS.includes(path.extname(filename).toLowerCase())) continue;
      if (referenced.has(filename.toLowerCase()) || uploadedFiles.has(filename)) continue;

      const stat = fs.statSync(path.join(videosDir, filename));
      if (!stat.isFile()) continue;

      // Legacy / renamed-while-off file: its filename doubles as its id
      uploadedFiles.set(filename, { name: filename, uploadedAt: stat.mtimeMs, size: stat.size });
      changed = true;
    }

    if (changed) saveMetadata();
    console.log(`Hydrated ${uploadedFiles.size} existing video(s) from disk`);
  } catch (err) {
    console.error('Failed to hydrate files from disk:', err.message);
  }
}

// ─── Filename helpers ──────────────────────────────────────
function sanitizeBaseName(value, ext) {
  let s = String(value ?? '');
  if (ext && s.toLowerCase().endsWith(ext)) s = s.slice(0, -ext.length);
  s = s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 100)
    .replace(/[.\s]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
  return s;
}

function isFilenameTaken(candidate, id) {
  const lower = candidate.toLowerCase();
  for (const [otherId, info] of uploadedFiles) {
    if (otherId !== id && info.name.toLowerCase() === lower) return true;
  }
  const own = uploadedFiles.get(id);
  if (own && own.name.toLowerCase() === lower) return false;
  return fs.existsSync(path.join(videosDir, candidate));
}

// Readable, filesystem-safe filename that no other id owns: "Name.mp4", "Name (2).mp4", ...
function uniqueFilename(id, name, ext) {
  const base = sanitizeBaseName(name, ext) || sanitizeBaseName(id, ext) || 'video';
  let candidate = `${base}${ext}`;
  for (let n = 2; isFilenameTaken(candidate, id); n++) {
    candidate = `${base} (${n})${ext}`;
  }
  return candidate;
}

function pickExtension(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext) ? ext : (MIME_EXTENSIONS[file.mimetype] || '.mp4');
}

// ─── Delete a video by id ──────────────────────────────────
function deleteById(id) {
  const info = uploadedFiles.get(id);
  if (!info) return false;
  const filePath = path.join(videosDir, info.name);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  uploadedFiles.delete(id);
  saveMetadata();
  sendFileList();
  return true;
}

// ─── Get local network IP ──────────────────────────────────
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal and non-IPv4 addresses
      if (!iface.internal && iface.family === 'IPv4') {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ─── Notify renderer of file list changes ──────────────────
function getFileList() {
  return Array.from(uploadedFiles.entries()).map(([id, info]) => ({
    id,
    name: info.name,
    uploadedAt: info.uploadedAt,
    size: info.size,
  }));
}

function sendFileList() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('file-list-updated', getFileList());
}

// ─── Notify renderer of WebSocket client count ─────────────
function sendWsClientCount() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('ws-client-count', wsClients.size);
}

// ─── Broadcast a signal to all WebSocket clients ───────────
function broadcastSignal(message) {
  const payload = JSON.stringify(message);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ─── Express server setup ──────────────────────────────────
function createServer() {
  const server = express();

  // Allow requests from any origin (Acro Companion app on any device)
  server.use(cors());
  server.use(express.json());

  // Multer saves to a temp name; the handler moves it to its readable name,
  // so the order of multipart fields (id, name, video) does not matter.
  const storage = multer.diskStorage({
    destination: videosDir,
    filename: (req, file, cb) => {
      cb(null, `.upload-${crypto.randomBytes(6).toString('hex')}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max
    fileFilter: (req, file, cb) => {
      const allowedTypes = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo'];
      if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error(`File type not allowed: ${file.mimetype}`));
      }
    },
  });

  const videoUrl = (id) => `http://${getLocalIP()}:${SERVER_PORT}/videos/${encodeURIComponent(id)}`;

  // ─── Routes ───────────────────────────────────────────────

  // Health check
  server.get('/health', (req, res) => {
    res.json({ status: 'ok', files: uploadedFiles.size });
  });

  // Upload a video. id comes from the path (/upload/:id) or the `id` form field;
  // `name` (form field) is the readable filename. Same id again overwrites.
  function handleUpload(req, res) {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }
    const tempPath = req.file.path;

    try {
      const explicitId = req.params.id || req.body.id;
      const id = String(explicitId || req.file.originalname).trim().slice(0, 200);
      if (!id) {
        fs.unlinkSync(tempPath);
        return res.status(400).json({ error: 'id must be a non-empty string' });
      }

      const requestedName = typeof req.body.name === 'string' && req.body.name.trim()
        ? req.body.name
        : (explicitId ? id : req.file.originalname);
      const name = uniqueFilename(id, requestedName, pickExtension(req.file));

      const existing = uploadedFiles.get(id);
      fs.renameSync(tempPath, path.join(videosDir, name));
      if (existing && existing.name.toLowerCase() !== name.toLowerCase()) {
        try { fs.unlinkSync(path.join(videosDir, existing.name)); } catch {}
      }

      uploadedFiles.set(id, { name, uploadedAt: Date.now(), size: req.file.size });
      saveMetadata();
      sendFileList();

      const url = videoUrl(id);
      console.log(`Uploaded ${id}: ${name} → ${url}`);

      // `filename` / `exerciseId` kept for older clients
      res.json({ id, name, url, filename: name, exerciseId: id });
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch {}
      console.error('Upload failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  }

  server.post('/upload', upload.single('video'), handleUpload);
  server.post('/upload/:id', upload.single('video'), handleUpload);

  // Serve a video by id (Range/streaming supported); falls through to static for legacy filenames
  server.get('/videos/:id', (req, res, next) => {
    // Accept "/videos/<id>" and "/videos/<id>.mp4" (players/clients often append an extension)
    let info = uploadedFiles.get(req.params.id);
    if (!info) {
      const ext = path.extname(req.params.id).toLowerCase();
      if (VIDEO_EXTENSIONS.includes(ext)) info = uploadedFiles.get(req.params.id.slice(0, -ext.length));
    }
    if (!info) return next();
    res.sendFile(path.join(videosDir, info.name), (err) => {
      if (err && !res.headersSent) next(err);
    });
  });
  server.use('/videos', express.static(videosDir));

  // List all available videos
  server.get('/list', (req, res) => {
    res.json(getFileList().map((file) => ({
      ...file,
      url: videoUrl(file.id),
      filename: file.name,
      exerciseId: file.id,
    })));
  });

  // Delete a specific video manually
  server.delete('/videos/:id', (req, res) => {
    if (!deleteById(req.params.id)) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.json({ deleted: req.params.id });
  });

  // Send a native OS notification
  server.post('/notify', (req, res) => {
    const title = req.body?.title || 'Acro Local Server';
    const body = req.body?.body || '';

    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }

    res.json({ sent: true, title, body });
  });

  // Error handling
  server.use((err, req, res, next) => {
    console.error('Server error:', err.message);
    res.status(500).json({ error: err.message });
  });

  return server;
}

// ─── Electron window ────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 550,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

// ─── IPC handlers ───────────────────────────────────────────
ipcMain.handle('get-server-info', () => {
  return {
    ip: getLocalIP(),
    port: SERVER_PORT,
    videosDir,
    version: app.getVersion(),
  };
});

ipcMain.handle('get-file-list', () => getFileList());

ipcMain.handle('delete-file', (event, id) => {
  return deleteById(id) ? { deleted: id } : { error: 'File not found' };
});

// ─── App lifecycle ──────────────────────────────────────────
app.whenReady().then(() => {
  console.log(`Acro Local Server v${app.getVersion()} — videos dir: ${videosDir}`);
  hydrateFromDisk();

  const expressApp = createServer();
  const httpServer = http.createServer(expressApp);

  // ─── WebSocket server (same port as HTTP) ─────────────────
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    sendWsClientCount();

    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      // Relay the signal to all connected clients
      broadcastSignal(message);
      console.log(`WS signal: ${message.type} competitionId=${message.competitionId} zoneId=${message.zoneId} exerciseId=${message.exerciseId}`);
    });

    ws.on('close', () => {
      wsClients.delete(ws);
      sendWsClientCount();
    });

    ws.on('error', () => {
      wsClients.delete(ws);
      sendWsClientCount();
    });
  });

  httpServer.listen(SERVER_PORT, '0.0.0.0', () => {
    console.log(`Server running at http://${getLocalIP()}:${SERVER_PORT}`);
  });

  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
