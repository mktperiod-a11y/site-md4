#!/usr/bin/env node
// data/services.json과 src/로 사이트를 만든다.
// 사용법: SITE_URL=https://example.com node scripts/build.mjs [출력 폴더]
// SITE_URL이 없으면 https://site-url.invalid 자리표시를 그대로 둔다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLACEHOLDER = 'https://site-url.invalid';
const TEXT = /\.(html|txt|xml|json|svg|css|js|webmanifest)$/;
const SLUG = /^[a-z0-9-]+$/;

export function loadData(file = 'data/services.json') {
  return validate(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function validate(data) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.updatedAt ?? '')) throw new Error('updatedAt은 YYYY-MM-DD 형식이어야 합니다');
  if (!Array.isArray(data.items) || !data.items.length) throw new Error('items가 비어 있습니다');
  const slugs = new Set();
  for (const [i, it] of data.items.entries()) {
    const where = `items[${i}]`;
    for (const key of ['slug', 'name', 'url', 'score', 'benefit', 'desc']) {
      if (typeof it[key] !== 'string' || !it[key].trim()) throw new Error(`${where}.${key} 값이 없습니다`);
    }
    if (!SLUG.test(it.slug)) throw new Error(`${where}.slug는 영문 소문자·숫자·하이픈만 씁니다: ${it.slug}`);
    if (slugs.has(it.slug)) throw new Error(`${where}.slug가 겹칩니다: ${it.slug}`);
    slugs.add(it.slug);
    if (!/^https:\/\/[^/\s"']+\/\S*$/.test(it.url)) throw new Error(`${where}.url은 https 주소여야 합니다: ${it.url}`);
    if (!Array.isArray(it.tags)) throw new Error(`${where}.tags는 배열이어야 합니다`);
  }
  return data;
}

export const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// 받침이 없거나 ㄹ 받침이면 '로', 그 밖의 받침이면 '으로'
export function ro(word) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return `${word}(으)로`;
  const final = code % 28;
  return `${word}${final === 0 || final === 8 ? '로' : '으로'}`;
}

function rankCard(it, i) {
  const n = String(i + 1).padStart(2, '0');
  const name = escape(it.name);
  const tags = it.tags.map((t) => `#${escape(t)}`).join('　');
  return `        <li class="rank-card${i < 2 ? ' top' : ''}">
          <div class="number">${n}</div>
          <div>
            <div class="card-head">
              <h3>${name}</h3>
              <span class="score">★ ${escape(it.score)}</span>
            </div>
            <p class="desc">${escape(it.desc)}</p>
            <div class="meta">
              <div>
                <span class="tags">${tags}</span>
                <b class="benefit">${escape(it.benefit)}</b>
              </div>
              <a
                class="go"
                href="go/${it.slug}/"
                target="_blank"
                rel="noopener noreferrer sponsored nofollow"
                aria-label="${name} 공식 사이트 새 창으로 열기"
                >공식 사이트 ↗</a
              >
            </div>
          </div>
        </li>`;
}

function goPage(it) {
  const name = escape(it.name);
  const url = escape(it.url);
  return `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <meta http-equiv="refresh" content="0;url=${url}" />
    <title>${escape(ro(it.name))} 이동 중 | 모리디</title>
  </head>
  <body>
    <p>
      ${name} 공식 사이트로 이동 중입니다. 자동으로 이동하지 않으면
      <a
        href="${url}"
        rel="noopener noreferrer sponsored nofollow"
        >여기를 눌러주세요.</a
      >
    </p>
    <script>
      location.replace(${JSON.stringify(it.url)});
    </script>
  </body>
</html>
`;
}

// AI 크롤러용 사이트 안내
function llms({ updatedAt, items }) {
  const ranking = items.map((it, i) => `${i + 1}. ${it.name}: ${it.desc} (${it.benefit})`).join('\n');
  return `# 모리디

> 웹하드의 이용 편의성, 혜택과 서비스 특징을 비교하는 한국어 가이드입니다.

페이지에 표시된 기준일과 각 서비스 공식 안내를 함께 확인해 주세요.

- 사이트: ${PLACEHOLDER}/
- 기준일: ${updatedAt}

## 2026 웹하드 순위

${ranking}
`;
}

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    if (!(key in values)) throw new Error(`알 수 없는 자리: ${m}`);
    return values[key];
  });
}

export function build(outDir, site = '', data = loadData()) {
  site = site.replace(/\/+$/, '');
  if (site && !/^https?:\/\/[^/\s]+(\/[\w.-]+)*$/.test(site)) throw new Error(`사이트 주소 형식 오류: ${site}`);
  const basePath = site ? new URL(site).pathname.replace(/\/+$/, '') : '';
  const { updatedAt, items } = validate(data);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync('src', outDir, { recursive: true });

  const index = path.join(outDir, 'index.html');
  fs.writeFileSync(
    index,
    fill(fs.readFileSync(index, 'utf8'), {
      RANKING: items.map(rankCard).join('\n'),
      COUNT: String(items.length),
      UPDATED: updatedAt.replaceAll('-', '.'),
      UPDATED_ISO: updatedAt,
    }),
  );

  for (const it of items) {
    fs.mkdirSync(path.join(outDir, 'go', it.slug), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'go', it.slug, 'index.html'), goPage(it));
  }

  fs.writeFileSync(
    path.join(outDir, 'robots.txt'),
    `User-agent: *\nAllow: /\nDisallow: ${basePath}/go/\n\nSitemap: ${PLACEHOLDER}/sitemap.xml\n`,
  );
  fs.writeFileSync(
    path.join(outDir, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${PLACEHOLDER}/</loc>
    <lastmod>${updatedAt}</lastmod>
  </url>
</urlset>
`,
  );
  fs.writeFileSync(path.join(outDir, 'sitemap.txt'), `${PLACEHOLDER}/\n`);
  fs.writeFileSync(path.join(outDir, 'llms.txt'), llms(data));

  if (site) {
    for (const file of fs.readdirSync(outDir, { recursive: true })) {
      const full = path.join(outDir, file);
      if (!TEXT.test(file) || !fs.statSync(full).isFile()) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes(PLACEHOLDER)) fs.writeFileSync(full, text.replaceAll(PLACEHOLDER, site));
    }
  }
  return items.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = path.resolve(process.argv[2] ?? '_site');
  const site = process.env.SITE_URL ?? '';
  const count = build(outDir, site);
  if (!site) console.log(`SITE_URL이 없어 사이트 주소를 ${PLACEHOLDER}로 둡니다`);
  console.log(`빌드 완료: ${path.relative(process.cwd(), outDir)}/ (순위 ${count}개, 이동 페이지 ${count}개)`);
}
