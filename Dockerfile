FROM node:24-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY .env.example ./

# Data lives in MySQL: set DATABASE_URL (or MYSQL_HOST, MYSQL_USER, ...) when you run the container.
ENV NODE_ENV=production \
    PORT=3000 \
    TRUST_PROXY=1
EXPOSE 3000

CMD ["node", "src/server.js"]
