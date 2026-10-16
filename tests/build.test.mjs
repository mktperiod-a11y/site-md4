import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build, escape, loadData, PLACEHOLDER, ro } from '../scripts/build.mjs';

const SITE = 'https://example.test/sub';

function buildTo(site = SITE, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
  build(dir, site, data);
  return dir;
}

const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');

function walk(dir) {
  return fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile());
}

test('사이트 주소 자리표시와 템플릿 자리가 남지 않는다', () => {
  const dir = buildTo();
  for (const file of walk(dir)) {
    const text = read(dir, file);
    assert.ok(!text.includes(PLACEHOLDER), `${file}에 자리표시가 남음`);
    assert.ok(!/\{\{\w+\}\}/.test(text), `${file}에 템플릿 자리가 남음`);
  }
  assert.match(read(dir, 'index.html'), new RegExp(`<link rel="canonical" href="${SITE}/" />`));
  assert.match(read(dir, 'robots.txt'), /^Disallow: \/sub\/go\/$/m);
  assert.match(read(dir, 'robots.txt'), new RegExp(`^Sitemap: ${SITE}/sitemap.xml$`, 'm'));
  assert.equal(read(dir, 'sitemap.txt'), `${SITE}/\n`);
});

test('순위 카드와 이동 페이지가 데이터와 맞는다', () => {
  const { items, updatedAt } = loadData();
  const dir = buildTo();
  const html = read(dir, 'index.html');
  const cards = [...html.matchAll(/<li class="rank-card[^"]*">[\s\S]*?<h3>([^<]+)<\/h3>[\s\S]*?href="go\/([^/]+)\/"/g)];
  assert.deepEqual(
    cards.map((m) => [m[1], m[2]]),
    items.map((it) => [escape(it.name), it.slug]),
  );
  assert.match(html, new RegExp(`<b>${items.length}개 서비스</b>`));
  assert.match(html, new RegExp(`<time datetime="${updatedAt}">${updatedAt.replaceAll('-', '.')}</time>`));
  for (const it of items) {
    const go = read(dir, `go/${it.slug}/index.html`);
    assert.match(go, /<meta name="robots" content="noindex,nofollow" \/>/);
    assert.ok(go.includes(`content="0;url=${it.url}"`), `${it.slug} 새로고침 주소`);
    assert.ok(go.includes(`location.replace(${JSON.stringify(it.url)})`), `${it.slug} 스크립트 주소`);
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, 'go')).sort(), items.map((it) => it.slug).sort());
});

test('공유·검색용 메타와 보조 파일', () => {
  const { items, updatedAt } = loadData();
  const dir = buildTo();
  const html = read(dir, 'index.html');
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const page = ld['@graph'].find((n) => n['@type'] === 'WebPage');
  assert.equal(page.url, `${SITE}/`);
  assert.equal(page.dateModified, updatedAt);
  assert.match(html, new RegExp(`<meta property="og:image" content="${SITE}/og.png" />`));
  for (const href of [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)" href="([^"]+)"/g)].map((m) => m[1])) {
    assert.ok(fs.existsSync(path.join(dir, href)), `${href} 없음`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'og.png')));
  assert.match(read(dir, '404.html'), new RegExp(`<a href="${SITE}/">`));
  const llms = read(dir, 'llms.txt');
  assert.ok(llms.includes(`- 사이트: ${SITE}/`));
  assert.deepEqual(
    [...llms.matchAll(/^(\d+)\. ([^:]+):/gm)].map((m) => m[2]),
    items.map((it) => it.name),
  );
});

test('SITE_URL이 없으면 자리표시를 그대로 둔다', () => {
  const dir = buildTo('');
  assert.ok(read(dir, 'index.html').includes(`${PLACEHOLDER}/`));
  assert.match(read(dir, 'robots.txt'), /^Disallow: \/go\/$/m);
});

test('잘못된 데이터는 빌드를 멈춘다', () => {
  const data = loadData();
  const broken = (patch) => ({ ...data, items: [{ ...data.items[0], ...patch }, ...data.items.slice(1)] });
  assert.throws(() => buildTo(SITE, broken({ slug: 'Bad Slug' })), /slug/);
  assert.throws(() => buildTo(SITE, broken({ url: 'http://example.test/' })), /https/);
  assert.throws(() => buildTo(SITE, { ...data, items: [data.items[0], data.items[0]] }), /겹칩니다/);
  assert.throws(() => buildTo('ftp://example.test'), /형식 오류/);
});

test('이름의 HTML 특수 문자를 이스케이프한다', () => {
  const data = loadData();
  const dir = buildTo(SITE, { ...data, items: [{ ...data.items[0], name: '<b>"A&B"</b>' }] });
  assert.match(read(dir, 'index.html'), /<h3>&lt;b&gt;&quot;A&amp;B&quot;&lt;\/b&gt;<\/h3>/);
});

test('이동 페이지 제목의 조사', () => {
  assert.equal(ro('파일썬'), '파일썬으로');
  assert.equal(ro('꿀파일'), '꿀파일로');
  assert.equal(ro('온디스크'), '온디스크로');
  assert.equal(ro('ABC'), 'ABC(으)로');
});
