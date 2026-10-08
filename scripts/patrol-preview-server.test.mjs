import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { localPatrolPreview } from './patrol-preview-server.mjs';

test('preview middleware serves only allowlisted, read-only, uncached local models', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'patrol-preview-test-'));
  let middleware;
  const plugin = localPatrolPreview();
  assert.equal(plugin.apply, 'serve');
  assert.equal(plugin.configurePreviewServer, undefined);
  plugin.configResolved({ root });
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  await mkdir(resolve(root, '.local/patrol-preview'), { recursive: true });
  await writeFile(resolve(root, '.local/patrol-preview/manifest.json'), '{"version":1}');
  await writeFile(resolve(root, '.local/patrol-preview/policy-101.json'), '{"seed":101}');
  await writeFile(resolve(root, '.local/secret.json'), 'private');
  const server = createServer((request, response) => middleware(request, response, () => { response.statusCode = 418; response.end(); }));
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  const address = `http://127.0.0.1:${server.address().port}`;
  try {
    const manifest = await fetch(`${address}/__patrol_preview/manifest.json?cache=none`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('cache-control'), 'no-store');
    assert.equal(manifest.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await manifest.json(), { version: 1 });
    assert.deepEqual(await (await fetch(`${address}/__patrol_preview/policy-101.json`)).json(), { seed: 101 });
    const head = await fetch(`${address}/__patrol_preview/policy-101.json`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(`${address}/__patrol_preview/policy-42.json`)).status, 404);
    assert.equal((await fetch(`${address}/__patrol_preview/manifest.json`, { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await fetch(`${address}/__patrol_preview/.env`)).status, 404);
    assert.equal((await fetch(`${address}/__patrol_preview/%2e%2e%2fsecret.json`)).status, 404);
    assert.equal((await fetch(`${address}/unrelated`)).status, 418);
  } finally {
    await new Promise(resolveClosed => server.close(resolveClosed));
    await rm(root, { recursive: true });
  }
});
