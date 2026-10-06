import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Optional V4 browser checks; ordinary Node tests do not install browser binaries.
// EAC_BROWSER_TEST_PLAYWRIGHT may point to an existing Playwright package;
// EAC_BROWSER_TEST_CHANNEL selects an installed browser (Windows default: msedge).
// EAC_BROWSER_TEST_ASSETS_ROOT can reuse an installed checkout read-only.
// EAC_BROWSER_TEST_SOURCE_ROOT allows the same checks against the unfixed source.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRoot = process.env.EAC_BROWSER_TEST_SOURCE_ROOT || repo;
const assetsRoot = process.env.EAC_BROWSER_TEST_ASSETS_ROOT || repo;
const require = createRequire(import.meta.url);
let playwright: any;
try {
  playwright = require(process.env.EAC_BROWSER_TEST_PLAYWRIGHT || 'playwright');
} catch (error) {
  if (process.env.EAC_BROWSER_TEST_PLAYWRIGHT) throw error;
}
const browserOptions = {
  skip: !playwright && 'V4 requires Playwright and an installed browser; set EAC_BROWSER_TEST_PLAYWRIGHT',
};

function loadAssets() {
  const kernel = join(assetsRoot, 'dsh-desktop/node_modules/@deepseek-ai');
  const layoutSource = readFileSync(join(kernel, 'dsh-client-ui-layout/lib/client.js'), 'utf8');
  const cssLiteral = layoutSource.match(/const css = ("(?:[^"\\]|\\.)*");/);
  assert.ok(cssLiteral, 'installed kernel must provide its real layout CSS');
  const layout = JSON.parse(cssLiteral[1]);
  const className = (name: string) => {
    const match = layout.match(new RegExp('\\.([\\w-]+_' + name + ')\\{'));
    assert.ok(match, `kernel layout class missing: ${name}`);
    return match[1];
  };
  const frontendDir = join(kernel, 'dsh-web-frontend/dist/assets');
  const frontendFile = readdirSync(frontendDir).find(name => /^index-.*\.css$/.test(name));
  assert.ok(frontendFile, 'installed frontend base stylesheet missing');
  const skin = join(assetsRoot, 'tauri-shell/artifacts/resolved/system.default');
  return {
    base: readFileSync(join(frontendDir, frontendFile), 'utf8'),
    layout,
    frame: className('frame'), center: className('centerCol'), handle: className('handle'),
    slots: {
      control: readFileSync(join(skin, 'control-layout.css'), 'utf8'),
      tokens: readFileSync(join(skin, 'style-tokens.css'), 'utf8'),
      states: readFileSync(join(skin, 'style-states.css'), 'utf8'),
    },
  };
}

function titlebarScript() {
  const rust = readFileSync(join(sourceRoot, 'tauri-shell/src/main.rs'), 'utf8');
  const body = rust.slice(rust.indexOf('fn windows_titlebar_marker_js()'));
  const literal = body.match(/format!\(\s*("(?:\\[\s\S]|[^"\\])*")/);
  assert.ok(literal, 'read the actual Rust initialization script, not a copied fixture');
  const height = rust.match(/const TITLE_BAR_HEIGHT_PX: u32 = (\d+);/);
  const id = rust.match(/const TITLE_BAR_STYLE_ID: &str = "([^"]+)";/);
  assert.ok(height && id);
  return JSON.parse(literal[1].replace(/\\\r?\n/g, ''))
    .replaceAll('{height}', height[1]).replaceAll('{style_id}', id[1])
    .replaceAll('{{', '{').replaceAll('}}', '}');
}

async function pageFor(t: any) {
  const browser = await playwright.chromium.launch({
    headless: true,
    channel: process.env.EAC_BROWSER_TEST_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  });
  t.after(() => browser.close());
  return browser.newPage({ viewport: { width: 1280, height: 800 } });
}

async function installBridge(page: any, slots: Record<string, string>) {
  await page.evaluate((skinSlots: Record<string, string>) => {
    Object.defineProperty(navigator, 'platform', { value: 'Win32', configurable: true });
    (window as any).__DSH_UI_SKIN_MANAGER__ = { enabled: true, generation: 1, slots: skinSlots };
    (window as any).__DSH_WS_RPC__ = () => ({
      send() {}, onNotify() {},
      call: async (method: string) => method === 'win.is-maximized' ? false : {
        iconDataUri: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
      },
    });
  }, slots);
  await page.addScriptTag({ content: titlebarScript() });
  await page.addScriptTag({ content: stripTypeScriptTypes(readFileSync(join(sourceRoot, 'tauri-shell/sidecar/bridge.ts'), 'utf8')) });
}

test('actual kernel and pinned skin reserve exactly one shell titlebar across viewport sizes', browserOptions, async t => {
  const assets = loadAssets();
  const page = await pageFor(t);
  await page.setContent(`<style>${assets.base}</style><style>${assets.layout}</style>
    <div id="root"><div data-slot="root" style="display:contents"><div class="${assets.frame}">
      <div id="content" class="${assets.center}"><span>session</span><button id="footer" style="margin-top:auto">settings</button></div>
      <div id="resize-handle" class="${assets.handle}"></div>
    </div></div></div>`);
  await installBridge(page, assets.slots);
  for (const viewport of [{ width: 1280, height: 800 }, { width: 800, height: 470 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    const rects = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector)!;
        const bounds = element.getBoundingClientRect();
        return { top: bounds.top, bottom: bounds.bottom, height: bounds.height };
      };
      return { bar: rect('#__dsh_desktop_chrome__'), content: rect('#content'), handle: rect('#resize-handle'), footer: rect('#footer') };
    });
    assert.equal(rects.bar.height, 36);
    assert.equal(rects.content.top, rects.bar.bottom, 'content must start immediately below the visible bar');
    assert.equal(rects.handle.top, rects.bar.bottom, 'resize handle must use the same content boundary');
    assert.equal(rects.content.bottom, viewport.height);
    assert.ok(rects.footer.bottom <= viewport.height, 'bottom controls must remain reachable');
  }
  // Skin transactions load after the document-start repair; specificity must hold.
  await page.evaluate((slots: Record<string, string>) => window.dispatchEvent(new CustomEvent('dsh-ui-skin-transaction', {
    detail: { generation: 2, slots },
  })), assets.slots);
  assert.equal(await page.locator('#content').evaluate((node: Element) => node.getBoundingClientRect().top), 36);
});

test('host theme boundaries follow light/dark tokens and preserve shell and explicit plugin colors', browserOptions, async t => {
  const assets = loadAssets();
  const page = await pageFor(t);
  await page.setContent(`<style>${assets.base}</style>
    <style>:root{--dsw-alias-label-primary:#202124} [data-ds-dark-theme]{--dsw-alias-label-primary:#eeeeee}
    .plugin-custom{color:rgb(148, 38, 87)}</style>
    <div id="root"><div data-slot="root"><div data-conversation-scroll><span id="plugin-label">setting</span><span id="plugin-custom" class="plugin-custom">custom</span></div></div></div>
    <div id="dialog" role="dialog"><span id="dialog-label">dialog setting</span></div>
    <div id="dsh-exit-overlay" role="dialog" data-region="overlay" data-control-name="shell-exit"><span id="exit-label">exit</span></div>`);
  await installBridge(page, assets.slots);
  const color = (selector: string) => page.locator(selector).evaluate((node: Element) => getComputedStyle(node).color);
  assert.equal(await color('#plugin-label'), 'rgb(32, 33, 36)');
  assert.equal(await color('#dialog-label'), 'rgb(32, 33, 36)');
  assert.equal(await color('#plugin-custom'), 'rgb(148, 38, 87)');
  const shellColor = await color('#__dsh_desktop_chrome__');
  const exitColor = await color('#exit-label');
  assert.equal(await page.locator('#dsh-exit-overlay').getAttribute('data-dsh-host-theme'), null);
  assert.equal(await page.locator('#__dsh_desktop_chrome__').getAttribute('data-dsh-host-theme'), null);
  await page.evaluate(() => document.documentElement.setAttribute('data-ds-dark-theme', ''));
  assert.equal(await color('#plugin-label'), 'rgb(238, 238, 238)');
  assert.equal(await color('#dialog-label'), 'rgb(238, 238, 238)');
  assert.equal(await color('#plugin-custom'), 'rgb(148, 38, 87)');
  assert.equal(await color('#__dsh_desktop_chrome__'), shellColor);
  assert.equal(await color('#exit-label'), exitColor);
  await page.evaluate(() => {
    const dialog = document.createElement('div');
    dialog.id = 'late-dialog'; dialog.setAttribute('role', 'dialog'); dialog.textContent = 'late';
    document.body.appendChild(dialog);
  });
  await page.waitForFunction(() => document.querySelector('#late-dialog')?.hasAttribute('data-dsh-host-theme'));
  assert.equal(await color('#late-dialog'), 'rgb(238, 238, 238)');
  await page.evaluate((slots: Record<string, string>) => window.dispatchEvent(new CustomEvent('dsh-ui-skin-transaction', {
    detail: { generation: 2, slots },
  })), assets.slots);
  assert.equal(await color('#dialog-label'), 'rgb(238, 238, 238)');
  await page.evaluate(() => document.documentElement.removeAttribute('data-ds-dark-theme'));
  assert.equal(await color('#dialog-label'), 'rgb(32, 33, 36)');
});

test('shell recovery pages do not acquire host theme boundaries', browserOptions, async t => {
  const assets = loadAssets();
  const page = await pageFor(t);
  await page.setContent('<html class="eac-shell"><body><div id="root">shell content</div><div role="dialog">shell dialog</div></body></html>');
  await installBridge(page, assets.slots);
  assert.equal(await page.locator('[data-dsh-host-theme]').count(), 0);
  assert.equal(await page.locator('#__dsh_host_theme__').count(), 0);
});
