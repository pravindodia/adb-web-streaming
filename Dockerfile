# Stage 1: Build frontend
FROM node:20 AS frontend-build
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm install
COPY frontend . 
RUN npm run build

# Stage 2: Build and run backend + serve frontend with X11 + audio support
FROM node:20

# Install build tools + system deps for mediasoup + adb + ffmpeg + scrcpy + X11
RUN apt-get update && apt-get install -y \
  build-essential \
  python3 \
  ca-certificates \
  adb \
  ffmpeg \
  wget \
  libstdc++6 \
  libgcc-s1 \
  libsdl2-2.0-0 \
  libusb-1.0-0 \
  pulseaudio \
  libpulse0 \
  alsa-utils \
  xvfb \
  x11-utils \
  dbus \
  dbus-x11 \
  && rm -rf /var/lib/apt/lists/*

# Download and install prebuilt scrcpy binary with server and assets
RUN mkdir -p /opt/scrcpy && \
  cd /opt/scrcpy && \
  wget -q https://github.com/Genymobile/scrcpy/releases/download/v3.3.4/scrcpy-linux-x86_64-v3.3.4.tar.gz && \
  tar -xzf scrcpy-linux-x86_64-v3.3.4.tar.gz && \
  mv scrcpy-linux-x86_64-v3.3.4/* . && \
  chmod +x scrcpy scrcpy-server && \
  rm scrcpy-linux-x86_64-v3.3.4.tar.gz && \
  rm -rf scrcpy-linux-x86_64-v3.3.4 && \
  ln -s /opt/scrcpy/scrcpy /usr/local/bin/scrcpy

# Set environment variables for X11, audio, and scrcpy
ENV DISPLAY=:99
ENV XDG_RUNTIME_DIR=/tmp/xdg
ENV SDL_VIDEODRIVER=x11
ENV SDL_AUDIODRIVER=pulse
ENV PATH="/usr/bin:/opt/scrcpy:$PATH"
ENV SCRCPY_SERVER_PATH=/opt/scrcpy/scrcpy-server

RUN mkdir -p $XDG_RUNTIME_DIR && chmod 700 $XDG_RUNTIME_DIR

WORKDIR /app

# Create startup script that initializes X11 and PulseAudio
RUN printf '#!/bin/bash\nset -e\n\necho "Starting Xvfb virtual display..."\nXvfb :99 -screen 0 1024x768x24 -ac >/dev/null 2>&1 &\nXVFB_PID=$!\nsleep 5\n\necho "Starting PulseAudio..."\npulseaudio -D --load=module-native-protocol-unix --exit-idle-time=-1 2>/dev/null || true\nsleep 1\n\necho "Starting Node backend..."\nexport DISPLAY=:99\nnpm start\n\nkill $XVFB_PID 2>/dev/null || true\n' > /app/start.sh && chmod +x /app/start.sh

COPY backend/package.json backend/package-lock.json ./
RUN npm install --build-from-source

COPY backend .

# Copy SSL certificates for HTTPS support
COPY backend/key.pem /app/key.pem
COPY backend/cert.pem /app/cert.pem

# Copy built frontend static files
COPY --from=frontend-build /frontend/dist public/

EXPOSE 5001
CMD ["/bin/bash", "/app/start.sh"]
