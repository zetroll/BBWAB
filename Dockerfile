FROM node:20-slim

WORKDIR /app

# copy manifests (package-lock.json may or may not exist)
COPY package.json package-lock.json* ./

# prefer npm ci when lockfile present; fall back to npm install otherwise
RUN if [ -f package-lock.json ]; then npm ci --only=production; else npm install --omit=dev --no-audit --no-fund; fi

# copy rest of repo
COPY . .

# ensure assets folder exists (empty - add your PDF later)
RUN mkdir -p /app/assets

EXPOSE 8080
CMD ["node", "server.js"]
