# Acro Local Server

A lightweight Electron app that runs a local HTTP video server on the organizer's computer during competitions. Phones upload video recordings here, and judges can view them instantly in the Acro Companion app — no waiting for YouTube to process.

## How It Works

```
Phone (Capacitor)                    Organizer's Computer                 Judge's Browser
─────────────────                    ────────────────────                 ───────────────
Records routine  ──── POST /upload ──▶  Stores video file
                                        Serves over HTTP  ◀── GET /videos/file.mp4 ── Views in app
                                        Auto-deletes after 10 min
```

## Setup

```bash
npm install
npm start
```

## API Endpoints

### Upload a video
```
POST http://<ip>:3000/upload
Content-Type: multipart/form-data
Body: video (file)

Response: { url, filename, expiresIn }
```

### Upload with routine ID
```
POST http://<ip>:3000/upload/:routineId
Content-Type: multipart/form-data
Body: video (file)

Response: { url, filename, routineId, expiresIn }
```

### List all videos
```
GET http://<ip>:3000/list

Response: [{ filename, originalName, routineId, url, uploadedAt, expiresAt }]
```

### Stream/download a video
```
GET http://<ip>:3000/videos/:filename
```

### Delete a video
```
DELETE http://<ip>:3000/videos/:filename

Response: { deleted: filename }
```

### Health check
```
GET http://<ip>:3000/health

Response: { status: "ok", files: 3 }
```

## Angular Integration (Acro Companion)

Example service for the client side:

```typescript
@Injectable({ providedIn: 'root' })
export class LocalVideoService {
  private serverUrl: string | null = null;

  /** Set by organizer in competition settings */
  setServerUrl(url: string) {
    this.serverUrl = url;
  }

  /** Upload video from Capacitor app */
  uploadVideo(file: File, routineId?: string): Observable<{ url: string }> {
    if (!this.serverUrl) throw new Error('Local server not configured');

    const formData = new FormData();
    formData.append('video', file);

    const endpoint = routineId
      ? `${this.serverUrl}/upload/${routineId}`
      : `${this.serverUrl}/upload`;

    return this.http.post<{ url: string }>(endpoint, formData);
  }

  /** Get video URL for judges to watch */
  getVideoUrl(filename: string): string {
    return `${this.serverUrl}/videos/${filename}`;
  }
}
```

## Building for Distribution

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Linux
npm run build:linux
```

The distributable will be in the `dist/` folder.

## Configuration

In `src/main.js`, you can adjust:
- `SERVER_PORT` — default `3000`
- `AUTO_DELETE_MS` — default `10 minutes`
- `fileSize` limit in multer config — default `500MB`
