FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .
RUN mkdir -p /app/assets

EXPOSE 8080
CMD ["node", "server.js"]
