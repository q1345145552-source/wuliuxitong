import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const PORT = 3000;
const HOST = "0.0.0.0";
const ROOT = join(import.meta.dirname, ".next", "standalone");
const STATIC = join(import.meta.dirname, ".next", "static");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".txt": "text/plain",
};

function serve(res, filePath, statusCode = 200) {
  try {
    const data = readFileSync(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(statusCode, { "Content-Type": MIME[ext] || "application/octet-stream", "Content-Length": data.length });
    res.end(data);
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  }
}

function findFile(urlPath) {
  // 1) Check standalone .html
  const htmlPath = join(ROOT, urlPath === "/" ? "index.html" : urlPath + ".html");
  if (existsSync(htmlPath) && statSync(htmlPath).isFile()) return htmlPath;

  // 2) Check standalone exact file
  const exact = join(ROOT, urlPath);
  if (existsSync(exact) && statSync(exact).isFile()) return exact;

  // 3) Check _next/static
  if (urlPath.startsWith("/_next/")) {
    const staticPath = join(STATIC, urlPath.replace(/^\/_next\/static\//, ""));
    if (existsSync(staticPath) && statSync(staticPath).isFile()) return staticPath;
  }

  // 4) Check public files (images etc)
  const publicFile = join(import.meta.dirname, "public", urlPath);
  if (existsSync(publicFile) && statSync(publicFile).isFile()) return publicFile;

  // 5) Fallback to [slug]/index.html for dynamic routes
  const slugHtml = join(ROOT, urlPath.replace(/^\//, "").replace(/\/$/, ""), "index.html");
  if (existsSync(slugHtml) && statSync(slugHtml).isFile()) return slugHtml;

  return null;
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const file = findFile(url.pathname);
  if (file) {
    serve(res, file);
  } else {
    // fallback to root index.html for SPA routing
    const fallback = join(ROOT, "index.html");
    if (existsSync(fallback)) {
      serve(res, fallback);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Serving on http://${HOST}:${PORT}`);
});
