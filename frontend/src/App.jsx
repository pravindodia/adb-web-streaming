import React, { useEffect, useRef, useState } from "react";
import * as mediasoupClient from "mediasoup-client";
import "./App.css";

const FORCE_HTTPS = String(import.meta.env?.VITE_FORCE_HTTPS || "").toLowerCase() === "true";
const BASE_PROTOCOL = FORCE_HTTPS ? "https" : window.location.protocol.replace(":", "");
const DEFAULT_API = `${BASE_PROTOCOL}://${window.location.hostname}:5001`;
const API = import.meta.env?.VITE_API_URL || DEFAULT_API;
const WS_BASE = import.meta.env?.VITE_WS_URL || API.replace(/^http/, "ws");
const ICE_SERVERS = [];
const DEBUG = import.meta.env?.DEV === true;
const SESSION_TTL_MIN = Number(import.meta.env?.VITE_SESSION_TIMEOUT_MIN || 0);
const SESSION_WARNING_MIN = Number(import.meta.env?.VITE_SESSION_WARNING_MIN || 2);

export default function App() {
  const [token, setToken] = useState(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [ip, setIp] = useState("127.0.0.1");
  const [port, setPort] = useState("5555");
  const [output, setOutput] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [devices, setDevices] = useState([]);
  const [connected, setConnected] = useState(false);
  const [activeDevice, setActiveDevice] = useState(null);
  const [rtcStatus, setRtcStatus] = useState("disconnected");
  const [textInput, setTextInput] = useState("");
  const [deviceSize, setDeviceSize] = useState({ width: 1080, height: 1920 });
  const [lastDevice, setLastDevice] = useState(null);
  const [videoReady, setVideoReady] = useState(false);
  const [sessionWarning, setSessionWarning] = useState("");
  const [sessionWarningMin, setSessionWarningMin] = useState(SESSION_WARNING_MIN);
  const gestureRef = useRef({ startX: 0, startY: 0, startTime: 0 });
  const videoRef = useRef(null);
  const wsRef = useRef(null);
  const transportRef = useRef(null);
  const sessionTimerRef = useRef(null);
  const sessionWarningRef = useRef(null);

  const debugLog = (...args) => {
    if (DEBUG) {
      console.log(...args);
    }
  };

  function parseJwtPayload(value) {
    try {
      const payload = value.split(".")[1];
      const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
      const decoded = atob(normalized);
      return JSON.parse(decoded);
    } catch {
      return null;
    }
  }

  function clearSessionTimer() {
    if (sessionTimerRef.current) {
      clearTimeout(sessionTimerRef.current);
      sessionTimerRef.current = null;
    }
    if (sessionWarningRef.current) {
      clearTimeout(sessionWarningRef.current);
      sessionWarningRef.current = null;
    }
  }

  function setSessionWarningTimer(ms) {
    if (ms <= 0) return;
    setSessionWarning("");
    sessionWarningRef.current = setTimeout(() => {
      setSessionWarning("Session expiring soon. Save your work.");
    }, ms);
  }

  function isTokenExpired(value) {
    const payload = parseJwtPayload(value);
    if (!payload?.exp) return false;
    return Date.now() >= payload.exp * 1000;
  }

  function scheduleSessionTimeout(value) {
    clearSessionTimer();
    if (!value) return;
    const payload = parseJwtPayload(value);
    const expMs = payload?.exp ? payload.exp * 1000 : null;
    const now = Date.now();
    let ttlMs = expMs ? expMs - now : null;

    if (SESSION_TTL_MIN > 0) {
      ttlMs = SESSION_TTL_MIN * 60 * 1000;
    }

    if (!ttlMs || ttlMs <= 0) {
      handleSessionExpired();
      return;
    }

    const warnAtMs = Math.max(0, ttlMs - sessionWarningMin * 60 * 1000);
    setSessionWarningTimer(warnAtMs);
    sessionTimerRef.current = setTimeout(handleSessionExpired, ttlMs);
  }

  function applyLastDevice(value) {
    if (!value) return;
    const [savedIp, savedPort] = value.split(":");
    if (savedIp) setIp(savedIp);
    if (savedPort) setPort(savedPort);
  }

  async function login() {
    setLoginError("");
    const res = await fetch(API + "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) {
      setLoginError(data?.error || "Login failed");
      return;
    }
    setToken(data.token);
    localStorage.setItem("adbToken", data.token);
    scheduleSessionTimeout(data.token);
    if (Number.isFinite(data.sessionWarningMin)) {
      setSessionWarningMin(Number(data.sessionWarningMin));
    }
    if (data.lastDevice) {
      setLastDevice(data.lastDevice);
      applyLastDevice(data.lastDevice);
    }
  }

  function logout() {
    clearSessionTimer();
    setToken(null);
    setDevices([]);
    setConnected(false);
    setActiveDevice(null);
    setRtcStatus("disconnected");
    localStorage.removeItem("adbToken");
  }

  async function handleSessionExpired() {
    if (connected) {
      try {
        await disconnect();
      } catch {
        // Ignore disconnect errors on session expiry.
      }
    }
    setLoginError("Session expired. Please sign in again.");
    setSessionWarning("");
    logout();
  }

  async function fetchDevices() {
    const res = await fetch(API + "/devices", {
      headers: { Authorization: "Bearer " + token }
    });
    const data = await res.json();
    const list = Array.isArray(data.devices) ? data.devices : [];
    setDevices(list);
    const selected = data.activeDevice || (list[0] && list[0].id) || null;
    setActiveDevice(selected);
    setConnected(Boolean(selected));
    setOutput(JSON.stringify(data, null, 2));
    if (data.lastDevice) {
      setLastDevice(data.lastDevice);
      applyLastDevice(data.lastDevice);
    }
    if (selected) {
      fetchDeviceInfo();
    }
  }

  async function fetchDeviceInfo() {
    if (!token) return;
    try {
      const res = await fetch(API + "/device-info", {
        headers: { Authorization: "Bearer " + token }
      });
      const data = await res.json();
      if (res.ok && data?.size?.width && data?.size?.height) {
        setDeviceSize({ width: data.size.width, height: data.size.height });
      }
    } catch (err) {
        console.error("Device info failed:", err.message);
    }
  }

  async function connect() {
    const res = await fetch(API + "/connect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token
      },
      body: JSON.stringify({ ip, port })
    });
    const data = await res.json();
    setOutput(JSON.stringify(data, null, 2));
    await fetchDevices();
    localStorage.setItem("adbIp", ip);
    localStorage.setItem("adbPort", port);
    await fetchDeviceInfo();
  }

  async function disconnect() {
    const res = await fetch(API + "/disconnect", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token
      },
      body: JSON.stringify({ ip, port })
    });
    const data = await res.json();
    setOutput(JSON.stringify(data, null, 2));
    setDevices([]);
    setConnected(false);
    setActiveDevice(null);
  }

  async function sendTap(x, y) {
    try {
      debugLog(`📤 Sending TAP: (${x}, ${y})`);
      const response = await fetch(API + "/tap", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify({ x, y })
      });
      
      if (!response.ok) {
        console.error(`❌ Tap failed: HTTP ${response.status}`);
      } else {
        debugLog(`✅ Tap accepted`);
      }
    } catch (err) {
      console.error("❌ Tap error:", err.message);
    }
  }

  async function sendText() {
    if (!textInput) return;
    try {
      await fetch(API + "/text", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify({ text: textInput })
      });
      setTextInput("");
    } catch (err) {
      console.error("Text failed:", err.message);
    }
  }

  async function sendKey(code) {
    try {
      await fetch(API + "/key", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify({ code })
      });
    } catch (err) {
      console.error("Key failed:", err.message);
    }
  }

  function getDeviceCoordinates(clientX, clientY) {
    if (!videoRef.current) return null;
    const rect = videoRef.current.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      debugLog("❌ Video not ready, rect:", rect.width, rect.height);
      return null;
    }
    
    // Get tap position within the displayed video element
    const relX = clientX - rect.left;
    const relY = clientY - rect.top;
    
    // Clamp to video bounds
    if (relX < 0 || relX > rect.width || relY < 0 || relY > rect.height) {
      debugLog("❌ Click outside video area", { relX, relY, rectW: rect.width, rectH: rect.height });
      return null;
    }
    
    // Calculate scaling factors
    // Display size: rect.width × rect.height (e.g., 448×800)
    // Device size: deviceSize.width × deviceSize.height
    const scaleX = deviceSize.width / rect.width;
    const scaleY = deviceSize.height / rect.height;
    
    // Scale tap coordinates to device resolution
    const deviceX = Math.round(relX * scaleX);
    const deviceY = Math.round(relY * scaleY);
    
    debugLog(`📐 Coords: display=(${relX.toFixed(0)},${relY.toFixed(0)}) displaySize=(${rect.width.toFixed(0)},${rect.height.toFixed(0)}) scale=(${scaleX.toFixed(2)},${scaleY.toFixed(2)}) device=(${deviceX},${deviceY})`);
    
    return {
      x: Math.max(0, Math.min(deviceSize.width, deviceX)),
      y: Math.max(0, Math.min(deviceSize.height, deviceY))
    };
  }

  function handleVideoClick(e) {
    const coords = getDeviceCoordinates(e.clientX, e.clientY);
    if (!coords) return;
    debugLog("Tap at", coords.x, coords.y);
    sendTap(coords.x, coords.y);
  }

  async function home() {
    await sendKey(3);
  }

  async function back() {
    await sendKey(4);
  }

  async function power() {
    await sendKey(26);
  }

  async function recentApps() {
    await sendKey(187);
  }

  async function toggleKeyboard() {
    try {
      await fetch(API + "/key", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify({ code: 284 })
      });
    } catch (err) {
      console.error("Toggle keyboard failed:", err.message);
    }
  }

  async function sendSwipe(x1, y1, x2, y2, duration = 300) {
    const distance = Math.sqrt((x2-x1)*(x2-x1) + (y2-y1)*(y2-y1));
    debugLog(`🔄 Swipe: (${x1},${y1}) → (${x2},${y2}), distance=${distance.toFixed(0)}, duration=${duration}ms`);
    
    try {
      const response = await fetch(API + "/swipe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token
        },
        body: JSON.stringify({ x1, y1, x2, y2, duration })
      });
      
      if (response.ok) {
        debugLog(`✅ Swipe sent successfully`);
      } else {
        console.error(`❌ Swipe failed: HTTP ${response.status}`);
      }
    } catch (err) {
      console.error(`❌ Swipe error: ${err.message}`);
    }
  }

  function handleVideoMouseDown(e) {
    if (!connected) return;
    e.preventDefault?.();
    gestureRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTime: Date.now(),
    };
  }

  function handleVideoMouseUp(e) {
    if (!connected) return;
    e.preventDefault?.();
    
    const { startX, startY, startTime } = gestureRef.current;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const dt = Date.now() - startTime;
    const distance = Math.sqrt(dx * dx + dy * dy);

    const startCoords = getDeviceCoordinates(startX, startY);
    const endCoords = getDeviceCoordinates(e.clientX, e.clientY);
    
    // Reject if either coordinate is outside video area
    if (!startCoords || !endCoords) {
      debugLog("❌ Click/gesture outside video area");
      return;
    }

    debugLog(`📍 Gesture: screen=(${dx.toFixed(0)}, ${dy.toFixed(0)}) px, time=${dt}ms, distance=${distance.toFixed(0)}px`);
    debugLog(`   Start: (${startCoords.x}, ${startCoords.y}) → End: (${endCoords.x}, ${endCoords.y})`);

    // Distinguish gesture types by distance and duration
    // Swipe: distance > 25 pixels on screen, time < 1200ms
    if (distance > 25 && dt < 1200) {
      debugLog(`✨ SWIPE detected`);
      sendSwipe(startCoords.x, startCoords.y, endCoords.x, endCoords.y, dt);
    } 
    // Tap: distance < 10 pixels on screen
    else if (distance < 10) {
      debugLog(`👆 TAP detected`);
      sendTap(startCoords.x, startCoords.y);
    } else {
      debugLog(`⏸️ Ambiguous gesture (distance=${distance.toFixed(0)}px, time=${dt}ms) - ignoring`);
    }
  }

  function handleVideoReady() {
    setVideoReady(true);
  }

  useEffect(() => {
    if (token) {
      fetchDevices();
    }
  }, [token]);

  useEffect(() => {
    const savedToken = localStorage.getItem("adbToken");
    const savedIp = localStorage.getItem("adbIp");
    const savedPort = localStorage.getItem("adbPort");
    if (savedToken) {
      if (isTokenExpired(savedToken)) {
        localStorage.removeItem("adbToken");
      } else {
        setToken(savedToken);
        scheduleSessionTimeout(savedToken);
      }
    }
    if (savedIp) {
      setIp(savedIp);
    }
    if (savedPort) {
      setPort(savedPort);
    }
  }, []);

  useEffect(() => {
    if (token) {
      scheduleSessionTimeout(token);
    } else {
      clearSessionTimer();
    }
    return () => {
      clearSessionTimer();
    };
  }, [token]);

  useEffect(() => {
    if (!connected) {
      setVideoReady(false);
    }
  }, [connected]);

  useEffect(() => {
    let cancelled = false;

    async function startWebRtc() {
      if (!token || !connected) {
        debugLog("[WebRTC] Not starting - token:", !!token, "connected:", connected);
        return;
      }
      debugLog("[WebRTC] Starting WebRTC connection...");
      const wsUrl = WS_BASE.replace(/\/+$/, "") + "/ws?token=" + encodeURIComponent(token);
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      let requestId = 1;
      const pending = new Map();

      function request(action, data) {
        return new Promise((resolve, reject) => {
          const id = requestId++;
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ action, requestId: id, data }));
        });
      }

      ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        const handler = pending.get(message.requestId);
        if (!handler) return;
        pending.delete(message.requestId);
        if (message.error) {
          handler.reject(new Error(message.error));
          return;
        }
        handler.resolve(message.data);
      };

      ws.onopen = async () => {
        try {
          setRtcStatus("connecting");
          const routerRtpCapabilities = await request("getRouterRtpCapabilities");
          const device = new mediasoupClient.Device();
          await device.load({ routerRtpCapabilities });

          const transportData = await request("createTransport");
          const transport = device.createRecvTransport({
            ...transportData,
            iceServers: ICE_SERVERS,
          });
          transportRef.current = transport;

          transport.on("connect", ({ dtlsParameters }, callback, errback) => {
            request("connectTransport", {
              transportId: transport.id,
              dtlsParameters,
            }).then(callback).catch(errback);
          });

          transport.on("connectionstatechange", (state) => {
            if (!cancelled) {
              setRtcStatus(state);
            }
          });

          const consumerData = await request("consume", {
            transportId: transport.id,
            rtpCapabilities: device.rtpCapabilities,
          });

          const consumer = await transport.consume({
            id: consumerData.id,
            producerId: consumerData.producerId,
            kind: consumerData.kind,
            rtpParameters: consumerData.rtpParameters,
          });

          const stream = new MediaStream([consumer.track]);
          if (videoRef.current) {
            videoRef.current.srcObject = stream;
            await videoRef.current.play().catch(() => {});
          }

          if (!cancelled) {
            setRtcStatus("connected");
          }
        } catch (err) {
          if (!cancelled) {
            setRtcStatus("error");
            setOutput(JSON.stringify({ error: err.message }, null, 2));
          }
        }
      };

      ws.onclose = () => {
        if (!cancelled) {
          setRtcStatus("disconnected");
        }
      };

      ws.onerror = () => {
        if (!cancelled) {
          setRtcStatus("error");
        }
      };
    }

    startWebRtc();

    return () => {
      cancelled = true;
      if (transportRef.current) {
        transportRef.current.close();
        transportRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [token, connected, activeDevice]);

  if (!token) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <div className="brand" style={{ marginBottom: "16px" }}>
            <div className="brand-badge">ADB</div>
            <div>
              <div className="brand-title">Control Console</div>
              <div className="login-subtitle">Secure device access</div>
            </div>
          </div>

          <h2 className="login-title">Welcome back</h2>
          <p className="login-subtitle">Sign in to connect and stream your emulator.</p>

          {loginError ? <div className="alert">{loginError}</div> : null}

          <div className="field">
            <label>Username</label>
            <input
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter username"
            />
          </div>

          <div className="field">
            <label>Password</label>
            <input
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              type="password"
            />
          </div>

          <div className="button-row">
            <button className="button" onClick={login}>Sign In</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-badge">ADB</div>
          <div>
            <div className="brand-title">Device Control Console</div>
            <div className="helper">Low-latency streaming + direct ADB control</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <div className="status-chip">
            <span className={`status-dot ${connected ? "online" : "offline"}`} />
            {connected ? "Connected" : "Disconnected"}
          </div>
          <button className="button secondary" onClick={logout}>Logout</button>
        </div>
      </header>

      {sessionWarning ? (
        <div className="session-banner">
          <div className="session-banner-dot" />
          {sessionWarning}
        </div>
      ) : null}

      <main className="app-main">
        <section className="panel card-row">
          <div>
            <h3 className="panel-title">Connection</h3>
            <div className="device-status">
              <span>Active device</span>
              <strong>{connected ? (devices.find(d => d.id === activeDevice)?.name || activeDevice) : "None"}</strong>
            </div>
          </div>

          <div>
            <h3 className="panel-title">Connect Emulator</h3>
            {connected ? (
              <div className="button-row">
                <button className="button secondary" onClick={disconnect}>Disconnect</button>
              </div>
            ) : (
              <>
                <div className="field">
                  <label>IP Address</label>
                  <input className="input" value={ip} onChange={e => setIp(e.target.value)} />
                </div>
                <div className="field">
                  <label>Port</label>
                  <input className="input" value={port} onChange={e => setPort(e.target.value)} />
                </div>
                <div className="button-row">
                  <button className="button" onClick={connect}>Connect</button>
                </div>
                {lastDevice ? (
                  <div className="helper">Last device: {lastDevice}</div>
                ) : null}
              </>
            )}
          </div>

          <div>
            <h3 className="panel-title">Controls</h3>
            <div className="button-row">
              <button className="button secondary" onClick={back}>BACK</button>
              <button className="button secondary" onClick={home}>HOME</button>
              <button className="button secondary" onClick={recentApps}>RECENT</button>
              <button className="button secondary" onClick={power}>POWER</button>
              <button className="button secondary" onClick={toggleKeyboard}>KEYBOARD</button>
            </div>
          </div>

          <div>
            <h3 className="panel-title">Text Input</h3>
            <div className="button-row">
              <input
                className="input"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                onKeyPress={(e) => { if (e.key === "Enter") sendText(); }}
                placeholder="Type text..."
                type="text"
                style={{ flex: 1, minWidth: "200px" }}
              />
              <button className="button" onClick={sendText}>Send</button>
            </div>
          </div>

          <div>
            <h3 className="panel-title">Logs</h3>
            <div className="button-row" style={{ marginBottom: "10px" }}>
              <button className="button ghost" onClick={() => setShowLogs(!showLogs)}>
                {showLogs ? "Hide Logs" : "Show Logs"}
              </button>
            </div>
            {showLogs ? <pre className="logs">{output}</pre> : null}
          </div>
        </section>

        <section className="panel video-shell">
          <h3 className="panel-title">Live Emulator</h3>
          {connected ? (
            <>
              <div className="video-wrapper">
                <video
                  ref={videoRef}
                  className="video-frame"
                  width="448"
                  height="800"
                  autoPlay
                  playsInline
                  muted
                  onLoadedData={handleVideoReady}
                  onPlaying={handleVideoReady}
                  onMouseDown={handleVideoMouseDown}
                  onMouseUp={handleVideoMouseUp}
                />
                {!videoReady ? (
                  <div className="video-loader">
                    <div className="spinner" />
                    <div className="loader-text">Starting stream...</div>
                  </div>
                ) : null}
              </div>
              <p className="helper">Tap to click, swipe to navigate. Stream: {rtcStatus}</p>
            </>
          ) : (
            <div className="device-status">No connected devices.</div>
          )}
        </section>
      </main>

      <footer className="app-footer">
        Status: {connected ? "Connected" : "Disconnected"} • Stream: {rtcStatus}
      </footer>
    </div>
  );
}
