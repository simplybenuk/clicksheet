import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkedDirectories = ["extension", "fixtures", "scripts", "test"];

function scripts(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return scripts(path);
    }

    return [".js", ".mjs"].includes(extname(entry.name)) ? [path] : [];
  });
}

const files = checkedDirectories.flatMap((directory) => scripts(resolve(projectRoot, directory)));

for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log(`Syntax-checked ${files.length} files.`);
