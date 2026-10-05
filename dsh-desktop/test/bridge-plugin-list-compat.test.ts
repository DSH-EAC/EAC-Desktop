import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../../tauri-shell/sidecar/bridge.ts', import.meta.url), 'utf8');

function bridgeList(reply: unknown, error?: Error) {
  const calls: string[] = [];
  const rpcCalls: Array<{ method: string; params: unknown; timeoutMs: number | undefined }> = [];
  const window: any = {
    addEventListener() {},
    __DSH_WS_RPC__: () => ({
      onNotify() {}, send() {},
      call: async (method: string, params: unknown, timeoutMs?: number) => {
        calls.push(method);
        rpcCalls.push({ method, params, timeoutMs });
        if (error) throw error;
        return reply;
      },
    }),
  };
  runInNewContext(stripTypeScriptTypes(source), {
    window,
    document: { readyState: 'loading', documentElement: { setAttribute() {} }, addEventListener() {} },
    navigator: { platform: 'Win32' },
    setInterval() {}, setTimeout() {},
  });
  return { list: window.dshDesktop.pluginManager.list, setRemoved: window.dshDesktop.pluginManager.setRemoved, calls, rpcCalls };
}

test('pluginManager.list exposes the same rows to legacy and current clients without mutating RPC data', async () => {
  const list = [{ id: 'dsh-pet', enabled: false, removed: true }];
  const reply = Object.freeze({ list, profile: 'desktop', revision: 7 });
  const api = bridgeList(reply);
  const result = await api.list();
  assert.equal(result.list, list);
  assert.equal(result.rows, list);
  assert.equal(result.profile, reply.profile);
  assert.equal(result.revision, reply.revision);
  assert.equal('rows' in reply, false);
  assert.deepEqual(api.calls, ['plugins.list']);
});

test('pluginManager.list preserves empty lists and canonical list wins over a stale rows alias', async () => {
  const list: unknown[] = [];
  const result = await bridgeList({ list, rows: [{ id: 'stale' }] }).list();
  assert.equal(result.rows, list);
  assert.equal(result.list, list);
});

test('pluginManager.list preserves existing array and non-list response shapes', async () => {
  for (const reply of [[], null, undefined, { rows: [] }, { list: 'invalid' }]) {
    assert.equal(await bridgeList(reply).list(), reply);
  }
});

test('pluginManager.list keeps RPC failures visible', async () => {
  await assert.rejects(bridgeList(null, new Error('offline')).list(), /offline/);
});

test('pluginManager.setRemoved waits for the bounded external uninstall transaction', async () => {
  const api = bridgeList({ ok: true });
  await api.setRemoved('dsh-pet', true);
  assert.deepEqual(JSON.parse(JSON.stringify(api.rpcCalls)), [{
    method: 'plugins.set-removed', params: { id: 'dsh-pet', removed: true }, timeoutMs: 130000,
  }]);
});
