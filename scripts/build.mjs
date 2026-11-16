import { build } from "esbuild";
import { mkdir, readFile, cp } from "node:fs/promises";
await mkdir("dist/server", { recursive: true });
const browser = await build({
  entryPoints: ["web/app.ts"],
  bundle: true,
  write: false,
  format: "iife",
  target: "safari16",
});
const html = await readFile("web/index.html", "utf8");
await build({
  entryPoints: ["worker/index.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  outfile: "dist/server/index.js",
  define: {
    PAGE_HTML: JSON.stringify(html),
    CLIENT_JS: JSON.stringify(browser.outputFiles[0].text),
  },
});
await mkdir("dist/.openai", { recursive: true });
try {
  await cp(".openai/hosting.json", "dist/.openai/hosting.json");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  console.log("Portable build: private hosting manifest not configured.");
}
await cp("drizzle", "dist/.openai/drizzle", { recursive: true });
