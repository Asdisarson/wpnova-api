# Use Node.js v20 as the base image
FROM node:20

# Update package lists and install necessary packages
RUN apt-get update && \
    apt-get install -y wget gnupg git sudo && \
    wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg && \
    sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' && \
    apt-get update && \
    apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-khmeros fonts-kacst fonts-freefont-ttf libxss1 --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Add node user to the sudo group and set up password-less sudo
RUN usermod -aG sudo node && \
    echo 'node ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# Clone the specified repository as the node user
USER node
RUN git clone https://github.com/Asdisarson/wpnova-api.git /home/node/fetchapi.wpnova.io

# Set the working directory
WORKDIR /home/node/fetchapi.wpnova.io

# Install Puppeteer and related packages
RUN  npm install puppeteer puppeteer-core @puppeteer/browsers && \
    (node -e "require('child_process').execSync(require('puppeteer').executablePath() + ' --credits', {stdio: 'inherit'})" > THIRD_PARTY_NOTICES)

# Install the repository's npm dependencies
RUN  npm install

# Set the default command to run when the container starts
CMD ["node", "bin/www"]