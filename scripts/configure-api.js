import { readFileSync, writeFileSync } from "node:fs";

const api = new URL(process.argv[2]);
if (
  api.protocol !== "https:" ||
  api.username ||
  api.password ||
  api.search ||
  api.hash ||
  api.pathname !== "/"
)
  throw new Error("Provide the HTTPS origin of the deployed Santastic API.");

const root = new URL("../", import.meta.url);
const htmlPath = new URL("public/index.html", root);
const html = readFileSync(htmlPath, "utf8");
if (!html.includes("connect-src "))
  throw new Error("Content Security Policy is missing.");
writeFileSync(
  htmlPath,
  html.replace(
    /connect-src [^;]+;/,
    `connect-src 'self' https://challenges.cloudflare.com ${api.origin};`,
  ),
);
writeFileSync(
  new URL("public/config.js", root),
  `export const apiUrl = ${JSON.stringify(api.origin)};\n`,
);
console.log(`Configured Santastic API: ${api.origin}`);
