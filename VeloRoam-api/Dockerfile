# Stage 1: Build the application
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

COPY package*.json tsconfig.json ./

RUN npm ci

COPY src ./src

RUN npm run build

# Stage 2: Production image
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --only=production

COPY --from=builder /usr/src/app/dist ./dist
COPY sql ./sql

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
