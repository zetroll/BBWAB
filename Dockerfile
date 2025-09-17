FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --only=production

COPY . .
RUN mkdir -p /app/assets

EXPOSE 8080
CMD ["node", "server.js"]
