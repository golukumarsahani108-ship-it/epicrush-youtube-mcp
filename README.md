# EpicRush YouTube MCP (OAuth version)

This version uses an OAuth 2.1 Authorization Code + PKCE flow for Claude's remote MCP connector. Google OAuth remains separate and is used only to access the YouTube channel.

## Render environment variables

Keep these in Render Environment, never in GitHub:

- `PUBLIC_BASE_URL` = `https://epicrush-youtube-mcp.onrender.com`
- `MCP_OAUTH_SIGNING_SECRET` = a newly generated random secret (at least 32 characters)
- `MCP_OAUTH_ADMIN_PASSWORD` = a strong private password you choose; Claude's connection approval page will ask for it
- `GOOGLE_CLIENT_ID` = existing Google OAuth client ID
- `GOOGLE_CLIENT_SECRET` = existing Google OAuth client secret
- `YOUTUBE_REFRESH_TOKEN` = existing YouTube refresh token

Do not use the old `MCP_ACCESS_TOKEN`; this OAuth version does not need it.

## Deploy

1. Replace the repository files with the files in this ZIP.
2. Commit/push to the existing GitHub repository's `main` branch.
3. In Render, add the two new variables `MCP_OAUTH_SIGNING_SECRET` and `MCP_OAUTH_ADMIN_PASSWORD`. Keep the existing Google variables.
4. Confirm `PUBLIC_BASE_URL` is correct, then deploy.
5. Check `https://epicrush-youtube-mcp.onrender.com/health`.
6. Open `https://epicrush-youtube-mcp.onrender.com/google/auth` once and authorize the Google account that owns the YouTube channel. This version requests both `youtube.upload` and `youtube.readonly`. If Google returns a new refresh token, update `YOUTUBE_REFRESH_TOKEN` in Render and redeploy.
7. In Claude, add a custom connector:
   - Name: `EpicRush YouTube`
   - URL: `https://epicrush-youtube-mcp.onrender.com/mcp`
   - Choose OAuth / Sign in when prompted (do not select No sign-in and do not add a Bearer header).
8. Claude should open the EpicRush approval page. Enter the `MCP_OAUTH_ADMIN_PASSWORD` you set in Render and approve.

## Available tools

- `epicrush_channel_info`
- `epicrush_upload_video` (uploads an existing public HTTPS MP4 URL; default privacy is private)

## Important security notes

- Never share or commit Google client secrets, refresh tokens, signing secrets, or the connection password.
- Use a new random signing secret. Do not reuse the previously shared MCP bearer token.
- OAuth client registrations and pending authorization codes are held in memory. If Render restarts during the initial authorization flow, simply reconnect from Claude. Access tokens are self-contained and expire after one hour.
- The free Render instance may sleep when idle, so the first request can take a little time to wake up.
