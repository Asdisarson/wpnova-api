FROM node:14-slim

# Install latest chrome dev package and fonts to support major charsets (Chinese, Japanese, Arabic, Hebrew, Thai and a few others)
# Note: this installs the necessary libs to make the bundled version of Chromium that Puppeteer
# installs, work.
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y git google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Add node user to the sudo group and set up password-less sudo
RUN usermod -aG sudo node && \
    echo 'node ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# Clone the specified repository as the node user
USER node
# If running Docker >= 1.13.0 use docker run's --init arg to reap zombie processes, otherwise
# uncomment the following lines to have `dumb-init` as PID 1
RUN git clone https://github.com/Asdisarson/wpnova-api.git /home/node/fetchapi.wpnova.io

# Set the working directory
 RUN chmod +x /home/node/fetchapi.wpnova.io
ENTRYPOINT ["fetchapi-wpnova-io", "--"]
WORKDIR /home/node/fetchapi.wpnova.io

# Uncomment to skip the chromium download when installing puppeteer. If you do,
# you'll need to launch puppeteer with:
#browser.launch({executablePath: 'google-chrome-stable'})
#ENV PUPPETEER_SKIP_DOWNLOAD true

# Install puppeteer so it's available in the container.
RUN npm init -y &&  \
    npm i puppeteer \
    # Add user so we don't need --no-sandbox.
    # same layer as npm install to keep re-chowned files from using up several hundred MBs more space
    && groupadd -r node && useradd -r -g node -G audio,video node \
    && mkdir -p /home/node/Downloads \
    && chown -R node:node /home/node \
    && chown -R node:node /node_modules \
    && chown -R node:node /package.json \
    && chown -R node:node /package-lock.json

# Run everything after as non-privileged user.
USER node

CMD ["node", ".bin/www"]