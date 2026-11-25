FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && install -d -o node -g node /app/data
COPY engine ./engine
COPY server.js accounts.js room-store.js league.js replay-data.js drills.js drill-bank.json index.html account-ui.js replay.js drill-ui.js tiles.js meshes.js table.css faces.png author-payment.jpg tiles.glb tiles.glb.gz ./
ENV NODE_ENV=production PORT=8787 RIICHI_DATA_DIR=/app/data
USER node
EXPOSE 8787
CMD ["node","server.js"]
