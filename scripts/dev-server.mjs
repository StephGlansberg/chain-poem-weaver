import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 4176);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function resolvePath(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const relative = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const full = normalize(join(root, relative));
  if (!full.startsWith(root)) return null;
  if (existsSync(full) && statSync(full).isDirectory()) return join(full, "index.html");
  if (!existsSync(full) && !extname(full)) return join(root, "index.html");
  return full;
}

createServer((req, res) => {
  const filePath = resolvePath(req.url || "/");
  if (!filePath || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": types[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}).listen(port, () => {
  console.log(`Chain Poem Weaver running at http://127.0.0.1:${port}`);
});
