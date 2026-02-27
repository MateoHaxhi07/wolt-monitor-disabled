FROM node:18-slim

# Install only Chromium + minimal deps (no extra fonts to save space)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Tell Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_OPTIONS="--max-old-space-size=256"

# Create app directory
WORKDIR /app

# Create data directory for persistent cookies
RUN mkdir -p /app/data

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install --production && npm cache clean --force

# Copy app code
COPY . .

# Expose port
EXPOSE 3000

# Start
CMD ["node", "index.js"]