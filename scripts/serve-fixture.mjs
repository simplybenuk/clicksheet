import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureRoot = resolve(projectRoot, "fixtures");
const fixturePort = Number(process.env.CLICKSHEET_FIXTURE_PORT ?? 4173);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  const filePath = resolve(fixtureRoot, relativePath);
  const fixturePrefix = `${fixtureRoot}${sep}`;

  if (!filePath.startsWith(fixturePrefix)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  try {
    if (!statSync(filePath).isFile()) {
      throw new Error("Not a file");
    }
  } catch {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": "no-store"
  });
  createReadStream(filePath).pipe(response);
});

server.listen(fixturePort, "127.0.0.1", () => {
  console.log(`Clicksheet fixture available at http://127.0.0.1:${fixturePort}/`);
});
