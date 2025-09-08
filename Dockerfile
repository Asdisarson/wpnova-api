FROM node:20

# Install necessary dependencies
RUN apt-get update \
    && apt-get install -y wget gnupg curl ca-certificates git fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g npm@10.8.1

# Install ChromeDriver that matches Chrome version
RUN CHROME_VERSION=$(google-chrome --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) \
    && CHROMEDRIVER_VERSION=$(curl -s "https://chromedriver.storage.googleapis.com/LATEST_RELEASE_$CHROME_VERSION") \
    && wget -O /tmp/chromedriver.zip "https://chromedriver.storage.googleapis.com/$CHROMEDRIVER_VERSION/chromedriver_linux64.zip" \
    && unzip /tmp/chromedriver.zip -d /usr/local/bin/ \
    && rm /tmp/chromedriver.zip \
    && chmod +x /usr/local/bin/chromedriver

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
CMD ["node", "bin/www"]

