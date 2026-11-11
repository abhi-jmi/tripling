import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = directory + "/" + entry.name;
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (/\.(?:js|mjs)$/.test(path)) result.push(path);
  }
  return result;
}
for (const path of [
  ...(await files("server")),
  ...(await files("scripts")),
  ...(await files("dist")),
]) {
  const result = spawnSync(process.execPath, ["--check", path], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log("JavaScript syntax checks passed.");
