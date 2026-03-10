# Android Web ADB Streaming

Low-latency Android emulator control from the browser. The backend manages ADB, scrcpy, and WebRTC ingest; the frontend renders a live video stream and sends taps, swipes, and key events.

## Features
- JWT authentication with hashed users stored in `backend/users.json`
- ADB connect/disconnect + device discovery
- Tap, swipe, text input, and key events
- WebRTC streaming via mediasoup (H.264 passthrough)
- Auto device resolution detection and accurate touch scaling
- Last connected device remembered per user

## Architecture
- **Backend:** Express + mediasoup + ws + scrcpy + ffmpeg
- **Frontend:** Vite + React + mediasoup-client
- **Transport:** RTP ingest (scrcpy -> ffmpeg -> mediasoup -> WebRTC)

## Requirements
Install system tools:

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

## Run Locally

### Backend
```bash
cd backend
npm install
PORT=5001 npm start
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Open:
```
http://localhost:5173
```

## Configuration

### Environment File
Copy the example and update for your domain:

```bash
cp .env.example .env
```

Frontend uses `VITE_API_URL` and `VITE_WS_URL`. Backend uses `FRONTEND_URL` for CORS and WebRTC settings below.

### Environment Variables
Set these when running the backend:

```bash
ANNOUNCED_IP=10.10.192.3 \
WEBRTC_TCP_ONLY=1 \
RTC_MIN_PORT=40000 \
RTC_MAX_PORT=40100 \
PORT=5001 npm start
```

- `ANNOUNCED_IP`: LAN IP for WebRTC ICE candidates
- `WEBRTC_TCP_ONLY=1`: Force TCP ICE if UDP is blocked
- `RTC_MIN_PORT` / `RTC_MAX_PORT`: Fixed port range for firewall rules
- `SESSION_TTL_MIN`: Session timeout in minutes for JWT (default 120)
- `SESSION_WARNING_MIN`: Minutes before expiry to show the warning banner (default 2)
- `VITE_FORCE_HTTPS`: Force https/wss when building frontend (true/false)
- `VITE_SESSION_WARNING_MIN`: Minutes before expiry to show the warning banner

## User Management

Users are stored in `backend/users.json` using salted PBKDF2 hashes.

### Generate a user
```bash
cd backend
npm run gen-user -- admin yourPassword
```

### Add user directly to users.json
```bash
cd backend
npm run gen-user -- admin yourPassword --add
```

The backend also records `lastDevice` for each user to prefill the connect form.

## Usage

1. Login with a user from `users.json`.
2. Connect to an emulator using `IP:PORT` (ADB TCP).
3. Stream starts automatically once connected.
4. Click to tap, swipe to gesture, use buttons for HOME/BACK/POWER, etc.

## Guides

- Admin deployment guide: [docs/admin-guide.md](docs/admin-guide.md)
- User guide: [docs/user-guide.md](docs/user-guide.md)
- Docker guide: [docs/docker-guide.md](docs/docker-guide.md)

Deployment steps (macOS, Linux VPS, shared hosting) are in the admin guide.

## API Endpoints

### Auth
- `POST /login`

### Device Management
- `POST /connect`
- `POST /disconnect`
- `GET /devices`
- `GET /device-info`

### Controls
- `POST /tap`
- `POST /swipe`
- `POST /text`
- `POST /key`

### Streaming
- `GET /stream` (MJPEG fallback)
- `WS /ws` (WebRTC signaling)

## Troubleshooting

- **No video:** verify `scrcpy`, `ffmpeg`, and `adb` are in PATH and the emulator is connected.
- **ICE failed:** set `ANNOUNCED_IP` to your LAN IP and use `WEBRTC_TCP_ONLY=1` if needed.
- **Tap mismatch:** ensure `/device-info` returns the correct resolution.

## Notes

- The frontend uses a fixed 9:16 video frame but scales touches to the real device resolution.
- Debug logs in the UI only appear in dev mode (`import.meta.env.DEV`).
- The UI warns before session expiry (default 2 minutes) and logs out automatically when the timeout expires.
