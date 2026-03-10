const express = require("express");
const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const mediasoup = require("mediasoup");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const bodyParser = require("body-parser");
const { exec, spawn } = require("child_process");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { promisify } = require("util");

const app = express();
const FRONTEND_URL = process.env.FRONTEND_URL;
const corsOptions = FRONTEND_URL
  ? { 
      origin: FRONTEND_URL.split(",").map((origin) => origin.trim()),
      credentials: true,
      optionsSuccessStatus: 200
    }
  : { 
      origin: true,
      credentials: true,
      optionsSuccessStatus: 200
    };
app.use(cors(corsOptions));
app.use(bodyParser.json());

// Serve static frontend files (built by Dockerfile)
app.use(express.static(path.join(__dirname, "public")));

const SECRET = "supersecretkey";
const USERS_PATH = path.join(__dirname, "users.json");
const SESSION_TTL_MIN = Number(process.env.SESSION_TTL_MIN || 120);
const SESSION_WARNING_MIN = Number(process.env.SESSION_WARNING_MIN || 2);

let streamProcess = null;
let currentDevice = null;
const streamClients = new Set();
let mjpegBuffer = Buffer.alloc(0);

let mediasoupWorker = null;
let mediasoupRouter = null;
let rtpTransport = null;
let rtpProducer = null;
let webrtcProcess = null;

const videoSsrc = 22222222;
const videoPayloadType = 96;

const execAsync = promisify(exec);

function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_PATH, "utf8");
    const users = JSON.parse(raw);
    return Array.isArray(users) ? users : [];
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2) + "\n", "utf8");
}

function updateUserLastDevice(username, lastDevice) {
  if (!username) return;
  const users = loadUsers();
  const updated = users.map((user) => {
    if (user.username !== username) return user;
    return { ...user, lastDevice };
  });
  saveUsers(updated);
}

function getUserRecord(username) {
  const users = loadUsers();
  return users.find((entry) => entry.username === username) || null;
}

function verifyPassword(password, salt, hash) {
  const derived = crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(derived, "hex"), Buffer.from(hash, "hex"));
}

const mediaCodecs = [
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
    },
  },
];

function parseAdbDevices(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("List of devices"))
    .map((line) => {
      const [id] = line.split(/\s+/);
      const modelMatch = line.match(/model:([^\s]+)/);
      return {
        id,
        name: modelMatch ? modelMatch[1].replace(/_/g, " ") : id,
      };
    })
    .filter((device) => device.id);
}

async function getActiveDevice() {
  if (currentDevice) return currentDevice;
  const { stdout } = await execAsync("adb devices -l");
  const devices = parseAdbDevices(stdout);
  if (devices.length === 0) return null;
  currentDevice = devices[0].id;
  return currentDevice;
}

function parseWmSize(output) {
  const physicalMatch = output.match(/Physical size:\s*(\d+)x(\d+)/i);
  if (physicalMatch) {
    return { width: Number(physicalMatch[1]), height: Number(physicalMatch[2]) };
  }
  const overrideMatch = output.match(/Override size:\s*(\d+)x(\d+)/i);
  if (overrideMatch) {
    return { width: Number(overrideMatch[1]), height: Number(overrideMatch[2]) };
  }
  return null;
}

async function getDeviceInfo(device) {
  const { stdout } = await execAsync(`adb -s ${device} shell wm size`);
  const size = parseWmSize(stdout);
  return { raw: stdout.trim(), size };
}

async function ensureMediasoup() {
  if (mediasoupWorker && mediasoupRouter) return;
  const rtcMinPort = process.env.RTC_MIN_PORT ? Number(process.env.RTC_MIN_PORT) : undefined;
  const rtcMaxPort = process.env.RTC_MAX_PORT ? Number(process.env.RTC_MAX_PORT) : undefined;
  console.log("[Mediasoup] Creating worker with rtcMinPort:", rtcMinPort, "rtcMaxPort:", rtcMaxPort);
  try {
    mediasoupWorker = await mediasoup.createWorker({ rtcMinPort, rtcMaxPort });
    console.log("[Mediasoup] Worker created successfully");
    mediasoupRouter = await mediasoupWorker.createRouter({ mediaCodecs });
    console.log("[Mediasoup] Router created successfully");
  } catch (err) {
    console.error("[Mediasoup] Failed to create worker/router:", err);
    throw err;
  }
}

async function createFifo(prefix) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const fifoPath = path.join(os.tmpdir(), `${prefix}-${unique}.mkv`);
  await execAsync(`mkfifo "${fifoPath}"`);
  return fifoPath;
}

function cleanupFifo(fifoPath) {
  if (!fifoPath) return;
  try {
    fs.unlinkSync(fifoPath);
  } catch {
    // Ignore cleanup errors for missing fifo.
  }
}

function stopWebRtcIngest() {
  if (webrtcProcess) {
    webrtcProcess.ffmpeg.kill("SIGTERM");
    webrtcProcess.scrcpy.kill("SIGTERM");
    cleanupFifo(webrtcProcess.fifoPath);
  }
  webrtcProcess = null;
  rtpProducer = null;
  rtpTransport = null;
}

async function startWebRtcIngest() {
  if (rtpProducer) {
    console.log("[RTC] Producer already exists");
    return;
  }
  console.log("[RTC] Starting WebRTC ingest");
  await ensureMediasoup();

  const device = await getActiveDevice();
  if (!device) {
    console.log("[RTC] No device connected, aborting");
    return;
  }
  console.log("[RTC] Device:", device);

  rtpTransport = await mediasoupRouter.createPlainTransport({
    listenIp: { ip: "127.0.0.1" },
    rtcpMux: true,
    comedia: true,
  });

  rtpProducer = await rtpTransport.produce({
    kind: "video",
    rtpParameters: {
      codecs: [
        {
          mimeType: "video/H264",
          payloadType: videoPayloadType,
          clockRate: 90000,
          parameters: {
            "packetization-mode": 1,
            "profile-level-id": "42e01f",
            "level-asymmetry-allowed": 1,
          },
        },
      ],
      encodings: [{ ssrc: videoSsrc }],
    },
  });
  console.log("[RTC] RTP producer created, listening for RTP on port", rtpTransport.tuple.localPort);

  const rtpPort = rtpTransport.tuple.localPort;

  const fifoPath = await createFifo("scrcpy-webrtc");

  const scrcpy = spawn("scrcpy", [
    "-s",
    device,
    "--no-window",
    "--no-playback",
    "--max-size=800",
    "--max-fps=30",
    "--show-touches",
    "--video-bit-rate=1500k",
    "--print-fps",
    "--record-format=mkv",
    "--turn-screen-off",
    `--record=${fifoPath}`,
  ]);

  const ffmpeg = spawn("ffmpeg", [
    "-f", "matroska",
    "-i", fifoPath,
    "-an",
    "-c:v", "copy",
    "-payload_type", `${videoPayloadType}`,
    "-ssrc", `${videoSsrc}`,
    "-f", "rtp",
    `rtp://127.0.0.1:${rtpPort}?pkt_size=1200`,
  ]);
  webrtcProcess = { scrcpy, ffmpeg, fifoPath };

  let rtpBytesReceived = 0;
  rtpTransport.on("data", (packet) => {
    rtpBytesReceived += packet.length;
    if (rtpBytesReceived % 50000 < 1500) {
      console.log("[RTC] RTP bytes received:", Math.round(rtpBytesReceived / 1024), "KB");
    }
  });

  ffmpeg.stderr.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line.includes("frame=") || line.includes("Error") || line.includes("error")) {
      console.log("[ffmpeg]", line);
    }
  });

  scrcpy.stderr.on("data", (chunk) => {
    const line = chunk.toString().trim();
    if (line.includes("ERROR") || line.includes("error")) {
      console.log("[scrcpy]", line);
    }
  });

  ffmpeg.on("close", stopWebRtcIngest);
  scrcpy.on("close", stopWebRtcIngest);
  console.log("[RTC] ffmpeg and scrcpy started, RTP port", rtpTransport.tuple.localPort);
  console.log("[RTC] ffmpeg and scrcpy piped together");
}

function sendFrameToClients(frame) {
  for (const res of streamClients) {
    res.write("--frame\r\n");
    res.write("Content-Type: image/jpeg\r\n\r\n");
    res.write(frame);
    res.write("\r\n");
  }
}

function parseMjpegFrames(chunk) {
  mjpegBuffer = Buffer.concat([mjpegBuffer, chunk]);

  while (true) {
    const start = mjpegBuffer.indexOf(Buffer.from([0xff, 0xd8]));
    if (start === -1) {
      mjpegBuffer = mjpegBuffer.slice(-1);
      return;
    }

    const end = mjpegBuffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end === -1) {
      if (start > 0) {
        mjpegBuffer = mjpegBuffer.slice(start);
      }
      return;
    }

    const frame = mjpegBuffer.slice(start, end + 2);
    mjpegBuffer = mjpegBuffer.slice(end + 2);
    sendFrameToClients(frame);
  }
}

function stopStreamProcess() {
  if (!streamProcess) return;
  streamProcess.ffmpeg.kill("SIGTERM");
  streamProcess.scrcpy.kill("SIGTERM");
  cleanupFifo(streamProcess.fifoPath);
  streamProcess = null;
  mjpegBuffer = Buffer.alloc(0);
}

async function startStreamProcess() {
  if (streamProcess) return;
  const device = await getActiveDevice();
  if (!device) return;

  console.log("Starting scrcpy streaming...");

  const fifoPath = await createFifo("scrcpy-mjpeg");

  const scrcpy = spawn("scrcpy", [
    "-s",
    device,
    "--no-playback",
    "--max-size=800",
    "--max-fps=30",
    "--show-touches",
    "--video-bit-rate=1500k",
    "--print-fps",
    "--record-format=mkv",
    `--record=${fifoPath}`
  ]);

  const ffmpeg = spawn("ffmpeg", [
    "-f", "matroska",
    "-i", fifoPath,
    "-vf", "fps=10",
    "-q:v", "5",
    "-f", "mjpeg",
    "pipe:1"
  ]);
  streamProcess = { scrcpy, ffmpeg, fifoPath };

  ffmpeg.stdout.on("data", parseMjpegFrames);

  ffmpeg.stderr.on("data", (chunk) => {
    console.log("ffmpeg:", chunk.toString().trim());
  });

  scrcpy.stderr.on("data", (chunk) => {
    console.log("scrcpy:", chunk.toString().trim());
  });

  ffmpeg.on("error", (err) => {
    console.log("ffmpeg error:", err.message);
  });

  scrcpy.on("error", (err) => {
    console.log("scrcpy error:", err.message);
  });

  const reset = () => {
    streamProcess = null;
    mjpegBuffer = Buffer.alloc(0);
  };

  ffmpeg.on("close", reset);
  scrcpy.on("close", reset);
}

// Auth middleware
function auth(req, res, next) {
  const headerToken = req.headers.authorization?.split(" ")[1];
  const queryToken = req.query?.token;
  const token = headerToken || queryToken;
  if (!token) return res.status(401).json({ error: "No token" });

  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

function verifyTokenString(token) {
  if (!token) return false;
  try {
    jwt.verify(token, SECRET);
    return true;
  } catch {
    return false;
  }
}

// Login
app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const user = getUserRecord(username);
  if (!user) return res.status(401).json({ error: "Bad credentials" });

  const ok = verifyPassword(password || "", user.salt, user.hash);
  if (!ok) return res.status(401).json({ error: "Bad credentials" });

  const token = jwt.sign({ username }, SECRET, { expiresIn: `${SESSION_TTL_MIN}m` });
  return res.json({
    token,
    lastDevice: user.lastDevice || null,
    sessionTtlMin: SESSION_TTL_MIN,
    sessionWarningMin: SESSION_WARNING_MIN,
  });
});

// Connect emulator
app.post("/connect", auth, (req, res) => {
  const { ip, port } = req.body;
  exec(`adb connect ${ip}:${port}`, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr });
    currentDevice = `${ip}:${port}`;
    updateUserLastDevice(req.user?.username, currentDevice);
    res.json({ result: stdout });
  });
});

// Disconnect emulator
app.post("/disconnect", auth, (req, res) => {
  const { ip, port } = req.body;
  const target = ip && port ? `${ip}:${port}` : "";
  exec(`adb disconnect ${target}`, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr });
    if (currentDevice) {
      updateUserLastDevice(req.user?.username, currentDevice);
    }
    currentDevice = null;
    res.json({ result: stdout });
  });
});

// List connected devices
app.get("/devices", auth, (req, res) => {
  exec("adb devices -l", (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: stderr });
    const devices = parseAdbDevices(stdout);
    const user = getUserRecord(req.user?.username);
    const lastDevice = user?.lastDevice || null;

    if (lastDevice && devices.some((device) => device.id === lastDevice)) {
      currentDevice = lastDevice;
    } else if (!currentDevice && devices.length > 0) {
      if (devices.length > 1) {
        currentDevice = null;
      } else {
        currentDevice = devices[0].id;
      }
    }

    res.json({ devices, activeDevice: currentDevice, lastDevice });
  });
});

app.get("/device-info", auth, async (req, res) => {
  try {
    const device = await getActiveDevice();
    if (!device) return res.status(400).json({ error: "No device connected" });
    const info = await getDeviceInfo(device);
    if (!info.size) return res.status(500).json({ error: "Unable to read device size", raw: info.raw });
    res.json({ device, size: info.size, raw: info.raw });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tap control
app.post("/tap", auth, async (req, res) => {
  const { x, y } = req.body;
  const device = currentDevice;
  if (!device) return res.status(400).json({ error: "No device connected" });
  
  const cmd = `adb -s ${device} shell input tap ${x} ${y}`;
  console.log(`[TAP] Device: ${device}, Coords: (${x}, ${y}), Command: ${cmd}`);
  
  // Fire-and-forget to avoid slow ADB latency
  res.json({ success: true });
  execAsync(cmd).then(() => {
    console.log(`[TAP] ✅ Success: (${x}, ${y}) on ${device}`);
  }).catch(err => {
    console.error(`[TAP] ❌ Failed: ${err.message}`);
  });
});

// Text input
app.post("/text", auth, async (req, res) => {
  const { text } = req.body;
  const device = currentDevice;
  if (!device) return res.status(400).json({ error: "No device connected" });
  
  res.json({ success: true });
  execAsync(`adb -s ${device} shell input text "${text}"`).catch(err => {
    console.error("Text failed:", err.message);
  });
});

// Key event
app.post("/key", auth, async (req, res) => {
  const { code } = req.body;
  const device = currentDevice;
  if (!device) return res.status(400).json({ error: "No device connected" });
  
  res.json({ success: true });
  execAsync(`adb -s ${device} shell input keyevent ${code}`).catch(err => {
    console.error("Key failed:", err.message);
  });
});

// Swipe gesture
app.post("/swipe", auth, async (req, res) => {
  const { x1, y1, x2, y2, duration } = req.body;
  const device = currentDevice;
  if (!device) return res.status(400).json({ error: "No device connected" });
  
  const swipeDuration = duration || 300; // Default 300ms
  const cmd = `adb -s ${device} shell input swipe ${x1} ${y1} ${x2} ${y2} ${swipeDuration}`;
  console.log(`[SWIPE] Device: ${device}, (${x1},${y1}) → (${x2},${y2}) in ${swipeDuration}ms`);
  
  res.json({ success: true });
  execAsync(cmd).then(() => {
    console.log(`[SWIPE] ✅ Success on ${device}`);
  }).catch(err => {
    console.error(`[SWIPE] ❌ Failed: ${err.message}`);
  });
});

// Live stream endpoint
app.get("/stream", auth, async (req, res) => {
  const device = await getActiveDevice();
  if (!device) {
    res.status(400).json({ error: "No device connected" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Pragma": "no-cache",
  });

  streamClients.add(res);
  res.on("close", () => {
    streamClients.delete(res);
    if (streamClients.size === 0) {
      stopStreamProcess();
    }
  });

  await startStreamProcess();
});

// SSL/HTTPS support
const SSL_ENABLED = process.env.SSL_ENABLED === 'true';
const server = SSL_ENABLED 
  ? https.createServer({
      key: fs.readFileSync(process.env.SSL_KEY_PATH || path.join(__dirname, 'key.pem')),
      cert: fs.readFileSync(process.env.SSL_CERT_PATH || path.join(__dirname, 'cert.pem'))
    }, app)
  : http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });
const activeConsumers = new Set();

function wsSend(ws, action, requestId, data, error) {
  ws.send(JSON.stringify({ action, requestId, data, error }));
}

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const token = url.searchParams.get("token");
  console.log("[WS] Connection attempt, token present:", !!token);
  if (!verifyTokenString(token)) {
    ws.close(1008, "Unauthorized");
    console.log("[WS] Closed: unauthorized");
    return;
  }
  console.log("[WS] Authorized, setting up handlers");

  const transports = new Map();

  ws.on("message", async (message) => {
    let payload = null;
    try {
      payload = JSON.parse(message.toString());
    } catch {
      wsSend(ws, "error", null, null, "Invalid JSON");
      return;
    }

    const { action, requestId, data } = payload;

    try {
      if (action === "getRouterRtpCapabilities") {
        console.log("[WS] getRouterRtpCapabilities");
        await ensureMediasoup();
        console.log("[WS] Mediasoup ready, sending capabilities");
        wsSend(ws, action, requestId, mediasoupRouter.rtpCapabilities, null);
        return;
      }

      if (action === "createTransport") {
        console.log("[WS] createTransport");
        await ensureMediasoup();
        const announcedIp = process.env.ANNOUNCED_IP || undefined;
        const tcpOnly = process.env.WEBRTC_TCP_ONLY === "1";
        console.log("[WS] Transport config: announcedIp=", announcedIp, "tcpOnly=", tcpOnly);
        const transport = await mediasoupRouter.createWebRtcTransport({
          listenIps: [{ ip: "0.0.0.0", announcedIp }],
          enableUdp: !tcpOnly,
          enableTcp: true,
          preferUdp: !tcpOnly,
        });
        console.log("[WS] Transport created:", transport.id, "candidates:", transport.iceCandidates.length);
        transports.set(transport.id, transport);
        wsSend(ws, action, requestId, {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        }, null);
        return;
      }

      if (action === "connectTransport") {
        const transport = transports.get(data.transportId);
        if (!transport) throw new Error("Transport not found");
        await transport.connect({ dtlsParameters: data.dtlsParameters });
        wsSend(ws, action, requestId, { connected: true }, null);
        return;
      }

      if (action === "consume") {
        console.log("[WS] consume action started");
        await startWebRtcIngest();
        console.log("[WS] WebRTC ingest started");
        if (!rtpProducer) throw new Error("No producer available");
        console.log("[WS] RTP producer exists:", rtpProducer.id);
        if (!mediasoupRouter.canConsume({
          producerId: rtpProducer.id,
          rtpCapabilities: data.rtpCapabilities,
        })) {
          throw new Error("Cannot consume");
        }

        const transport = transports.get(data.transportId);
        if (!transport) throw new Error("Transport not found");

        const consumer = await transport.consume({
          producerId: rtpProducer.id,
          rtpCapabilities: data.rtpCapabilities,
          paused: false,
        });

        console.log("[WS] Consumer created:", consumer.id);
        activeConsumers.add(consumer);
        consumer.on("transportclose", () => activeConsumers.delete(consumer));
        consumer.on("producerclose", () => activeConsumers.delete(consumer));

        wsSend(ws, action, requestId, {
          id: consumer.id,
          producerId: rtpProducer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        }, null);
        return;
      }

      wsSend(ws, action, requestId, null, "Unknown action");
    } catch (err) {
      console.log("[WS] Action error:", action, err.message);
      wsSend(ws, action, requestId, null, err.message || "Error");
    }
  });

  ws.on("close", () => {
    console.log("[WS] Closed, cleaning up");
    for (const transport of transports.values()) {
      transport.close();
    }
    transports.clear();

    if (activeConsumers.size === 0) {
      stopWebRtcIngest();
    }
  });
});

const PORT = process.env.PORT || 5001;
server.listen(PORT, "0.0.0.0", () =>
  console.log("Backend running on https://0.0.0.0:" + PORT)
);
