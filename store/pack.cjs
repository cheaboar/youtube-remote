// Builds the Chrome Web Store upload: dist/youtube-remote-<version>.zip.
// Only the files the extension actually loads are packaged, so tests, node_modules and the
// native helper never ship. Run: node store/pack.cjs
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const version = manifest.version;
const name = `youtube-remote-${version}`;
const stage = path.join(root, "dist", name);
const zip = path.join(root, "dist", `${name}.zip`);

const files = new Set(["manifest.json"]);
const add = file => { if (file && typeof file === "string") files.add(file); };
add(manifest.background?.service_worker);
add(manifest.options_page);
add(manifest.action?.default_popup);
Object.values(manifest.icons || {}).forEach(add);
Object.values(manifest.action?.default_icon || {}).forEach(add);
for (const entry of manifest.content_scripts || []) {
  (entry.js || []).forEach(add);
  (entry.css || []).forEach(add);
}
// Extension pages pull their own CSS and scripts.
for (const page of [manifest.options_page, manifest.action?.default_popup, "recovery.html"].filter(Boolean)) {
  const html = fs.readFileSync(path.join(root, page), "utf8");
  for (const match of html.matchAll(/(?:src|href)="([^"#:]+)"/g)) {
    add(path.posix.normalize(path.posix.join(path.posix.dirname(page), match[1])));
  }
}

const missing = [...files].filter(file => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error("Missing files:", missing.join(", "));
  process.exit(1);
}

fs.rmSync(stage, { recursive: true, force: true });
for (const file of [...files].sort()) {
  const target = path.join(stage, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
}
fs.rmSync(zip, { force: true });
execFileSync("powershell.exe", ["-NoProfile", "-Command",
  `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -Force`]);
console.log(`${files.size} files -> ${path.relative(root, zip)}`);
