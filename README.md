# EpicRush YouTube MCP

A small remote MCP server that connects Claude to the YouTube channel authorized by the owner.

## Tools

- `epicrush_channel_info`: reads the connected YouTube channel details.
- `epicrush_upload_video`: uploads a video from a publicly reachable direct HTTPS video URL. Upload defaults to `private`.

This server does **not** generate cartoon videos or host large video files. Create/edit the video with your chosen editor or AI tools, place the MP4 at a direct-download HTTPS URL, then ask Claude to upload it.

## Requirements

- Node.js 20+
- Google Cloud project with YouTube Data API v3 enabled
- Google OAuth **Web application** client
- A public HTTPS host (Render free web services can be used for testing; they sleep after 15 minutes idle and have an ephemeral filesystem)
- Claude custom connector support

## 1. Deploy to Render

1. Push this repository to GitHub.
2. In Render, choose **New → Web Service**, connect this GitHub repository.
3. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
4. Select Free for testing.
5. After deployment, copy the service URL, e.g. `https://YOUR-SERVICE.onrender.com`.

## 2. Configure Google OAuth redirect

In Google Cloud Console → Google Auth Platform / Clients → your Web client:

- Add this exact Authorized redirect URI:
  `https://YOUR-SERVICE.onrender.com/google/callback`
- Save changes.

Do not add a guessed URL. Use the actual Render service URL.

## 3. Set Render environment variables

In Render → your service → Environment, add:

- `GOOGLE_CLIENT_ID` = OAuth client ID
- `GOOGLE_CLIENT_SECRET` = OAuth client secret
- `MCP_ACCESS_TOKEN` = a long random secret (32+ characters)
- `PORT` is supplied by Render; do not need to set it.

Save and redeploy.

## 4. Connect the YouTube channel

1. Open `https://YOUR-SERVICE.onrender.com/google/auth`.
2. Sign in with the Google account that owns the EpicRush channel.
3. Review and approve the `youtube.upload` permission.
4. The callback page displays a refresh token once.
5. Copy it immediately into Render Environment as `YOUTUBE_REFRESH_TOKEN`.
6. Save/redeploy. Never put this token in GitHub or share it in chat.

If no refresh token appears, revoke this app's access from your Google Account and repeat the consent flow.

## 5. Add to Claude

In Claude → Settings / Customize → Connectors → Add custom connector:

- Name: `EpicRush YouTube`
- Server URL: `https://YOUR-SERVICE.onrender.com/mcp`
- Choose the fixed request-header authentication option if available:
  - Header: `Authorization`
  - Value: `Bearer YOUR_MCP_ACCESS_TOKEN`

If Claude's UI does not offer request headers, do not disable server authentication or publish an unauthenticated upload endpoint. Stop and ask for a different secure auth setup.

## 6. Test safely

First call `epicrush_channel_info` and confirm it shows the intended channel.

For upload, use a direct HTTPS MP4 download URL (not a YouTube link or Drive preview page). Keep `privacy_status` as `private` for the first test. Check the result in YouTube Studio before changing privacy to public.

## Security

- Never commit `.env`, client secrets, access tokens, refresh tokens, or downloaded credential JSON files.
- Keep the GitHub repository private if desired, but still never commit secrets.
- Anyone with the MCP access token can use the connected YouTube upload permission.
- Revoke Google access and rotate the MCP token if either is exposed.
- Review each title, description, thumbnail, audience setting, and video before publishing.

## Important limitations

- Render's free web services sleep after 15 minutes without inbound traffic and have ephemeral local storage. This is suitable for a test, not guaranteed always-on automation.
- YouTube API upload quotas and Google OAuth verification restrictions may apply. New/unverified API projects may have upload limitations.
- This server uploads an existing video; it does not generate animation, narration, music, or captions.
