FROM node:20

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
    && apt-get install -y nodejs \
    && npm install npm@latest


# Set up the application directory and permissions
RUN mkdir -p /home/node/app
WORKDIR /home/node/app


# Clone repository and set permissions
RUN git clone https://github.com/Asdisarson/wpnova-api.git . \
    && chown -R node:node /home/node/app

# Install dependencies and configure environment as root
RUN npm init -y && \
    npm i puppeteer@latest

# Ensure Puppeteer's cache directory exists and has correct permissions
RUN mkdir -p /home/node/.cache \
    && chown -R node:node /home/node/app /home/node/app/node_modules /home/node/.cache

# Set user for running the application
USER node

# Configure Puppeteer to use installed Chrome
ENV PUPPETEER_EXECUTABLE_PATH="/usr/bin/google-chrome-stable"

# Default command to start the application
CMD ["node", ".bin/www"]

