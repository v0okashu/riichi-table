FROM node:22-bookworm-slim
WORKDIR /app
COPY --chown=node:node . .
ENV NODE_ENV=production PORT=8787
USER node
EXPOSE 8787
CMD ["node","server.js"]
