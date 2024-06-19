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
    node -e "const puppeteer = require('puppeteer'); console.log(\`Puppeteer version: \${puppeteer.version()}\`);" > PUPPETEER_VERSION && \
    node -e "const puppeteer = require('puppeteer'); console.log(\`Executable path: \${puppeteer.executablePath()}\`);" > EXECUTABLE_PATH

# Install the repository's npm dependencies
RUN npm install

# Expose the port the app runs on
EXPOSE 3000

# Switch back to the node user
USER node

# Start the app
CMD ["node", "bin/www"]
