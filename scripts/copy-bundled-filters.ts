import { mkdir, readdir, copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = join(root, "packages", "qtk-filters", "imported");
const dest = join(root, "packages", "qtk-plugin", "filters", "imported");

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });

const entries = (await readdir(src)).filter((name) => name.endsWith(".toml"));
await Promise.all(
  entries.map((name) => copyFile(join(src, name), join(dest, name))),
);

console.log(`[qtk] copied ${entries.length} bundled filter(s)`);
