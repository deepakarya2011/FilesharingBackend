# Deploy — Backend (Render)

The backend auto-deploys from the `main` branch of `https://github.com/deepakarya2011/FilesharingBackend`
via the `render.yaml` in this repo. Each push to `main` triggers a new Render deploy.

## Build / Start (defined in `render.yaml`)
- **buildCommand:** `npm install && npm run build`
  - `npm run build` is a lightweight no-op check — MongoDB + Mongoose ko koi generate/compile step nahi chahiye.
- **startCommand:** `npm start` → `node server.js` (listens on the `$PORT` Render injects).
- **runtime:** node

## Required environment variables (set in Render dashboard → Service → Environment)
Render reads these from `render.yaml` (`sync: false` = set manually in the dashboard):

| Variable | Value | Notes |
|---|---|---|
| `MONGODB_URI` | MongoDB connection string | e.g. `mongodb+srv://...mongodb.net/filesharing` |
| `FRONTEND_URL` | Your Vercel frontend URL | e.g. `https://filesharing-frontend.vercel.app` (CORS allow-list) |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name | |
| `CLOUDINARY_API_KEY` | Cloudinary API key | |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret | Never commit real secrets — they live in the dashboard only |
| `NODE_ENV` | `production` | Already set via `render.yaml` envVars |

> ⚠️ Without the `CLOUDINARY_*` vars the upload will fail. Add them in the Render
> dashboard, then trigger a new deploy (push a commit or use "Redeploy").

## Architecture
- Files are stored on **Cloudinary** (not in the DB / not P2P).
- Sender uploads via `POST /api/shares/:id/upload` (multipart → Cloudinary).
- Receiver verifies a 6-digit code via `GET /api/shares/verify/:code`, downloads each
  Cloudinary URL, and the file is **deleted on download** (`DELETE /api/files/:id`).
- Expired shares (1 hour) are cleaned up by an interval in `server.js` via `lib/cleanup.js`.

## Endpoints
- `GET  /api/health` — DB connectivity check (returns `{ status: "ok", database: "connected" }`).
- `POST /api/shares` — create a share (returns `{ id, code, expiresAt }`).
- `POST /api/shares/:shareId/upload` — multipart upload (`files` field).
- `GET  /api/shares/verify/:code` — verify code + list files.
- `GET  /api/shares/:shareId/status` — share status + remaining file count.
- `DELETE /api/files/:fileId` — delete a single file (delete-on-download).
- `DELETE /api/shares/:shareId` — full share cleanup.

## Local dev
```
cp .env.example .env      # fill MONGODB_URI + CLOUDINARY_*
npm install
npm run dev               # nodemon server.js on http://localhost:5000
```
