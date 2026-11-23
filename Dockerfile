FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY .env.example ./

# Keep the SQLite file on a mounted volume so data survives redeploys.
ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/app.db \
    TRUST_PROXY=1
VOLUME /data
EXPOSE 3000

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
