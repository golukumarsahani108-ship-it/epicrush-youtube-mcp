import express from "express";
import { google } from "googleapis";
import { Readable } from "node:stream";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 10000);
const MCP_ACCESS_TOKEN = process.env.MCP_ACCESS_TOKEN;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

function html(message) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EpicRush setup</title></head><body style="font-family:system-ui;max-width:760px;margin:40px auto;padding:0 18px;line-height:1.5">${message}</body></html>`;
}

function getOAuthClient(redirectUri) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the hosting environment first.");
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri);
}

function getRedirectUri(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}/google/callback`;
}

function youtubeClient() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
    throw new Error("YouTube is not connected yet. Set the Google OAuth values and YOUTUBE_REFRESH_TOKEN in the hosting environment.");
  }
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: "v3", auth });
}

function authorized(req, res, next) {
  if (!MCP_ACCESS_TOKEN) {
    return res.status(503).json({ error: "MCP_ACCESS_TOKEN is not configured." });
  }
  const header = req.get("authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(MCP_ACCESS_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "Unauthorized" });
  }
  next();
}

app.get("/", (_req, res) => {
  res.type("html").send(html("<h1>EpicRush YouTube MCP</h1><p>Server is running.</p><p>Health: <a href='/health'>/health</a></p><p>Google setup: <a href='/google/auth'>/google/auth</a></p><p>MCP endpoint: <code>/mcp</code></p>"));
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "epicrush-youtube-mcp" }));

app.get("/google/auth", (req, res) => {
  try {
    const oauth2 = getOAuthClient(getRedirectUri(req));
    const url = oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/youtube.upload"]
    });
    res.redirect(url);
  } catch (error) {
    res.status(500).type("html").send(html(`<h1>Google OAuth setup error</h1><p>${String(error.message)}</p>`));
  }
});

app.get("/google/callback", async (req, res) => {
  try {
    if (req.query.error) {
      return res.status(400).type("html").send(html(`<h1>Google authorization was not completed</h1><p>${String(req.query.error)}</p>`));
    }
    const code = String(req.query.code || "");
    if (!code) return res.status(400).send("Missing OAuth code.");
    const oauth2 = getOAuthClient(getRedirectUri(req));
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      return res.status(400).type("html").send(html("<h1>No refresh token returned</h1><p>Revoke this app's access in your Google Account, then visit /google/auth again and approve consent.</p>"));
    }
    res.set("Cache-Control", "no-store");
    res.type("html").send(html(`
      <h1>EpicRush YouTube authorization successful</h1>
      <p>Copy the refresh token below into your hosting provider's environment variable named <b>YOUTUBE_REFRESH_TOKEN</b>.</p>
      <p><b>Do not share this token or put it in GitHub.</b></p>
      <textarea id="token" style="width:100%;height:120px">${tokens.refresh_token}</textarea>
      <p><button onclick="navigator.clipboard.writeText(document.getElementById('token').value)">Copy refresh token</button></p>
      <p>After saving it in the host, you can close this page.</p>
    `));
  } catch (error) {
    res.status(500).type("html").send(html(`<h1>OAuth callback failed</h1><p>${String(error.message)}</p>`));
  }
});

function createMcpServer() {
  const server = new McpServer({ name: "epicrush-youtube-mcp", version: "1.0.0" });

  server.tool(
    "epicrush_channel_info",
    "Show the YouTube channel connected to EpicRush. This only reads channel details.",
    {},
    async () => {
      try {
        const yt = youtubeClient();
        const response = await yt.channels.list({ part: ["snippet", "statistics"], mine: true });
        const channel = response.data.items?.[0];
        if (!channel) return { content: [{ type: "text", text: "No channel was returned. Check that the Google account authorized is the owner of @epicrushworld." }] };
        return { content: [{ type: "text", text: JSON.stringify({
          title: channel.snippet?.title,
          channelId: channel.id,
          customUrl: channel.snippet?.customUrl,
          subscribers: channel.statistics?.subscriberCount,
          videos: channel.statistics?.videoCount,
          views: channel.statistics?.viewCount
        }, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `YouTube channel check failed: ${error.message}` }] };
      }
    }
  );

  server.tool(
    "epicrush_upload_video",
    "Upload a video file from a publicly reachable direct HTTPS MP4 URL to the connected YouTube channel. Use private by default and ask the channel owner before public publishing.",
    {
      video_url: z.string().url().describe("Direct HTTPS URL to an MP4 video file; not a YouTube watch page or Google Drive preview page."),
      title: z.string().min(1).max(100),
      description: z.string().max(5000).default(""),
      tags: z.array(z.string().max(30)).max(20).default([]),
      privacy_status: z.enum(["private", "unlisted", "public"]).default("private"),
      made_for_kids: z.boolean().default(false)
    },
    async ({ video_url, title, description, tags, privacy_status, made_for_kids }) => {
      try {
        const parsed = new URL(video_url);
        if (parsed.protocol !== "https:") throw new Error("Only HTTPS video URLs are allowed.");
        const videoResponse = await fetch(parsed, { redirect: "follow" });
        if (!videoResponse.ok || !videoResponse.body) throw new Error(`Could not fetch video URL (HTTP ${videoResponse.status}).`);
        const contentType = videoResponse.headers.get("content-type") || "";
        if (!contentType.includes("video") && !contentType.includes("octet-stream")) {
          throw new Error(`URL did not return a video file (content-type: ${contentType || "unknown"}). Use a direct MP4 download URL.`);
        }
        const yt = youtubeClient();
        const result = await yt.videos.insert({
          part: ["snippet", "status"],
          requestBody: {
            snippet: { title, description, tags, categoryId: "24" },
            status: { privacyStatus: privacy_status, selfDeclaredMadeForKids: made_for_kids }
          },
          media: {
            mimeType: contentType.includes("video") ? contentType : "video/mp4",
            body: Readable.fromWeb(videoResponse.body)
          }
        });
        return { content: [{ type: "text", text: JSON.stringify({
          uploaded: true,
          videoId: result.data.id,
          title: result.data.snippet?.title,
          privacyStatus: result.data.status?.privacyStatus,
          watchUrl: `https://www.youtube.com/watch?v=${result.data.id}`
        }, null, 2) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `Video upload failed: ${error.message}` }] };
      }
    }
  );

  return server;
}

app.post("/mcp", authorized, async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed", details: error.message });
  }
});

app.get("/mcp", authorized, (_req, res) => {
  res.status(405).set("Allow", "POST").send("Use POST for the Streamable HTTP MCP endpoint.");
});

app.delete("/mcp", authorized, (_req, res) => res.status(405).send("Stateless MCP endpoint."));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`EpicRush YouTube MCP listening on port ${PORT}`);
});
