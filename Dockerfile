FROM node:20

# Install necessary dependencies
RUN apt-get update \
    && apt-get install -y wget gnupg \
    # && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
   # && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable git fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set up the application directory and permissions
RUN mkdir -p /home/node/app
WORKDIR /home/node/app

# Clone repository and set permissions
RUN git clone https://github.com/Asdisarson/wpnova-api.git . \
    && (chmod +x .bin/www || true) \
    && chown -R node:node /home/node/app

# Install dependencies and configure environment
RUN npm init -y && \
    npm i puppeteer \
    npm install \


# Set user for running the application
USER node

# Default command to start the application
CMD ["node", ".bin/www"]
