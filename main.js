const { app, BrowserWindow, ipcMain, Notification } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');

// ─── Config ────────────────────────────────────────────────
const SERVER_PORT = 3000;

// ─── Video storage directory ───────────────────────────────
const videosDir = path.join(app.getPath('desktop'), 'AcroVideos');
if (!fs.existsSync(videosDir)) {
  fs.mkdirSync(videosDir, { recursive: true });
}

// ─── Track uploaded files ──────────────────────────────────
const uploadedFiles = new Map(); // filename -> { originalName, uploadedAt, size }
let mainWindow = null;
const wsClients = new Set();

// ─── Rehydrate file list from disk ─────────────────────────
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi'];

function hydrateFromDisk() {
  try {
    const entries = fs.readdirSync(videosDir);
    let count = 0;
    for (const filename of entries) {
      if (filename.startsWith('.')) continue;
      if (!VIDEO_EXTENSIONS.includes(path.extname(filename).toLowerCase())) continue;
      if (uploadedFiles.has(filename)) continue;

      const filePath = path.join(videosDir, filename);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;

      uploadedFiles.set(filename, {
        originalName: filename,
        uploadedAt: stat.mtimeMs,
        size: stat.size,
      });
      count++;
    }
    console.log(`Hydrated ${count} existing video(s) from disk`);
  } catch (err) {
    console.error('Failed to hydrate files from disk:', err.message);
  }
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
function sendFileList() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const files = Array.from(uploadedFiles.entries()).map(([filename, info]) => ({
    filename,
    originalName: info.originalName,
    uploadedAt: info.uploadedAt,
    size: info.size,
  }));
  mainWindow.webContents.send('file-list-updated', files);
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

  // Multer config for file uploads
  const storage = multer.diskStorage({
    destination: videosDir,
    filename: (req, file, cb) => {
      cb(null, file.originalname);
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

  // ─── Routes ───────────────────────────────────────────────

  // Health check
  server.get('/health', (req, res) => {
    res.json({ status: 'ok', files: uploadedFiles.size });
  });

  // Upload a video
  server.post('/upload', upload.single('video'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    const localIP = getLocalIP();
    const filename = req.file.filename;

    uploadedFiles.set(filename, {
      originalName: req.file.originalname,
      uploadedAt: Date.now(),
      size: req.file.size,
    });

    sendFileList();

    const videoUrl = `http://${localIP}:${SERVER_PORT}/videos/${filename}`;
    console.log(`Uploaded: ${filename} → ${videoUrl}`);

    res.json({
      url: videoUrl,
      filename,
    });
  });

  // Upload with a specific exercise ID (alternative endpoint)
  server.post('/upload/:exerciseId', upload.single('video'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    const localIP = getLocalIP();
    const filename = req.file.filename;

    uploadedFiles.set(filename, {
      originalName: req.file.originalname,
      exerciseId: req.params.exerciseId,
      uploadedAt: Date.now(),
      size: req.file.size,
    });

    sendFileList();

    const videoUrl = `http://${localIP}:${SERVER_PORT}/videos/${filename}`;
    console.log(`Uploaded exercise ${req.params.exerciseId}: ${filename} → ${videoUrl}`);

    res.json({
      url: videoUrl,
      filename,
      exerciseId: req.params.exerciseId,
    });
  });

  // Serve video files
  server.use('/videos', express.static(videosDir));

  // List all available videos
  server.get('/list', (req, res) => {
    const localIP = getLocalIP();
    const files = Array.from(uploadedFiles.entries()).map(([filename, info]) => ({
      filename,
      originalName: info.originalName,
      exerciseId: info.exerciseId || null,
      url: `http://${localIP}:${SERVER_PORT}/videos/${filename}`,
      uploadedAt: info.uploadedAt,
    }));
    res.json(files);
  });

  // Delete a specific video manually
  server.delete('/videos/:filename', (req, res) => {
    const filename = req.params.filename;
    const info = uploadedFiles.get(filename);

    if (!info) {
      return res.status(404).json({ error: 'File not found' });
    }

    clearTimeout(info.deleteTimer);
    const filePath = path.join(videosDir, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    uploadedFiles.delete(filename);
    sendFileList();

    res.json({ deleted: filename });
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

ipcMain.handle('get-file-list', () => {
  return Array.from(uploadedFiles.entries()).map(([filename, info]) => ({
    filename,
    originalName: info.originalName,
    uploadedAt: info.uploadedAt,
    size: info.size,
  }));
});

ipcMain.handle('delete-file', (event, filename) => {
  const info = uploadedFiles.get(filename);
  if (!info) return { error: 'File not found' };

  clearTimeout(info.deleteTimer);
  const filePath = path.join(videosDir, filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  uploadedFiles.delete(filename);
  sendFileList();
  return { deleted: filename };
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
