FROM node:14-slim

# Install necessary dependencies
RUN apt-get update \
    && apt-get install -y wget gnupg git google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set up the application directory and permissions
RUN mkdir -p /home/node/app
WORKDIR /home/node/app

# Clone repository and set permissions
RUN git clone https://github.com/Asdisarson/wpnova-api.git . \
    && chmod +x .bin/www \
    && chown -R node:node /home/node/app

# Install dependencies and configure environment
RUN npm init -y && \
    npm i puppeteer

# Set user for running the application
USER node

# Default command to start the application
CMD ["node", ".bin/www"]
