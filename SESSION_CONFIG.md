# Session Management Configuration

This application now supports persistent browser sessions using Browserless reconnection API. This significantly improves performance by reusing logged-in sessions across multiple requests.

## Browser Creation Fallback Hierarchy

The system now uses a progressive fallback approach for browser creation:

1. **Regular Puppeteer** (fastest, cheapest)
   - Uses local Chrome/Chromium installation
   - No additional costs
   - Fails if Cloudflare protection is detected

2. **Browserless WebSocket** (when Cloudflare blocks regular browser)
   - Standard Browserless cloud service
   - Uses existing session management with `Browserless.reconnect`
   - More expensive but handles Cloudflare challenges

3. **Browserless Unblock API** (last resort)
   - Pre-unblocked browser session specifically for anti-bot protection
   - Most expensive but most reliable
   - Only used when both methods above fail

## Environment Variables

Add these to your `.env` file to configure session management:

### Required Variables

```bash
# Authentication credentials for RealGPL
USERNAME=your_username_here
PASSWORD=your_password_here

# Browserless API token
BROWSERLESS_API_TOKEN=your_browserless_token_here
```

### Session Configuration (Optional)

```bash
# Browserless reconnection timeout (milliseconds)
# How long the browser instance stays alive after disconnecting
# Free plan: 10000 (10 seconds max)
# Starter plan: 60000 (1 minute max)  
# Scale plan: 300000 (5 minutes max)
# Default: 60000 (1 minute)
BROWSERLESS_RECONNECT_TIMEOUT=60000

# Maximum session age (milliseconds)
# After this time, create a fresh session even if reconnection is possible
# Default: 1800000 (30 minutes)
SESSION_MAX_AGE=1800000

# Session idle timeout (milliseconds)
# Close session after this period of inactivity
# Default: 300000 (5 minutes)
SESSION_IDLE_TIMEOUT=300000
```

## How It Works

### First Request
1. Creates new browser session
2. Logs in to RealGPL
3. Downloads products
4. **Disconnects but keeps session alive** for reconnection

### Subsequent Requests (within timeout)
1. **Reconnects to existing session** (already logged in!)
2. Downloads products immediately
3. Disconnects but keeps session alive

### Benefits

- ✅ **No repeated logins** - Login once, reuse for multiple requests
- ✅ **Faster execution** - Skip navigation and login steps
- ✅ **Less Browserless usage** - Reuse same browser instance
- ✅ **Better reliability** - Maintain stable session state

## Session Lifecycle

```
Request 1: [Create] → [Login] → [Download] → [Disconnect & Keep Alive]
                                                     ↓
                                            (Session alive for 60s)
                                                     ↓
Request 2: ──────────→ [Reconnect] → [Download] → [Disconnect & Keep Alive]
                                                     ↓
                                            (Session alive for 60s)
                                                     ↓
Request 3: ──────────→ [Reconnect] → [Download] → [Disconnect & Keep Alive]
```

If no requests are made within the reconnection timeout, the session expires and a new one will be created on the next request.

## Browserless Plan Limits

| Plan              | Max Reconnection Timeout | Overall Session Timeout |
|-------------------|--------------------------|-------------------------|
| Free              | 10 seconds               | 60 seconds              |
| Prototyping/Starter | 1 minute               | 15-30 minutes           |
| Scale             | 5 minutes                | 60 minutes              |

Set your `BROWSERLESS_RECONNECT_TIMEOUT` according to your plan limits.

## Session States

The session manager tracks the following states:

- **Active**: Browser session is running and connected
- **Disconnected**: Browser session is alive but not connected (available for reconnection)
- **Logged In**: Session has valid authentication
- **Expired**: Session too old or reconnection timeout exceeded
- **Idle**: No activity for idle timeout period

## API Endpoints

### GET /refresh?date=YYYY-MM-DD
Download products from changelog for a specific date.

**Example:**
```bash
curl "http://localhost:3000/refresh?date=2024-10-14"
```

On first call: Creates session, logs in, downloads
On subsequent calls (within 60s): Reuses session, skips login, downloads immediately

### GET /download-all?date=YYYY-MM-DD
Download all products from changelog.

**Example:**
```bash
curl "http://localhost:3000/download-all?date=2024-10-14"
```

## Monitoring Sessions

The session manager logs detailed information:

- `♻️ Reusing existing browser session` - Reconnected successfully
- `🆕 Creating new browser session` - Creating fresh session
- `✅ Session marked as logged in` - Login successful
- `🔌 Session disconnected (kept alive for reconnection)` - Session available for reuse
- `💤 Session idle timeout reached` - Session closed due to inactivity
- `⏰ Session expired` - Session too old, creating new one

## Troubleshooting

### Sessions not persisting

- Check your Browserless plan limits
- Verify `BROWSERLESS_RECONNECT_TIMEOUT` is within your plan's max
- Ensure requests are made within the reconnection window

### "Session expired" errors

- Increase `SESSION_MAX_AGE` if sessions are closing too soon
- Check that reconnection timeout hasn't elapsed between requests

### Memory issues

- Decrease `SESSION_MAX_AGE` to close sessions more frequently
- Decrease `SESSION_IDLE_TIMEOUT` to cleanup inactive sessions faster

## References

- [Browserless Session Management Documentation](https://docs.browserless.io/baas/session-management/standard-sessions)
- [Browserless CDP Commands](https://docs.browserless.io/baas/session-management/persisting-state)

