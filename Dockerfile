FROM node:22-alpine
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app
COPY package.json server.js seed.json ./
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/state >/dev/null || exit 1
CMD ["node", "server.js"]
