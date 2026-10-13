// Copies the committed deployment JSON files into public/deployments before `vite dev` and `vite build`. Forks are
// not bundled: the app loads their files from the backend at run time, since the forks are re-created every day.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORKS } from "@selio/sdk";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const source = join(repo, "contracts", "deployments");
const target = join(repo, "apps", "web", "public", "deployments");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

for (const [key, info] of Object.entries(NETWORKS)) {
  const live = join(source, `${key}.json`);
  const local = join(source, "local", `${key}.json`);
  if (info.isFork) {
    console.log(`[deployments] ${key}: loaded from the backend at run time`);
    continue;
  }
  const localAllowed = process.env.SELIO_LOCAL_TESTNETS === "1";
  const file = existsSync(live) ? live : localAllowed && existsSync(local) ? local : null;
  if (!file) {
    console.log(`[deployments] ${key}: none found, the app will show "not deployed yet"`);
    continue;
  }
  copyFileSync(file, join(target, `${key}.json`));
  console.log(`[deployments] ${key}: ${relative(repo, file).replaceAll("\\", "/")}`);
}
