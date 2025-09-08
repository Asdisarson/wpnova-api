# DigitalOcean Apps Deployment Guide

## Prerequisites
- DigitalOcean account
- GitHub repository with your code
- Environment variables configured

## Deployment Steps

### Option 1: Using DigitalOcean App Platform Dashboard

1. **Connect Repository**
   - Go to DigitalOcean App Platform
   - Click "Create App"
   - Connect your GitHub repository
   - Select the `main` branch

2. **Configure App**
   - App Platform will auto-detect the Dockerfile
   - Set the following environment variables:
     - `NODE_ENV`: `production`
     - `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD`: `true`
     - `PUPPETEER_EXECUTABLE_PATH`: `/usr/bin/chromium-browser`
     - `USERNAME`: (your username - set as secret)
     - `PASSWORD`: (your password - set as secret)
     - `DOWNLOAD_URL`: (your download URL - set as secret)

3. **Deploy**
   - Review configuration
   - Click "Create Resources"
   - Wait for deployment to complete

### Option 2: Using App Spec File

1. **Use the provided `.do/app.yaml`**
   - The app spec is already configured
   - Update the GitHub repository URL if needed
   - Set your environment variables in the DigitalOcean dashboard

2. **Deploy via CLI** (optional)
   ```bash
   doctl apps create --spec .do/app.yaml
   ```

## Environment Variables

Make sure to set these in your DigitalOcean App Platform dashboard:

- `USERNAME`: Your application username
- `PASSWORD`: Your application password  
- `DOWNLOAD_URL`: Your download URL endpoint

## Key Changes Made for DigitalOcean Apps

1. **Alpine Linux Base**: Switched to `node:20-alpine` for smaller image size
2. **Chromium Instead of Chrome**: Uses Alpine's chromium package instead of Google Chrome
3. **No Git Clone**: Removed git clone from Dockerfile (not allowed in App Platform)
4. **Optimized Dependencies**: Only installs production dependencies
5. **Non-root User**: Runs as non-root user for security
6. **Health Check**: Added health check endpoint
7. **Dockerignore**: Optimized build context

## Troubleshooting

### If Puppeteer fails:
- Check that `PUPPETEER_EXECUTABLE_PATH` is set to `/usr/bin/chromium-browser`
- Verify `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` is set to `true`

### If build fails:
- Check the build logs in DigitalOcean dashboard
- Ensure all dependencies are in `package.json`
- Verify `.dockerignore` is excluding unnecessary files

### If app doesn't start:
- Check the runtime logs
- Verify environment variables are set correctly
- Ensure the app is listening on port 3000

## Monitoring

- View logs in the DigitalOcean App Platform dashboard
- Monitor resource usage and scaling
- Set up alerts for errors or high resource usage
