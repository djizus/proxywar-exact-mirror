import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = join(root, "vendor", "proxywar");
const require = createRequire(import.meta.url);
const esbuild = require(join(upstream, "node_modules", "esbuild"));
const run = promisify(execFile);
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await esbuild.build({
  entryPoints: {
    mirror: join(root, "src", "mirror.ts"),
    protocol: join(root, "src", "protocol.ts"),
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

const declarations = await mkdtemp(join(tmpdir(), "proxywar-mirror-types-"));
try {
  await run(join(upstream, "node_modules", ".bin", "tsc"), [
    join(root, "src", "protocol.ts"),
    "--declaration",
    "--emitDeclarationOnly",
    "--strict",
    "--target",
    "ES2023",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--outDir",
    declarations,
  ]);
  await cp(
    join(declarations, "protocol.d.ts"),
    join(dist, "protocol.d.mts"),
  );
  await cp(
    join(root, "src", "public-api.d.mts"),
    join(dist, "mirror.d.mts"),
  );
} finally {
  await rm(declarations, { recursive: true, force: true });
}

for (const map of ["pangaea", "world"]) {
  await cp(join(upstream, "resources", "maps", map), join(dist, "maps", map), {
    recursive: true,
  });
}
