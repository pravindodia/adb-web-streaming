# Docker Deployment Guide

This guide shows how to containerize both backend and frontend in a single Docker image using environment variables from a `.env` file.

## 1) Unified Dockerfile (root/Dockerfile)

```Dockerfile
# Stage 1: Build frontend
FROM node:20-slim AS frontend-build
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm install
COPY frontend . 
RUN npm run build

# Stage 2: Build and run backend + serve frontend
FROM node:20-slim

# System deps for adb + scrcpy + ffmpeg
RUN apt-get update && apt-get install -y \
  adb \
  scrcpy \
  ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm install --production
COPY backend .

# Copy built frontend static files
COPY --from=frontend-build /frontend/dist public/

EXPOSE 5001
CMD ["npm", "start"]
```

## 2) Update backend/server.js

Add this line early in `server.js` to serve the built frontend:

```javascript
// Serve static frontend files (from Dockerfile /app/public)
app.use(express.static(path.join(__dirname, 'public')));

// Then define API routes (/login, /connect, /tap, /text, /key, /swipe, /device-info, /ws)
// ...
```

This ensures:
- Static assets are served on `http://localhost:5001/`
- API endpoints remain at `http://localhost:5001/login`, `/api/*`, etc.
- WebSocket signaling works at `ws://localhost:5001/ws`

## 3) Create .env file (root/.env)

Copy [.env.example](.env.example) and customize:

```bash
# Frontend environment (passed to Vite at build time)
VITE_API_URL=http://localhost:5001
VITE_WS_URL=ws://localhost:5001
VITE_FORCE_HTTPS=false
VITE_SESSION_TIMEOUT_MIN=120
VITE_SESSION_WARNING_MIN=2

# Backend environment (runtime)
PORT=5001
FRONTEND_URL=http://localhost:5001
NODE_ENV=production
ANNOUNCED_IP=127.0.0.1
WEBRTC_TCP_ONLY=1
RTC_MIN_PORT=40000
RTC_MAX_PORT=40100
SESSION_TTL_MIN=120
SESSION_WARNING_MIN=2
```

For **remote/LAN deployments**, update:
```bash
VITE_API_URL=http://<your-docker-host-ip>:5001
VITE_WS_URL=ws://<your-docker-host-ip>:5001
ANNOUNCED_IP=<your-docker-host-ip>
```

## 4) docker-compose.yml (root)

```yaml
version: "3.9"
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "5001:5001"
    env_file:
      - .env
    volumes:
      - ./backend/users.json:/app/users.json:rw
```

This:
- Builds the single image from `root/Dockerfile`
- Exposes port 5001 for frontend + backend
- Loads all env vars from `.env`
- Mounts `users.json` for persistence

## 5) Build and Run

```bash
# Build the image
docker compose build

# Run (foreground, useful for seeing logs)
docker compose up

# Or run in background
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

Access at:
```
http://localhost:5001
```

## 6) Notes

- **Frontend build time:** The container is built once with all env vars baked in (e.g., `VITE_API_URL`). If you change VITE_* vars, rebuild the image.
- **Backend vars:** PORT, SESSION_TTL_MIN, etc. can be changed in `.env` without rebuild.
- **Persistence:** `users.json` is mounted as a volume, so user credentials survive container restarts.
- **ADB access:** If your device is on the host, ensure the container can reach the ADB daemon. For macOS/Windows with Docker Desktop, use `host.docker.internal:5037` as the ADB host.
- **Reverse proxy:** If placing NginX/Apache in front, set `VITE_API_URL` and `VITE_WS_URL` to your proxy domain.
