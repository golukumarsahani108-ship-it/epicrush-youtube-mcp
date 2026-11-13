import express from "express";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { google } from "googleapis";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));

const PORT = Number(process.env.PORT || 10000);
const BASE_URL = (process.env.PUBLIC_BASE_URL || "https://epicrush-youtube-mcp.onrender.com").replace(/\/+$/, "");
const MCP_RESOURCE = `${BASE_URL}/mcp`;
const OAUTH_SECRET = process.env.MCP_OAUTH_SIGNING_SECRET;
const ADMIN_PASSWORD = process.env.MCP_OAUTH_ADMIN_PASSWORD;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

if (!OAUTH_SECRET || OAUTH_SECRET.length < 32) {
  console.error("Missing/weak MCP_OAUTH_SIGNING_SECRET (use a random value of at least 32 characters).");
  process.exit(1);
}

const clients = new Map();
const pendingAuthorizations = new Map();
const authorizationCodes = new Map();

const b64u = (value) => Buffer.from(value).toString("base64url");
const safeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
const signJwt = (payload) => {
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  const input = `${header}.${body}`;
  const sig = crypto.createHmac("sha256", OAUTH_SECRET).update(input).digest("base64url");
  return `${input}.${sig}`;
};
const verifyJwt = (token) => {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const input = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac("sha256", OAUTH_SECRET).update(input).digest("base64url");
  if (!safeEqual(parts[2], expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (payload.aud !== MCP_RESOURCE) return null;
    return payload;
  } catch { return null; }
};
const oauthError = (res, error, description, status = 400) =>
  res.status(status).json({ error, error_description: description });

function getOAuthClient() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error("Google OAuth environment variables are missing.");
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/google/callback`
  );
}

app.get("/", (_req, res) => res.type("text").send("EpicRush YouTube MCP is running."));
app.get("/health", (_req, res) => res.json({ ok: true, service: "epicrush-youtube-mcp" }));

// OAuth 2.1 discovery for Claude's remote MCP connector.
const authorizationServerMetadata = {
  issuer: BASE_URL,
  authorization_endpoint: `${BASE_URL}/authorize`,
  token_endpoint: `${BASE_URL}/token`,
  registration_endpoint: `${BASE_URL}/register`,
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: ["youtube.readonly", "youtube.upload"]
};
const protectedResourceMetadata = {
  resource: MCP_RESOURCE,
  authorization_servers: [BASE_URL],
  bearer_methods_supported: ["header"],
  scopes_supported: ["youtube.readonly", "youtube.upload"]
};
app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(authorizationServerMetadata));
app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json(protectedResourceMetadata));
app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => res.json(protectedResourceMetadata));

// Dynamic client registration. Claude creates its own public OAuth client.
app.post("/register", (req, res) => {
  const body = req.body || {};
  const redirects = body.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length === 0 ||
      redirects.some((u) => typeof u !== "string" || !(u.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)))) {
    return oauthError(res, "invalid_client_metadata", "A valid redirect_uris array is required.");
  }
  const clientId = crypto.randomUUID();
  const client = {
    client_id: clientId,
    client_name: typeof body.client_name === "string" ? body.client_name.slice(0, 120) : "MCP client",
    redirect_uris: redirects,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"]
  };
  clients.set(clientId, client);
  return res.status(201).json(client);
});

app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, response_type, state, code_challenge, code_challenge_method } = req.query;
  const client = clients.get(String(client_id || ""));
  if (!client || !client.redirect_uris.includes(String(redirect_uri || ""))) {
    return oauthError(res, "invalid_request", "Unknown client or redirect URI.");
  }
  if (response_type !== "code" || !state || !code_challenge || code_challenge_method !== "S256") {
    return oauthError(res, "invalid_request", "Authorization Code with PKCE S256 is required.");
  }
  const resource = String(req.query.resource || MCP_RESOURCE);
  if (resource !== MCP_RESOURCE) return oauthError(res, "invalid_target", "Unknown resource.");
  const txn = crypto.randomBytes(24).toString("base64url");
  pendingAuthorizations.set(txn, {
    client_id: String(client_id), redirect_uri: String(redirect_uri),
    state: String(state), code_challenge: String(code_challenge),
    resource, created_at: Date.now()
  });
  const safeName = String(client.client_name).replace(/[&<>"']/g, "");
  res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>EpicRush authorization</title><style>body{font-family:Arial,sans-serif;background:#f4f7fb;display:grid;place-items:center;min-height:100vh;margin:0;color:#172033}.card{background:white;padding:28px;border-radius:18px;max-width:420px;width:calc(100% - 56px);box-shadow:0 10px 40px #15294b18}input{box-sizing:border-box;width:100%;padding:13px;border:1px solid #ccd4e0;border-radius:9px;margin:12px 0}button{width:100%;padding:13px;border:0;border-radius:9px;background:#2563eb;color:white;font-weight:700}small{color:#64748b}</style></head><body><main class="card"><h2>Connect EpicRush YouTube</h2><p><b>${safeName}</b> wants permission to use your YouTube channel through EpicRush.</p><p>Requested access: read channel details and upload videos.</p><form method="post" action="/authorize/decision"><input type="hidden" name="txn" value="${txn}"><label>EpicRush connection password</label><input type="password" name="password" required autocomplete="current-password" placeholder="Enter the password set in Render"><button type="submit">Approve connection</button></form><small>This password is checked by EpicRush and is not sent to Claude.</small></main></body></html>`);
});

app.post("/authorize/decision", (req, res) => {
  const txn = String(req.body.txn || "");
  const pending = pendingAuthorizations.get(txn);
  pendingAuthorizations.delete(txn);
  if (!pending || Date.now() - pending.created_at > 10 * 60 * 1000) {
    return res.status(400).type("text").send("Authorization expired. Please reconnect from Claude.");
  }
  if (!ADMIN_PASSWORD || !safeEqual(String(req.body.password || ""), ADMIN_PASSWORD)) {
    return res.status(401).type("text").send("Incorrect connection password. Go back to Claude and try connecting again.");
  }
  const code = crypto.randomBytes(32).toString("base64url");
  authorizationCodes.set(code, { ...pending, created_at: Date.now() });
  const target = new URL(pending.redirect_uri);
  target.searchParams.set("code", code);
  target.searchParams.set("state", pending.state);
  return res.redirect(302, target.toString());
});

app.post("/token", (req, res) => {
  const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body || {};
  if (grant_type !== "authorization_code") return oauthError(res, "unsupported_grant_type", "Only authorization_code is supported.");
  const record = authorizationCodes.get(String(code || ""));
  authorizationCodes.delete(String(code || ""));
  if (!record || Date.now() - record.created_at > 5 * 60 * 1000) return oauthError(res, "invalid_grant", "Authorization code is invalid or expired.");
  if (record.client_id !== String(client_id || "") || record.redirect_uri !== String(redirect_uri || "")) {
    return oauthError(res, "invalid_grant", "Client or redirect URI does not match.");
  }
  if (typeof code_verifier !== "string" || code_verifier.length < 43 || code_verifier.length > 128) {
    return oauthError(res, "invalid_grant", "PKCE verifier is invalid.");
  }
  const digest = crypto.createHash("sha256").update(code_verifier).digest("base64url");
  if (!safeEqual(digest, record.code_challenge)) return oauthError(res, "invalid_grant", "PKCE verification failed.");
  const now = Math.floor(Date.now() / 1000);
  const accessToken = signJwt({
    iss: BASE_URL, sub: record.client_id, aud: MCP_RESOURCE,
    scope: "youtube.readonly youtube.upload", iat: now, exp: now + 3600
  });
  return res.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: "youtube.readonly youtube.upload"
  });
});

function requireOAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const claims = match ? verifyJwt(match[1]) : null;
  if (!claims) {
    res.set("WWW-Authenticate", `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`);
    return res.status(401).json({ error: "Unauthorized", message: "Use Claude's EpicRush OAuth connection." });
  }
  req.oauthClaims = claims;
  next();
}

// Separate Google OAuth: this authorizes EpicRush to access the user's YouTube channel.
app.get("/google/auth", (_req, res) => {
  try {
    const oauth = getOAuthClient();
    const url = oauth.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"]
    });
    res.redirect(url);
  } catch (error) { res.status(500).type("text").send(error.message); }
});
app.get("/google/callback", async (req, res) => {
  try {
    const oauth = getOAuthClient();
    const { tokens } = await oauth.getToken(String(req.query.code || ""));
    res.type("html").send(`<h2>Google authorization complete</h2><p>Copy the refresh token below into the Render environment variable <b>YOUTUBE_REFRESH_TOKEN</b>. Keep it secret.</p><textarea style="width:95%;height:110px">${String(tokens.refresh_token || "No refresh token returned. Revoke access and authorize again with consent.")}</textarea><p>After saving the variable in Render, redeploy the service.</p>`);
  } catch (error) { res.status(500).type("text").send(`Google OAuth failed: ${error.message}`); }
});

function getYouTube() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !YOUTUBE_REFRESH_TOKEN) {
    throw new Error("Missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or YOUTUBE_REFRESH_TOKEN in Render.");
  }
  const oauth = getOAuthClient();
  oauth.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  return google.youtube({ version: "v3", auth: oauth });
}

function createMcpServer() {
  const server = new McpServer({ name: "EpicRush YouTube", version: "2.0.0" });

  server.tool("epicrush_channel_info", "Get the connected YouTube channel's basic information.", {}, async () => {
    try {
      const yt = getYouTube();
      const response = await yt.channels.list({ part: ["snippet", "statistics"], mine: true });
      const channel = response.data.items?.[0];
      if (!channel) return { content: [{ type: "text", text: "No YouTube channel was returned. Recheck the Google account and YouTube permissions." }] };
      return { content: [{ type: "text", text: JSON.stringify({
        title: channel.snippet?.title,
        channelId: channel.id,
        customUrl: channel.snippet?.customUrl,
        subscribers: channel.statistics?.subscriberCount,
        totalViews: channel.statistics?.viewCount,
        videoCount: channel.statistics?.videoCount
      }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `YouTube channel lookup failed: ${error.message}` }], isError: true };
    }
  });

  server.tool(
    "epicrush_upload_video",
    "Upload an existing MP4 video from a direct public HTTPS URL to the connected YouTube channel.",
    {
      video_url: z.string().url().describe("Direct public HTTPS URL to an MP4 file"),
      title: z.string().min(1).max(100),
      description: z.string().max(5000).optional(),
      tags: z.array(z.string().max(100)).max(30).optional(),
      privacy_status: z.enum(["private", "unlisted", "public"]).default("private"),
      made_for_kids: z.boolean().default(false)
    },
    async ({ video_url, title, description = "", tags = [], privacy_status = "private", made_for_kids = false }) => {
      try {
        const parsed = new URL(video_url);
        if (parsed.protocol !== "https:") throw new Error("Only HTTPS video URLs are allowed.");
        const response = await fetch(parsed, { redirect: "follow" });
        if (!response.ok || !response.body) throw new Error(`Could not download video (HTTP ${response.status}).`);
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.toLowerCase().includes("video/mp4")) throw new Error("URL must return a direct video/mp4 file.");
        const yt = getYouTube();
        const uploaded = await yt.videos.insert({
          part: ["snippet", "status"],
          requestBody: {
            snippet: { title, description, tags },
            status: { privacyStatus: privacy_status, selfDeclaredMadeForKids: made_for_kids }
          },
          media: { body: Readable.fromWeb(response.body) }
        });
        return { content: [{ type: "text", text: JSON.stringify({
          success: true, videoId: uploaded.data.id,
          url: `https://www.youtube.com/watch?v=${uploaded.data.id}`,
          privacyStatus: uploaded.data.status?.privacyStatus
        }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `YouTube upload failed: ${error.message}` }], isError: true };
      }
    }
  );
  return server;
}

app.post("/mcp", requireOAuth, async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("MCP request failed:", error);
    if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
  }
});
app.get("/mcp", requireOAuth, (_req, res) => res.status(405).send("Method not allowed"));
app.delete("/mcp", requireOAuth, (_req, res) => res.status(405).send("Method not allowed"));

app.listen(PORT, () => console.log(`EpicRush YouTube MCP OAuth server listening on port ${PORT}`));
