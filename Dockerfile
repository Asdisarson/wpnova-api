# Use Node.js v20 as the base image
FROM node:20

# Install necessary packages
RUN apt-get update && \
    apt-get install -y wget gnupg git sudo ca-certificates && \
    apt-get update && \
    apt-get install -y chromium fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-khmeros fonts-kacst fonts-freefont-ttf libxss1 --no-install-recommends && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /home/node/fetchapi.wpnova.io

# Clone the repository
RUN git clone https://github.com/Asdisarson/wpnova-api.git .

# Install npm dependencies
RUN npm install

# Install Puppeteer and related packages
RUN npm install puppeteer puppeteer-core @puppeteer/browsers

# Verify Puppeteer installation
RUN node -e "const puppeteer = require('puppeteer'); console.log(`Puppeteer version: ${puppeteer.version()}`);" > PUPPETEER_VERSION && \
    node -e "const puppeteer = require('puppeteer'); console.log(`Executable path: ${puppeteer.executablePath()}`);" > EXECUTABLE_PATH

# Copy the entrypoint script and set permissions
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Set entrypoint and default command
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "bin/www"]
