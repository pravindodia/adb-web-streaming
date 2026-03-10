# Admin Guide

This guide covers deployment, configuration, and user management for the Android Web ADB Streaming app.

## Overview
- Backend: Express + mediasoup + ws + scrcpy + ffmpeg
- Frontend: Vite + React + mediasoup-client
- Transport: scrcpy -> ffmpeg -> RTP -> mediasoup -> WebRTC

## System Requirements

Install system tools on the host running the backend:

### macOS
```bash
brew install scrcpy ffmpeg
```

Verify:
```bash
scrcpy --version
ffmpeg -version
adb version
```

## Backend Deployment

1. Install dependencies:
```bash
cd backend
npm install
```

2. Configure environment:
```bash
cp .env.example .env

ANNOUNCED_IP=YOUR_LAN_IP \
WEBRTC_TCP_ONLY=1 \
RTC_MIN_PORT=40000 \
RTC_MAX_PORT=40100 \
PORT=5001 npm start
```

3. Open the required ports:
- HTTP API: 5001
- WebRTC: TCP (or UDP) range defined by `RTC_MIN_PORT` and `RTC_MAX_PORT`

## Frontend Deployment

1. Install dependencies:
```bash
cd frontend
npm install
```

2. Run dev server:
```bash
npm run dev
```

3. Open:
```
http://YOUR_HOST:5173
```

## Deployment on macOS (Local)

1. Install system tools:
```bash
brew install scrcpy ffmpeg
```

2. Install app dependencies:
```bash
cd backend && npm install
cd ../frontend && npm install
```

3. Create `.env`:
```bash
cp .env.example .env
```

4. Start backend:
```bash
cd backend && PORT=5001 npm start
```

5. Start frontend (development):
```bash
cd frontend && npm run dev
```

6. Open:
```
http://localhost:5173
```

## Deployment on Linux VPS (Recommended)

1. Install system tools:
```bash
sudo apt update
sudo apt install -y adb ffmpeg scrcpy
```

2. Install Node.js (LTS):
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

3. Clone and install:
```bash
git clone <your-repo-url>
cd android-web-adb-streaming/backend && npm install
cd ../frontend && npm install
```

4. Create `.env`:
```bash
cp .env.example .env
```

5. Start backend (systemd):
```bash
sudo tee /etc/systemd/system/adb-streaming.service > /dev/null <<'EOF'
[Unit]
Description=ADB Web Streaming Backend
After=network.target

[Service]
WorkingDirectory=/opt/android-web-adb-streaming/backend
ExecStart=/usr/bin/npm start
Restart=always
EnvironmentFile=/opt/android-web-adb-streaming/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now adb-streaming.service
```

6. Start frontend (development):
```bash
cd /opt/android-web-adb-streaming/frontend && npm run dev
```

7. Add Nginx reverse proxy (see Reverse Proxy section).

## Deployment on Shared Hosting (npm-supported)

1. Upload the project or connect the repo.
2. Create `.env` from `.env.example` and set your domain values.
3. Install dependencies:
```bash
cd backend && npm install
cd ../frontend && npm install
```

4. Create a Node app for the backend:
- Entry: `backend/server.js`
- Environment: `.env`
- Port: use the panel-provided port

5. Host the frontend (development):
- Run `npm run dev` and use the panel URL

6. Add proxy rules in the panel:
- `/api` -> backend
- `/ws` -> backend WebSocket
- `/` -> frontend

## Production Deployment (macOS)

1. Build the frontend:
```bash
cd frontend && npm run build
```

2. Serve `frontend/dist` with a static server (Nginx/Caddy).

3. Start backend (production):
```bash
cd backend && npm start
```

4. Add reverse proxy rules:
- `/` -> frontend static
- `/api` -> backend
- `/ws` -> backend WebSocket

## Production Deployment (Linux VPS)

1. Build frontend:
```bash
cd /opt/android-web-adb-streaming/frontend && npm run build
```

2. Serve `frontend/dist` with Nginx:
```nginx
root /opt/android-web-adb-streaming/frontend/dist;
```

3. Run backend as systemd (see Linux section above).

4. Add reverse proxy rules:
- `/` -> static
- `/api` -> backend
- `/ws` -> backend WebSocket

## Production Deployment (Shared Hosting)

1. Build frontend:
```bash
cd frontend && npm run build
```

2. Upload `frontend/dist` to the hosting public folder.

3. Run backend as a Node app in the panel:
- Entry: `backend/server.js`
- Environment: `.env`

4. Configure proxy rules:
- `/api` -> backend
- `/ws` -> backend WebSocket

## Docker Deployment

See the Docker guide for Dockerfile and docker-compose examples:

- [docs/docker-guide.md](docker-guide.md)

## Domain Configuration

Set these in `.env` for domain-based deployments:

- `VITE_API_URL`: Full API base (http/https)
- `VITE_WS_URL`: Full WebSocket base (ws/wss)
- `VITE_FORCE_HTTPS`: Force https/wss when building frontend (true/false)
- `FRONTEND_URL`: Allowed origin(s) for backend CORS

## Reverse Proxy Behind a Firewall

If the backend is behind a firewall, place a reverse proxy (Nginx/Caddy) on a host that can reach it. You must allow:
- HTTPS to the proxy (443)
- WebRTC RTP ports from proxy to backend (`RTC_MIN_PORT`-`RTC_MAX_PORT`)

### Nginx example

```nginx
server {
	listen 443 ssl;
	server_name your.domain.com;

	ssl_certificate /etc/letsencrypt/live/your.domain.com/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/your.domain.com/privkey.pem;
	ssl_protocols TLSv1.2 TLSv1.3;
	ssl_prefer_server_ciphers off;

	# Frontend
	location / {
		proxy_pass http://127.0.0.1:5173;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}

	# Backend API
	location /api/ {
		proxy_pass http://127.0.0.1:5001/;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}

	# WebSocket signaling
	location /ws {
		proxy_pass http://127.0.0.1:5001;
		proxy_http_version 1.1;
		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection "upgrade";
		proxy_set_header Host $host;
	}
}
```

If you use `/api/` on the proxy, update the frontend API base to `https://your.domain.com/api`.

### Notes
- Set `ANNOUNCED_IP` to the public/LAN IP of the proxy so ICE candidates are reachable.
- If UDP is blocked, use `WEBRTC_TCP_ONLY=1`.
- Forward the RTP port range from proxy to backend.

## Environment Variables

- `ANNOUNCED_IP`: LAN IP for WebRTC ICE candidates
- `WEBRTC_TCP_ONLY=1`: Force TCP ICE if UDP is blocked
- `RTC_MIN_PORT` / `RTC_MAX_PORT`: Fixed port range for firewall rules
- `PORT`: Backend API port (default 5001)
- `SESSION_TTL_MIN`: Session timeout in minutes for JWT (default 120)
- `SESSION_WARNING_MIN`: Minutes before expiry to show the warning banner (default 2)

### Session Timeout

- The frontend shows a warning banner before session expiry (default 2 minutes).
- When the session expires, the app disconnects the device and returns to login.

## User Management

Users are stored in `backend/users.json` with salted PBKDF2 hashes.

### Generate a user record
```bash
cd backend
npm run gen-user -- admin yourPassword
```

### Add user directly to users.json
```bash
cd backend
npm run gen-user -- admin yourPassword --add
```

Each user record also stores `lastDevice` so the UI can prefill the most recent device.

## Device Configuration

- Connect to a device using ADB over TCP: `IP:PORT`
- The backend stores the last device per user
- Device resolution is fetched automatically using `adb shell wm size`

## Health Checks

- API reachable: `GET /devices` (requires auth token)
- WebRTC signaling: `WS /ws` (requires token query param)
- scrcpy/ffmpeg running: backend logs show `[RTC]` and `[ffmpeg]`

## Troubleshooting

- **No video:** ensure scrcpy/ffmpeg/adb in PATH and device is connected
- **ICE failed:** set `ANNOUNCED_IP` to LAN IP and use `WEBRTC_TCP_ONLY=1`
- **Tap mismatch:** verify `/device-info` returns correct resolution
- **High latency:** reduce bitrate or limit fps on scrcpy if needed
