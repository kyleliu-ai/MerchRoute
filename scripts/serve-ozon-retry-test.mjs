// Static production bundle only: no database, business worker or API proxy.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
    if (request.method !== 'GET' || pathname.startsWith('/api/')) { response.writeHead(503).end('Test API must be mocked'); return; }
    const target = path.resolve(root, '.' + (pathname.startsWith('/assets/') ? pathname : '/index.html'));
    if (!target.startsWith(root)) { response.writeHead(403).end(); return; }
    const bytes = await readFile(target);
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' }).end(bytes);
  } catch { response.writeHead(404).end(); }
});
server.listen(4183, '127.0.0.1');
process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
