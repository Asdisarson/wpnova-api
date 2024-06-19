# Use Node.js v20 as the base image
FROM node:20

# Update package lists and install necessary packages
RUN apt-get update && \
    apt-get install -y wget gnupg git sudo ca-certificates && \
    apt-get update && \
    apt-get install -y chromium fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-khmeros fonts-kacst fonts-freefont-ttf libxss1 --no-install-recommends && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g npm@10.4.0

# Add node user to the sudo group and set up password-less sudo
RUN usermod -aG sudo node && \
    echo 'node ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# Clone the specified repository as the node user
USER node
RUN git clone https://github.com/Asdisarson/wpnova-api.git /home/node/fetchapi.wpnova.io

# Set the working directory
WORKDIR /home/node/fetchapi.wpnova.io

# Install Puppeteer and related packages
RUN npm install puppeteer puppeteer-core @puppeteer/browsers && \
    (node -e "const puppeteer = require('puppeteer'); console.log(`Puppeteer version: ${puppeteer.version()}`);" > PUPPETEER_VERSION) && \
    (node -e "const puppeteer = require('puppeteer'); console.log(`Executable path: ${puppeteer.executablePath()}`);" > EXECUTABLE_PATH)

# Install the repository's npm dependencies
RUN npm install

# Switch back to the root user to copy the entrypoint script and change permissions
USER root

# Copy the entrypoint script (assume you have docker-entrypoint.sh in your context)
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Switch back to the node user
USER node

# Set the entrypoint and default command
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "bin/www"]
