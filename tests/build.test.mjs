import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  build,
  displayWidth,
  escape,
  loadData,
  loadFaq,
  pick,
  PLACEHOLDER,
  rankRow,
  ro,
  wrap,
} from '../scripts/build.mjs';

const SITE = 'https://example.test/sub';
const MAX_WIDTH = 140;

function buildTo(site = SITE, data, faq) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
  build(dir, site, data, faq);
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
  assert.ok(!fs.existsSync(path.join(dir, '_partials')));
  assert.match(read(dir, 'index.html'), new RegExp(`<link rel="canonical" href="${SITE}/" />`));
  assert.match(read(dir, 'robots.txt'), /^Disallow: \/sub\/go\/$/m);
  assert.match(read(dir, 'robots.txt'), new RegExp(`^Sitemap: ${SITE}/sitemap.xml$`, 'm'));
  assert.equal(read(dir, 'sitemap.txt'), `${SITE}/\n`);
});

test('순위 목록과 이동 페이지가 데이터와 맞는다', () => {
  const data = loadData();
  const { updatedAt } = data;
  const items = pick(data);
  const dir = buildTo();
  const html = read(dir, 'index.html');
  const rows = [...html.matchAll(/<li class="row[^"]*"[^>]*>[\s\S]*?<h2>([^<]+)<\/h2>[\s\S]*?href="go\/([^/]+)\/"/g)];
  assert.deepEqual(
    rows.map((m) => [m[1], m[2]]),
    items.map((it) => [escape(it.name), it.slug]),
  );
  assert.equal((html.match(/<li class="row top"/g) ?? []).length, Math.min(3, items.length));
  assert.deepEqual(
    [...html.matchAll(/<a href="#rank-(\d+)"><b>\d+<\/b>([^<]+)<\/a>/g)].map((m) => [m[1], m[2]]),
    items.slice(0, 3).map((it, i) => [String(i + 1), escape(it.name)]),
  );
  for (let i = 1; i <= items.length; i++) assert.match(html, new RegExp(`<li class="row[^"]*" id="rank-${i}">`));
  assert.match(html, new RegExp(`<h1>웹하드 순위 <em>TOP ${items.length}</em></h1>`));
  assert.match(html, new RegExp(`<time datetime="${updatedAt}">${updatedAt.replaceAll('-', '.')}</time>`));
  for (const it of items) {
    const go = read(dir, `go/${it.slug}/index.html`);
    assert.match(go, /<meta name="robots" content="noindex,nofollow" \/>/);
    assert.ok(go.includes(`content="0;url=${it.url}"`), `${it.slug} 새로고침 주소`);
    assert.ok(go.includes(`location.replace(${JSON.stringify(it.url)})`), `${it.slug} 스크립트 주소`);
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, 'go')).sort(), items.map((it) => it.slug).sort());
});

test('자주 묻는 질문이 화면과 구조화 데이터에 함께 들어간다', () => {
  const faq = loadFaq();
  const dir = buildTo();
  const html = read(dir, 'index.html');
  const shown = [...html.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
  assert.deepEqual(shown, faq.map((f) => escape(f.q)));
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const faqPage = ld['@graph'].find((n) => n['@type'] === 'FAQPage');
  assert.deepEqual(
    faqPage.mainEntity.map((q) => [q.name, q.acceptedAnswer.text]),
    faq.map((f) => [f.q, f.a]),
  );
});

test('공유·검색용 메타와 보조 파일', () => {
  const data = loadData();
  const { updatedAt } = data;
  const items = pick(data);
  const dir = buildTo();
  const html = read(dir, 'index.html');
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const page = ld['@graph'].find((n) => n['@type'] === 'WebPage');
  assert.equal(page.url, `${SITE}/`);
  assert.equal(page.dateModified, updatedAt);
  const list = ld['@graph'].find((n) => n['@type'] === 'ItemList');
  assert.deepEqual(
    list.itemListElement.map((e) => [e.position, e.name]),
    items.map((it, i) => [i + 1, it.name]),
  );
  assert.match(html, new RegExp(`<meta property="og:image" content="${SITE}/og.png" />`));
  for (const page of ['index.html']) {
    const text = read(dir, page);
    const base = path.dirname(path.join(dir, page));
    const local = [
      ...[...text.matchAll(/<link rel="(?:icon|apple-touch-icon|stylesheet)" href="([^"]+)"/g)].map((m) => m[1]),
      ...[...text.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]),
      ...[...text.matchAll(/<source media="[^"]*" srcset="([^"]+)"/g)].map((m) => m[1]),
    ];
    for (const href of local) {
      assert.ok(fs.existsSync(path.join(base, href)), `${page}: ${href} 없음`);
    }
  }
  assert.ok(fs.existsSync(path.join(dir, 'og.png')));
  assert.match(read(dir, '404.html'), new RegExp(`<a class="go" href="${SITE}/">`));
  const llms = read(dir, 'llms.txt');
  assert.ok(llms.includes(`- 사이트: ${SITE}/`));
  assert.deepEqual(
    [...llms.matchAll(/^(\d+)\. ([^:]+):/gm)].map((m) => m[2]),
    items.map((it) => it.name),
  );
});

test('페이지 소스가 세로로 읽히고 주석이 없다', () => {
  const dir = buildTo();
  for (const file of walk(dir).filter((f) => /\.(html|css|xml)$/.test(f))) {
    const text = read(dir, file);
    assert.ok(!text.includes('<!--'), `${file}에 HTML 주석이 있음`);
    assert.ok(!/\/\*/.test(text.replace(/https?:\/\//g, '')), `${file}에 CSS·JS 주석이 있음`);
    const code = text.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
    code.split('\n').forEach((line, i) => {
      assert.ok(displayWidth(line) <= MAX_WIDTH, `${file}:${i + 1} 줄이 너무 깁니다(${displayWidth(line)}칸)`);
    });
  }
});

test('보여줄 수, 뺄 곳, 넣을 곳을 지킨다', () => {
  const data = loadData();
  const shown = pick(data);
  assert.equal(shown.length, data.shown);
  const names = shown.map((it) => it.name);
  for (const name of data.required) assert.ok(names.includes(name), `${name}이 빠짐`);
  for (const name of [...data.blocked, ...data.archived]) assert.ok(!names.includes(name), `${name}이 들어감`);

  const item = (name) => ({ ...data.items[0], name, slug: `s${name.charCodeAt(0)}` });
  const items = ['가', '나', '다', '라', '마'].map(item);
  const names3 = (patch) =>
    pick({ ...data, items, shown: 3, blocked: [], required: [], archived: [], ...patch }).map((it) => it.name);
  assert.deepEqual(names3({}), ['가', '나', '다']);
  assert.deepEqual(names3({ required: ['마'] }), ['가', '나', '마']);
  assert.deepEqual(names3({ blocked: [' 나 '], required: ['마'] }), ['가', '다', '마']);
  assert.deepEqual(names3({ archived: ['가'] }), ['나', '다', '라']);

  const base = { ...data, items, shown: 3, blocked: [], required: [], archived: [] };
  assert.throws(() => buildTo(SITE, { ...base, required: ['바'] }), /items에 없습니다/);
  assert.throws(() => buildTo(SITE, { ...base, required: ['가'], blocked: ['가'] }), /함께/);
  assert.throws(() => buildTo(SITE, { ...base, required: ['가'], archived: ['가'] }), /함께/);
  assert.throws(() => buildTo(SITE, { ...base, archived: ['바'] }), /items에 없습니다/);
  assert.throws(() => buildTo(SITE, { ...base, shown: 1, required: ['가', '나'] }), /shown보다/);
  assert.throws(() => buildTo(SITE, { ...base, shown: 0 }), /shown/);

  const dir = buildTo(SITE, { ...base, required: ['마'] });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'go')).sort(), ['s44032', 's45208', 's47560'].sort());
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
  const dir = buildTo(SITE, { ...data, required: [], archived: [], items: [{ ...data.items[0], name: '<b>"A&B"</b>' }] });
  assert.match(read(dir, 'index.html'), /<h2>&lt;b&gt;&quot;A&amp;B&quot;&lt;\/b&gt;<\/h2>/);
});

test('로고가 있으면 이니셜 대신 로고를 넣고, 모바일에는 정사각형 아이콘을 쓴다', () => {
  const it = loadData().items[0];
  const row = rankRow(it, 0, { wide: 'logos/a.webp', app: 'logos/app/a.webp' });
  assert.ok(row.includes('<picture class="mark logo" aria-hidden="true">'));
  assert.ok(row.includes('<source media="(max-width: 860px)" srcset="logos/app/a.webp" />'));
  assert.ok(row.includes('<img src="logos/a.webp" alt="" width="132" height="40" />'));
  assert.ok(!rankRow(it, 0, { wide: 'logos/a.webp' }).includes('<source'));
  assert.ok(rankRow(it, 0).includes(`<span class="mark" aria-hidden="true">${escape(it.mark)}</span>`));
});

test('문장 줄바꿈과 조사', () => {
  const lines = wrap('가나다 라마바 사아자 차카타 파하', '  ', 14).split('\n');
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => displayWidth(l) <= 14));
  assert.equal(ro('파일썬'), '파일썬으로');
  assert.equal(ro('꿀파일'), '꿀파일로');
  assert.equal(ro('온디스크'), '온디스크로');
  assert.equal(ro('ABC'), 'ABC(으)로');
});
