/**
 * One-time OAuth helper. Opens a browser, stores refresh token into stream/.env
 *
 * Prerequisites:
 * 1. Google Cloud project → enable YouTube Data API v3
 * 2. OAuth Desktop client → copy Client ID / Secret into stream/.env
 * 3. npm run auth --prefix stream
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import open from "open";
import { loadEnv } from "./load-env.js";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(__dirname, "../.env");
const SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.\nCopy stream/.env.example → stream/.env and fill them in."
  );
  process.exit(1);
}

const redirectUri = "http://127.0.0.1:53682/oauth2callback";
const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  try {
    if (!req.url?.startsWith("/oauth2callback")) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const url = new URL(req.url, redirectUri);
    const code = url.searchParams.get("code");
    if (!code) throw new Error("No code in callback");

    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      throw new Error(
        "No refresh_token returned. Revoke app access at https://myaccount.google.com/permissions and retry."
      );
    }

    upsertEnv("GOOGLE_REFRESH_TOKEN", tokens.refresh_token);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<h1>FLAG BATTLE auth OK</h1><p>Refresh token saved to stream/.env. You can close this tab.</p>"
    );
    console.log("Saved GOOGLE_REFRESH_TOKEN to stream/.env");
    server.close();
    process.exit(0);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end(String(err));
    server.close();
    process.exit(1);
  }
});

server.listen(53682, "127.0.0.1", async () => {
  console.log("Opening Google consent screen…");
  console.log(authUrl);
  await open(authUrl);
});

function upsertEnv(key, value) {
  let body = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(body)) body = body.replace(re, line);
  else body = `${body.trimEnd()}\n${line}\n`;
  fs.writeFileSync(envFile, body, "utf8");
}
