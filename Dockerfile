# Single-stage build — install ffmpeg directly from apt to ensure
# shared library compatibility (OpenSSL 3, Ubuntu 22.04)
FROM node:20-slim

# Install ffmpeg, Python, pip, and fonts in one layer
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Layer 1: Node deps (cached until package.json changes) ──────────────────
COPY package*.json ./
RUN npm ci --omit=dev

# ── Layer 2: Python deps (cached until requirements.txt changes) ─────────────
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --only-binary=:all: -r requirements.txt --break-system-packages

# ── Layer 3: Source code (invalidated on every push — but layers above stay cached) ──
COPY . .

ENV NODE_ENV=production
ENV PYTHON_PATH=python3
ENV WORKERS_PATH=/app/src/workers
ENV TEMP_DIR=/tmp/vox_jobs

CMD ["node", "src/index.js"]
