/**
 * Phone-friendly Google device-code OAuth (no localhost redirect).
 * Use OAuth client type: "TVs and Limited Input devices".
 *
 *   npm run auth:device --prefix stream
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./load-env.js";

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.resolve(__dirname, "../.env");
// force-ssl needed for custom thumbnails + live chat insert
const SCOPE = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
].join(" ");

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in stream/.env\nUse OAuth type: TVs and Limited Input devices"
  );
  process.exit(1);
}

const codeRes = await fetch("https://oauth2.googleapis.com/device/code", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: clientId, scope: SCOPE }),
});
const codeData = await codeRes.json();
if (!codeRes.ok) {
  console.error(codeData);
  process.exit(1);
}

console.log("\nOn your phone, open:", codeData.verification_url);
console.log("Enter code:", codeData.user_code);
console.log("Waiting for approval…\n");

const tokens = await poll(codeData);
upsertEnv("GOOGLE_REFRESH_TOKEN", tokens.refresh_token);
console.log("Saved GOOGLE_REFRESH_TOKEN to stream/.env");

async function poll(data) {
  const deadline = Date.now() + (data.expires_in || 1800) * 1000;
  let wait = Math.max(3, data.interval || 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(wait);
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        device_code: data.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const json = await res.json();
    if (res.ok && json.refresh_token) return json;
    if (json.error === "authorization_pending") continue;
    if (json.error === "slow_down") {
      wait += 2000;
      continue;
    }
    throw new Error(json.error_description || json.error || "auth failed");
  }
  throw new Error("timed out");
}

function upsertEnv(key, value) {
  let body = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(body)) body = body.replace(re, line);
  else body = `${body.trimEnd()}\n${line}\n`;
  fs.writeFileSync(envFile, body, "utf8");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
