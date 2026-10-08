import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export function localPatrolPreview() {
  let root;
  return {
    name: 'local-patrol-preview',
    apply: 'serve',
    configResolved(config) { root = config.root; },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = (request.url ?? '').split('?')[0];
        if (!pathname.startsWith('/__patrol_preview/')) return next();
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405;
          response.setHeader('Allow', 'GET, HEAD');
          response.end(JSON.stringify({ error: 'Read-only local preview.' }));
          return;
        }
        const name = pathname.slice('/__patrol_preview/'.length);
        if (name !== 'manifest.json' && !/^policy-[1-9][0-9]{0,9}\.json$/.test(name)) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'Unknown local preview asset.' }));
          return;
        }
        try {
          const data = await readFile(resolve(root, '.local/patrol-preview', name));
          response.setHeader('Content-Length', data.byteLength);
          response.end(request.method === 'HEAD' ? undefined : data);
        } catch (error) {
          response.statusCode = error?.code === 'ENOENT' ? 404 : 500;
          response.end(JSON.stringify({ error: 'Local preview models are unavailable. Run the preview preparation script first.' }));
        }
      });
    },
  };
}
