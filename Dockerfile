FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY migrations ./migrations

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["sh", "-c", "node src/migrate.js && node src/server.js"]