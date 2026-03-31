FROM node:24 AS build

RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY src/ src/
COPY build.js tsconfig.json server.ts ./
RUN pnpm run build

FROM node:24-slim

WORKDIR /app
COPY --from=build /app/dist/gateway.js ./gateway.js
COPY healthcheck.js ./healthcheck.js
USER node
EXPOSE 8667 8113
CMD ["node", "gateway.js"]
