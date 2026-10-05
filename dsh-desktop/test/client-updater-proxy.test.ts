import test from 'node:test';
import assert from 'node:assert/strict';

import { githubProxyUrl, downloadUrls } from '../client-updater.js';

const GITHUB_ASSET =
  'https://github.com/Ebony-Vinyl/Deepseek-Harness-EAC/releases/download/v4.4/Deepseek-Harness-EAC-Setup-x64.exe';
const GITEE_ASSET =
  'https://gitee.com/zouyuxuan122/Deepseek-Harness-EAC/releases/download/v4.4/Deepseek-Harness-EAC-Setup-x64.exe';

test('githubProxyUrl only proxies GitHub asset URLs', () => {
  assert.equal(
    githubProxyUrl(GITHUB_ASSET),
    'https://gh.geekertao.top/' + GITHUB_ASSET,
  );
  assert.equal(githubProxyUrl(GITEE_ASSET), null);
  assert.equal(githubProxyUrl('https://github.com.evil.example/download.exe'), null);
  assert.equal(githubProxyUrl(''), null);
});

test('downloadUrls puts GitHub direct first, proxy as fallback (5.3.3: 直连优先)', () => {
  // 5.3.3：第三方加速域名易主/失效会拖垮全部下载，代理从首选降级为直连
  // 失败后的候选（顺序：GitHub 直连 → 代理 → 其他源）。
  assert.deepEqual(downloadUrls(GITHUB_ASSET, [GITEE_ASSET]), [
    GITHUB_ASSET,
    'https://gh.geekertao.top/' + GITHUB_ASSET,
    GITEE_ASSET,
  ]);
});

test('downloadUrls keeps non-GitHub sources unchanged and removes duplicates', () => {
  assert.deepEqual(downloadUrls(GITEE_ASSET, [GITEE_ASSET, '']), [GITEE_ASSET]);
});

test('githubProxyUrl appends cache-busting v+sha256 params', () => {
  assert.equal(
    githubProxyUrl(GITHUB_ASSET, { version: '4.4.1', sha256: 'abc123' }),
    'https://gh.geekertao.top/' + GITHUB_ASSET + '?v=4.4.1&sha256=abc123',
  );
});

test('githubProxyUrl appends only version when sha256 omitted', () => {
  assert.equal(
    githubProxyUrl(GITHUB_ASSET, { version: '4.4.1' }),
    'https://gh.geekertao.top/' + GITHUB_ASSET + '?v=4.4.1',
  );
});

test('githubProxyUrl without opts keeps plain concatenation (backward compatible)', () => {
  assert.equal(githubProxyUrl(GITHUB_ASSET), 'https://gh.geekertao.top/' + GITHUB_ASSET);
});

test('githubProxyUrl uses & when original URL already has a query', () => {
  assert.equal(
    githubProxyUrl(GITHUB_ASSET + '?foo=1', { version: '4.4.1', sha256: 'abc' }),
    'https://gh.geekertao.top/' + GITHUB_ASSET + '?foo=1&v=4.4.1&sha256=abc',
  );
});

test('githubProxyUrl encodes special characters in params', () => {
  assert.equal(
    githubProxyUrl(GITHUB_ASSET, { version: '4.4.1', sha256: 'a b/c' }),
    'https://gh.geekertao.top/' + GITHUB_ASSET + '?v=4.4.1&sha256=a%20b%2Fc',
  );
});

test('downloadUrls forwards cache-busting opts to the proxied URL only (direct untouched)', () => {
  assert.deepEqual(downloadUrls(GITHUB_ASSET, [GITEE_ASSET], { version: '4.4.1', sha256: 'abc' }), [
    GITHUB_ASSET,
    'https://gh.geekertao.top/' + GITHUB_ASSET + '?v=4.4.1&sha256=abc',
    GITEE_ASSET,
  ]);
});
