# Copilot instructions

## Big picture
- Two-node app: backend in `backend/server.js` (Express) handles ADB connection + WebRTC ingest; frontend in `frontend/src` (Vite + React) drives the UI.
- Backend exposes auth + ADB control + WebRTC signaling endpoints; frontend calls them directly with `fetch` and receives video via `<video>` + mediasoup-client.
- Live streaming is low-latency WebRTC: backend starts `scrcpy --record <fifo>` and pipes to `ffmpeg` to produce RTP for mediasoup.

## Key flows and boundaries
- Login issues JWT (`/login`) using users.json hashed credentials; frontend stores token in localStorage and sends `Authorization: Bearer <token>`.
- Emulator connection uses `adb connect <ip>:<port>` via `/connect`, stores last device per user in users.json.
- Control endpoints map 1:1 to ADB commands (`/tap`, `/text`, `/key`, `/swipe`).
- WebRTC signaling uses WebSocket at `/ws` with actions: `getRouterRtpCapabilities`, `createTransport`, `connectTransport`, `consume`.
- Device resolution is fetched via `/device-info` and used for coordinate scaling in the UI.

## Developer workflows
- Backend: `cd backend && npm install && PORT=5001 npm start`.
- Frontend: `cd frontend && npm install && npm run dev` (Vite default port 5173).
- System deps required: `scrcpy`, `ffmpeg`, and `adb` in PATH (see README).

## Project-specific conventions
- API base URL is dynamic: `http://${window.location.hostname}:5001` (see `frontend/src/App.jsx`).
- Backend uses a single in-memory `streamProcess` and `webrtcProcess` to prevent multiple scrcpy/ffmpeg chains.
- Auth uses users.json (salted PBKDF2 hashes) and JWT secret in code.
- Debug logs in the frontend are gated behind `import.meta.env.DEV`.

## Integration notes
- Streaming depends on OS-level tools; failures show up as backend process errors rather than JS exceptions.
- The frontend renders a `<video>` element and attaches the mediasoup consumer track.

## Reference files
- Backend routes and process management: `backend/server.js`.
- UI flow and API usage: `frontend/src/App.jsx`.
- Run commands and prerequisites: `README.md`.
