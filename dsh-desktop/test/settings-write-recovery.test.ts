import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const {
  patchSettingsWriteFailureSource,
  patchSettingsWriteFailure,
} = require('../scripts/patch-deps.js') as {
  patchSettingsWriteFailureSource(source: string): string | undefined;
  patchSettingsWriteFailure(targetFile: string): boolean;
};

// 0.1.7-rc.2 运行时逐字夹具（ctx.remote 形态；tab 缩进；失败 return false）。
// 与安装产物 client.js L1177-1194 一致——锚点漂移时本测试必须红。
const oldMutate = [
  '\t\t\tmutate(ops, expectedRevision) {',
  '\t\t\t\tconst ownedOps = structuredClone(ops);',
  '\t\t\t\tconst generation = ++this.writeGeneration;',
  '\t\t\t\treturn this.enqueue(async () => {',
  '\t\t\t\t\tconst revision = expectedRevision ?? this.pendingRevision ?? this.getSnapshot().revision;',
  '\t\t\t\t\tconst response = await this.ctx.remote.settings.mutate(this.spec.namespace, ownedOps, revision);',
  '\t\t\t\t\tif (!response.ok) {',
  '\t\t\t\t\t\tawait this.recover(generation);',
  '\t\t\t\t\t\treturn false;',
  '\t\t\t\t\t}',
  '\t\t\t\t\tif (this.disposed) return true;',
  '\t\t\t\t\tif (generation === this.writeGeneration) {',
  '\t\t\t\t\t\tthis.pendingRevision = void 0;',
  '\t\t\t\t\t\tthis.mirror.acceptView(response.value);',
  '\t\t\t\t\t} else this.pendingRevision = response.value.revision;',
  '\t\t\t\t\treturn true;',
  '\t\t\t\t});',
  '\t\t\t}',
].join('\n');

function patchedController() {
  const method = patchSettingsWriteFailureSource(oldMutate);
  assert.ok(method);
  return new Function(`
    return class ConfigFormControllerFixture {
      ${method}
      enqueue(operation) {
        return operation();
      }
      async recover(generation) {
        if (this.disposed || generation !== this.writeGeneration) return;
        this.pendingRevision = undefined;
        await this.mirror.load();
      }
      getSnapshot() {
        return this.snapshot;
      }
    };
  `)();
}

test('settings write patch retries only an implicit-revision settings/conflict', () => {
  const patched = patchSettingsWriteFailureSource(`before\n${oldMutate}\nafter`);
  assert.ok(patched);
  assert.match(patched, /dsh-desktop-settings-write-retry/);
  // 斜杠错误码（v2 死因修正：旧补丁写 settings-conflict，永不命中）
  assert.match(patched, /response\.error\.code === "settings\/conflict"/);
  // 显式 fence 不自动越过（settings-subagent 等域编辑器依赖冲突如实上报）
  assert.match(patched, /expectedRevision === void 0/);
  // G1：recover（异步回源）之后、重试呼叫之前重查代际
  assert.match(patched, /if \(!this\.disposed && generation === this\.writeGeneration\) \{/);
  // G2：重试 revision 在 recover 之后重读；undefined（ns 不再被服务）不重试
  assert.match(patched, /const fresh = this\.getSnapshot\(\)\.revision;/);
  assert.match(patched, /if \(fresh !== void 0 && fresh !== revision\) \{/);
});

test('patched controller retries one stale implicit revision via ctx.remote', async () => {
  const Controller = patchedController();
  const revisions: number[] = [];
  const controller = new Controller();
  controller.writeGeneration = 0;
  controller.disposed = false;
  controller.pendingRevision = undefined;
  controller.snapshot = { revision: 1 };
  controller.spec = { namespace: 'computer-user' };
  controller.mirror = {
    async load() {
      controller.snapshot = { revision: 2 };
    },
    acceptView(value: { revision: number }) {
      controller.snapshot = value;
    },
  };
  controller.ctx = {
    remote: {
      settings: {
        async mutate(_ns: string, _ops: unknown[], revision: number) {
          revisions.push(revision);
          if (revisions.length === 1) {
            return {
              ok: false,
              error: {
                code: 'settings/conflict',
                message: 'stale revision',
                details: { expected: 1, actual: 2 },
              },
            };
          }
          return { ok: true, value: { revision: 3 } };
        },
      },
    },
  };

  const accepted = await controller.mutate([{ op: 'set', path: ['mode'], value: 'auto' }]);
  assert.equal(accepted, true);
  assert.deepEqual(revisions, [1, 2]);
  assert.equal(controller.snapshot.revision, 3);
});

test('explicit revision fences are never auto-retried', async () => {
  const Controller = patchedController();
  const revisions: number[] = [];
  const controller = new Controller();
  controller.writeGeneration = 0;
  controller.disposed = false;
  controller.pendingRevision = undefined;
  controller.snapshot = { revision: 7 };
  controller.spec = { namespace: 'computer-user' };
  controller.mirror = { async load() {} };
  controller.ctx = {
    remote: {
      settings: {
        async mutate(_ns: string, _ops: unknown[], revision: number) {
          revisions.push(revision);
          return {
            ok: false,
            error: { code: 'settings/conflict', message: 'stale', details: {} },
          };
        },
      },
    },
  };

  const accepted = await controller.mutate([{ op: 'set', path: ['mode'], value: 'auto' }], 7);
  assert.equal(accepted, false);
  assert.deepEqual(revisions, [7]);
});

test('final failure returns false instead of throwing', async () => {
  const Controller = patchedController();
  const controller = new Controller();
  controller.writeGeneration = 0;
  controller.disposed = false;
  controller.pendingRevision = undefined;
  controller.snapshot = { revision: 4 };
  controller.spec = { namespace: 'computer-user' };
  controller.mirror = { async load() {} };
  controller.ctx = {
    remote: {
      settings: {
        async mutate() {
          return {
            ok: false,
            error: {
              code: 'settings/rejected',
              message: 'disk is read-only',
              details: { ns: 'computer-user' },
            },
          };
        },
      },
    },
  };

  // settings/rejected 不重试（守卫只认 settings/conflict），最终 false
  const accepted = await controller.mutate([{ op: 'set', path: ['mode'], value: 'auto' }]);
  assert.equal(accepted, false);
});

test('settings write source transform is idempotent', () => {
  const once = patchSettingsWriteFailureSource(oldMutate);
  assert.ok(once);
  assert.equal(patchSettingsWriteFailureSource(once), once);
});

test('settings write patch refuses an unknown upstream shape', () => {
  assert.equal(
    patchSettingsWriteFailureSource('const upstreamChanged = true;'),
    undefined,
  );
});

test('settings write file patch applies atomically and stays stable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-write-'));
  const file = join(dir, 'client.js');
  try {
    writeFileSync(file, oldMutate);
    assert.equal(patchSettingsWriteFailure(file), true);
    const once = readFileSync(file, 'utf8');
    assert.equal(patchSettingsWriteFailure(file), true);
    assert.equal(readFileSync(file, 'utf8'), once);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
