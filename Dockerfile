FROM node:24 AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src/ src/
COPY build.js tsconfig.json server.ts ./
RUN npm run build

FROM node:24-slim

WORKDIR /app
COPY --from=build /app/dist/gateway.js ./gateway.js
USER node
EXPOSE 8667 8113
CMD ["node", "gateway.js"]
