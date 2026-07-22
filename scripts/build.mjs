import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = join(root, "vendor", "proxywar");
const require = createRequire(import.meta.url);
const esbuild = require(join(upstream, "node_modules", "esbuild"));
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await esbuild.build({
  entryPoints: {
    mirror: join(root, "src", "mirror.ts"),
    worker: join(root, "src", "worker.ts"),
  },
  outdir: dist,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  alias: {
    resources: join(upstream, "resources"),
  },
  banner: {
    js: "/* ProxyWar exact mirror: AGPL-3.0-only; corresponding source at https://github.com/djizus/proxywar-exact-mirror */",
  },
});

for (const map of ["pangaea", "world"]) {
  await cp(join(upstream, "resources", "maps", map), join(dist, "maps", map), {
    recursive: true,
  });
}

