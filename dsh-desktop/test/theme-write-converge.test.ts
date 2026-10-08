import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { patchThemeWriteConvergeSource } = require('../scripts/patch-deps.js') as {
  patchThemeWriteConvergeSource(source: string): string | undefined;
};

// 0.1.7-rc.2 运行时逐字夹具（三个方法体；锚点漂移时本测试必须红）。
const THEME_FIXTURE = [
  '\t\t\tsetTheme(id) {',
  '\t\t\t\tif (id !== "system" && !this.themes.some((t) => t.id === id)) throw new Error(`theme "${id}" is not registered`);',
  '\t\t\t\tif (this.preference === id) return;',
  '\t\t\t\tthis.preference = id;',
  '\t\t\t\tif (isThemePreference(id)) this.host.set(THEME_PREFERENCE_FIELD, id);',
  '\t\t\t\tthis.publish();',
  '\t\t\t}',
  '\t\t\tsetFontSize(px) {',
  '\t\t\t\tif (!Number.isInteger(px) || px < 12 || px > 17) throw new Error(`font size ${px} is outside 12..17`);',
  '\t\t\t\tif (this.fontSize === px) return;',
  '\t\t\t\tthis.fontSize = px;',
  '\t\t\t\tthis.host.set(FONT_SIZE_FIELD, px);',
  '\t\t\t\tthis.publish();',
  '\t\t\t}',
  '\t\t\t/** Adopt the scope\'s accepted durable preference without writing it back. */',
  '\t\t\tadopt() {',
  '\t\t\t\tconst section = this.host.getSnapshot().value;',
  '\t\t\t\tif (section === void 0) return;',
  '\t\t\t\tif (this.preference === section.preference && this.fontSize === section.fontSize) return;',
  '\t\t\t\tthis.preference = section.preference;',
  '\t\t\t\tthis.fontSize = section.fontSize;',
  '\t\t\t\tthis.publish();',
  '\t\t\t}',
].join('\n');

interface Harness {
  runtime: any;
  writes: Array<{ field: string; value: unknown }>;
  state: { settled: boolean; snapshot: { preference: string; fontSize: number } };
  published: Array<Record<string, unknown>>;
  drain(): Promise<void>;
}

// 行为级夹具：把补丁后的方法实例化成类，mock host.set（可注入失败）、
// 可控 durable 快照，验证收敛/在途防护/失败回滚三个行为。
function themeHarness(): Harness {
  const methods = patchThemeWriteConvergeSource(THEME_FIXTURE);
  assert.ok(methods);
  const factory = new Function(
    'isThemePreference',
    'THEME_PREFERENCE_FIELD',
    'FONT_SIZE_FIELD',
    `return class ThemeRuntimeFixture {
      ${methods}
    }`,
  );
  const Cls = factory(
    (id: string) => id === 'light' || id === 'dark' || id === 'system',
    'preference',
    'fontSize',
  );
  const writes: Array<{ field: string; value: unknown }> = [];
  const published: Array<Record<string, unknown>> = [];
  const state = { settled: true, snapshot: { preference: 'dark', fontSize: 14 } };
  const runtime: any = new Cls();
  runtime.themes = [{ id: 'light' }, { id: 'dark' }];
  runtime.preference = 'dark';
  runtime.fontSize = 14;
  runtime.publish = function () {
    published.push({ preference: this.preference, fontSize: this.fontSize });
  };
  runtime.host = {
    set(field: string, value: unknown) {
      writes.push({ field, value });
      return new Promise<boolean>((resolve) => {
        queueMicrotask(() => {
          if (state.settled) {
            state.snapshot = { ...state.snapshot, [field]: value as never };
            resolve(true);
          } else resolve(false);
        });
      });
    },
    getSnapshot() {
      return { value: { ...state.snapshot } };
    },
    subscribe() {
      return () => void 0;
    },
  };
  return {
    runtime,
    writes,
    state,
    published,
    async drain() {
      for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

test('theme transform applies to the 0.1.7 runtime fixture', () => {
  const patched = patchThemeWriteConvergeSource(THEME_FIXTURE);
  assert.ok(patched);
  assert.match(patched, /dsh-desktop-theme-write-converge/);
  assert.match(patched, /__eacWrite/);
  assert.match(patched, /pending\.has\("preference"\)/);
});

test('convergence collapses rapid clicks into one wire write with the folded-back target', async () => {
  const h = themeHarness();
  // 三次快速点击：light → dark → light（后两笔在首笔在途时只更新目标值）
  h.runtime.setTheme('light');
  h.runtime.setTheme('dark');
  h.runtime.setTheme('light');
  await h.drain();
  // 收敛后：首笔 light 落盘，目标已折回 light → 无补笔；仅 1 笔 wire 写
  assert.deepEqual(h.writes, [{ field: 'preference', value: 'light' }]);
  assert.equal(h.runtime.preference, 'light');
  // 点击过程中的乐观中间值（dark）允许出现在 publish 历史里；
  // 关键断言是 settle 之后不再有回闪：durable == 内存，adopt 无事可做
  const framesAfterSettle = h.published.length;
  h.runtime.adopt();
  assert.equal(h.published.length, framesAfterSettle);
  assert.equal(h.runtime.preference, 'light');
});

test('convergence issues one supplementary write when the target drifts', async () => {
  const h = themeHarness();
  h.runtime.setTheme('light');
  h.runtime.setTheme('dark');
  await h.drain();
  // 首笔 light 落盘后目标已漂移到 dark → 恰好补一笔 dark
  assert.deepEqual(
    h.writes.map((w) => w.value),
    ['light', 'dark'],
  );
  assert.equal(h.runtime.preference, 'dark');
  assert.equal(h.state.snapshot.preference, 'dark');
});

test('adopt skips the in-flight field and adopts the other', async () => {
  const h = themeHarness();
  // fontSize 在途（写 16 未 settle），durable 快照仍是 14
  h.runtime.setFontSize(16);
  // 他窗改主题落盘 → 本窗快照更新（模拟广播回源）
  h.state.snapshot.preference = 'light';
  h.runtime.adopt();
  // 在途的 fontSize 不被快照拉回；不在途的 preference 照常采纳
  assert.equal(h.runtime.fontSize, 16);
  assert.equal(h.runtime.preference, 'light');
});

test('failed write rolls back to the last settled durable value', async () => {
  const h = themeHarness();
  h.runtime.host.set = (field: string, value: unknown) => {
    h.writes.push({ field, value });
    return Promise.resolve(false);
  };
  h.runtime.setFontSize(16);
  await h.drain();
  // 写被拒 → 回滚到最后 settled 持久值 14；pending 清空后 publish 不被自己的防护挡住
  assert.equal(h.runtime.fontSize, 14);
  assert.equal(h.runtime.__eacPending.size, 0);
  const last = h.published[h.published.length - 1];
  assert.equal(last.fontSize, 14);
});

test('convergence settles without extra writes when the target folds back', async () => {
  const h = themeHarness();
  // 起点 light；首笔在途时目标来回摆最终折回首发值：dark → light → dark
  h.state.snapshot.preference = 'light';
  h.runtime.preference = 'light';
  h.runtime.setTheme('dark');
  h.runtime.setTheme('light');
  h.runtime.setTheme('dark');
  await h.drain();
  // wire 仅首笔 dark；目标折回 dark → 无补笔、无回滚
  assert.deepEqual(h.writes, [{ field: 'preference', value: 'dark' }]);
  assert.equal(h.runtime.preference, 'dark');
});

test('external write during in-flight: last writer wins, no revert after settle', async () => {
  // 场景：本窗 dark 在途期间，他窗/外部提交了 system（快照更新模拟广播回源）。
  // 语义裁定（审核第 2 点）：单字段并发写 = last-writer-wins，与上游一致；
  // 本补丁不改变归属，只保证 (a) 在途期间显示不被陈旧快照拉回，
  // (b) 本窗 settle 后 内存 == durable（无永久丢失、无数据损坏）。
  const h = themeHarness();
  h.runtime.preference = 'light';          // 起点 light，点 dark 是真实变更
  h.state.snapshot.preference = 'light';
  h.runtime.setTheme('dark');
  h.state.snapshot.preference = 'system'; // 外部写入已提交 durable
  h.runtime.adopt();                       // 在途防护：跳过，显示保持 dark
  assert.equal(h.runtime.preference, 'dark');
  await h.drain();                         // 本窗写 settle：dark 覆盖 system（后写者胜）
  assert.equal(h.state.snapshot.preference, 'dark');
  assert.equal(h.runtime.preference, 'dark');
  assert.equal(h.runtime.__eacPending.size, 0);
});

test('conflict twice: rollback is user-visible (false consumed by rollback publish)', async () => {
  // 场景（审核第 3 点）：持续冲突下重试仍失败——UI 消费路径 = 失败回滚 publish，
  // 用户可见地回到持久值；不是静默丢操作。
  const h = themeHarness();
  h.state.settled = false; // host 持续拒绝
  h.runtime.setTheme('light');
  await h.drain();
  assert.equal(h.runtime.preference, 'dark'); // 回滚到 durable
  const last = h.published[h.published.length - 1];
  assert.equal(last.preference, 'dark');      // 回滚已 publish（用户可见）
  assert.equal(h.runtime.__eacPending.size, 0);
});
