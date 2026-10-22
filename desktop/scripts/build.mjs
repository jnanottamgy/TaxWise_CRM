/**
 * Bundles TaxWise Desktop into dist/ (type-checking is `tsc --noEmit`, run first by `npm run build`).
 *
 * Sandboxed preloads can't require local files, so each preload is bundled into one file.
 * TAXWISE_APP_URL (§17) is baked into the main process here. With --release, the build refuses to
 * run unless TAXWISE_APP_URL and TAXWISE_UPDATE_URL are https:// addresses, and the bundle is marked
 * as a release (__TAXWISE_RELEASE__): it then runs locked down whatever the executable is called.
 */

import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.includes("--release");
const appUrl = (process.env.TAXWISE_APP_URL ?? "").trim();

function fail(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

function requireHttps(name, value) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) throw new Error();
  } catch {
    fail(`${name} must be an https:// address for a release build (got "${value}").`);
  }
}

if (release) {
  requireHttps("TAXWISE_APP_URL", appUrl);
  requireHttps("TAXWISE_UPDATE_URL", (process.env.TAXWISE_UPDATE_URL ?? "").trim());
} else if (!appUrl) {
  console.warn("build: TAXWISE_APP_URL is not set; set it when running (development builds only).");
}

rmSync(join(root, "dist"), { recursive: true, force: true });
rmSync(join(root, "dist-build"), { recursive: true, force: true });

const common = { bundle: true, sourcemap: release ? false : "inline", legalComments: "none", logLevel: "warning", target: "chrome138" };

await build({
  ...common,
  entryPoints: [join(root, "src/main/main.ts")],
  outfile: join(root, "dist/main/main.js"),
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "electron-updater"],
  define: { __TAXWISE_APP_URL__: JSON.stringify(appUrl), __TAXWISE_RELEASE__: JSON.stringify(release) },
});

for (const name of ["crm", "whatsapp", "panel"]) {
  await build({
    ...common,
    entryPoints: [join(root, `src/preload/${name}.ts`)],
    outfile: join(root, `dist/preload/${name}.js`),
    platform: "browser",
    format: "cjs",
    external: ["electron"],
  });
}

await build({
  ...common,
  entryPoints: [join(root, "src/renderer/panel-header.ts")],
  outfile: join(root, "dist/renderer/panel-header.js"),
  platform: "browser",
  format: "iife",
});

for (const file of ["panel-header.html", "panel-header.css"]) {
  copyFileSync(join(root, "src/renderer", file), join(root, "dist/renderer", file));
}
const font = join(root, "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2");
mkdirSync(join(root, "dist/renderer/fonts"), { recursive: true });
if (existsSync(font)) copyFileSync(font, join(root, "dist/renderer/fonts/inter-latin-wght-normal.woff2"));
else console.warn("build: Inter not found; the panel header falls back to the system font.");

// electron-builder's afterPack hook (fuses), outside the app bundle.
await build({
  ...common,
  entryPoints: [join(root, "scripts/fuses.ts")],
  outfile: join(root, "dist-build/fuses.cjs"),
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["@electron/fuses", "electron-builder"],
});

console.log(`build: done${release ? " (release)" : ""} → dist/`);
