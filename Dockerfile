FROM node:20

# Build arguments for GitHub credentials
ARG GITHUB_USERNAME
ARG GITHUB_PASSWORD

# Install necessary dependencies
RUN apt-get update \
    && apt-get install -y wget gnupg \
     && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable git fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get update \
    && apt-get upgrade -y \
    &&  npm install -g npm@10.8.1


WORKDIR /home/node/app

# Install only production dependencies first (align with DO sample layering)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy the rest of the app
COPY . .

# Ensure ownership for node user
RUN mkdir -p /home/node/.cache && chown -R node:node /home/node/app /home/node/.cache
USER node

# Configure Puppeteer to use installed Chrome
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/google-chrome-stable"

ENV PORT=8080

EXPOSE 8080

# Default command to start the application
CMD ["npm", "start"]

