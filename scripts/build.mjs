#!/usr/bin/env node
// data/와 src/로 사이트를 만든다.
// 사용법: SITE_URL=https://example.com node scripts/build.mjs [출력 폴더]
// SITE_URL이 없으면 https://site-url.invalid 자리표시를 그대로 둔다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLACEHOLDER = 'https://site-url.invalid';
const TEXT = /\.(html|txt|xml|json|svg|css|js|webmanifest)$/;
const SLUG = /^[a-z0-9-]+$/;
const PARTIALS = '_partials';

export function loadData(file = 'data/services.json') {
  return validate(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function loadFaq(file = 'data/faq.json') {
  const faq = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const [i, f] of faq.entries()) {
    if (!f.q?.trim() || !f.a?.trim()) throw new Error(`faq[${i}]에 질문이나 답이 없습니다`);
  }
  return faq;
}

export function validate(data) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.updatedAt ?? '')) throw new Error('updatedAt은 YYYY-MM-DD 형식이어야 합니다');
  if (!Array.isArray(data.items) || !data.items.length) throw new Error('items가 비어 있습니다');
  const slugs = new Set();
  for (const [i, it] of data.items.entries()) {
    const where = `items[${i}]`;
    for (const key of ['slug', 'name', 'url', 'mark', 'score', 'benefit', 'desc']) {
      if (typeof it[key] !== 'string' || !it[key].trim()) throw new Error(`${where}.${key} 값이 없습니다`);
    }
    if (!SLUG.test(it.slug)) throw new Error(`${where}.slug는 영문 소문자·숫자·하이픈만 씁니다: ${it.slug}`);
    if (slugs.has(it.slug)) throw new Error(`${where}.slug가 겹칩니다: ${it.slug}`);
    slugs.add(it.slug);
    if (!/^https:\/\/[^/\s"']+\/\S*$/.test(it.url)) throw new Error(`${where}.url은 https 주소여야 합니다: ${it.url}`);
    if (!Number.isInteger(it.hue) || it.hue < 0 || it.hue > 360) throw new Error(`${where}.hue는 0~360 정수입니다`);
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

// 화면에 보이는 폭. 한글·한자 등 넓은 글자는 2칸으로 센다.
export function displayWidth(text) {
  let width = 0;
  for (const ch of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(ch) ? 2 : 1;
  return width;
}

// 긴 문장을 띄어쓰기 기준으로 나눠 들여쓴 여러 줄로 만든다.
export function wrap(text, indent, width = 100) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && displayWidth(`${indent}${line} ${word}`) > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => indent + l).join('\n');
}

function rankRow(it, i) {
  const name = escape(it.name);
  const tags = it.tags.map((t) => `<span>#${escape(t)}</span>`).join(' ');
  return `        <li class="row${i < 3 ? ' top' : ''}" style="--hue: ${it.hue}">
          <span class="no">${i + 1}</span>
          <span class="mark" aria-hidden="true">${escape(it.mark)}</span>
          <div class="name">
            <h2>${name}</h2>
            <p class="tags">${tags}</p>
          </div>
          <span class="benefit">${escape(it.benefit)}</span>
          <span class="score" aria-label="별점 ${escape(it.score)}">★ ${escape(it.score)}</span>
          <a
            class="go"
            href="go/${it.slug}/"
            target="_blank"
            rel="noopener noreferrer sponsored nofollow"
            aria-label="${name} 바로가기 (새 창)"
            >바로가기</a
          >
        </li>`;
}

function faqItem(f, i) {
  return `        <details${i === 0 ? ' open' : ''}>
          <summary>${escape(f.q)}</summary>
          <p>
${wrap(escape(f.a), '            ')}
          </p>
        </details>`;
}

function jsonLd({ updatedAt, items }, faq) {
  const site = PLACEHOLDER;
  const title = `웹하드 순위 2026 TOP ${items.length}`;
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${site}/#website`,
        name: '모리디',
        alternateName: 'MORIDEE',
        url: `${site}/`,
        inLanguage: 'ko-KR',
      },
      {
        '@type': 'WebPage',
        '@id': `${site}/#webpage`,
        url: `${site}/`,
        name: title,
        isPartOf: { '@id': `${site}/#website` },
        mainEntity: { '@id': `${site}/#ranking` },
        inLanguage: 'ko-KR',
        dateModified: updatedAt,
      },
      {
        '@type': 'ItemList',
        '@id': `${site}/#ranking`,
        name: title,
        numberOfItems: items.length,
        itemListOrder: 'https://schema.org/ItemListOrderAscending',
        itemListElement: items.map((it, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: it.name,
          url: it.url,
        })),
      },
      {
        '@type': 'FAQPage',
        '@id': `${site}/#faq`,
        mainEntity: faq.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      },
    ],
  };
  return JSON.stringify(data, null, 2)
    .replaceAll('<', '\\u003c')
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n');
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

function llms({ updatedAt, items }, faq) {
  const ranking = items.map((it, i) => `${i + 1}. ${it.name}: ${it.desc} (${it.benefit})`).join('\n');
  const qa = faq.map((f) => `### ${f.q}\n\n${f.a}`).join('\n\n');
  return `# 모리디

> 웹하드의 가입 혜택과 이용 편의성을 비교하는 한국어 웹하드 순위 가이드입니다.

페이지에 표시된 기준일과 각 서비스 공식 안내를 함께 확인해 주세요.

- 사이트: ${PLACEHOLDER}/
- 운영 안내(순위 기준·제휴 안내): ${PLACEHOLDER}/about/
- 기준일: ${updatedAt}

## 웹하드 순위 2026 TOP ${items.length}

${ranking}

## 자주 묻는 질문

${qa}
`;
}

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    if (!(key in values)) throw new Error(`알 수 없는 자리: ${m}`);
    return values[key];
  });
}

function htmlFiles(dir) {
  return fs
    .readdirSync(dir, { recursive: true })
    .filter((f) => f.endsWith('.html') && !f.startsWith(PARTIALS));
}

export function build(outDir, site = '', data = loadData(), faq = loadFaq()) {
  site = site.replace(/\/+$/, '');
  if (site && !/^https?:\/\/[^/\s]+(\/[\w.-]+)*$/.test(site)) throw new Error(`사이트 주소 형식 오류: ${site}`);
  const basePath = site ? new URL(site).pathname.replace(/\/+$/, '') : '';
  const { updatedAt, items } = validate(data);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync('src', outDir, { recursive: true, filter: (src) => path.basename(src) !== PARTIALS });

  const partial = (name) => fs.readFileSync(path.join('src', PARTIALS, `${name}.html`), 'utf8').trimEnd();
  const top3 = items.slice(0, 3).map((it, i) => `${i + 1}위 ${it.name}`);
  const common = {
    COUNT: String(items.length),
    UPDATED: updatedAt.replaceAll('-', '.'),
    UPDATED_ISO: updatedAt,
  };
  const pageValues = {
    ...common,
    DESCRIPTION: escape(
      `웹하드 순위 2026 TOP ${items.length}. ${top3.join(', ')} 등 혜택과 편의성을 한눈에 비교해요.`,
    ),
    SUMMARY: items
      .slice(0, 3)
      .map((it, i) => `${i + 1}위 <strong>${escape(it.name)}</strong>`)
      .join(' ·\n          '),
    RANKING: items.map(rankRow).join('\n'),
    FAQ: faq.map(faqItem).join('\n'),
    JSONLD: jsonLd(data, faq),
  };

  for (const file of htmlFiles(outDir)) {
    const full = path.join(outDir, file);
    const depth = file.split(path.sep).length - 1;
    const values = { ...pageValues, ROOT: depth ? '../'.repeat(depth) : './' };
    values.HEADER = fill(partial('header'), values);
    values.FOOTER = fill(partial('footer'), values);
    fs.writeFileSync(full, fill(fs.readFileSync(full, 'utf8'), values));
  }

  for (const it of items) {
    fs.mkdirSync(path.join(outDir, 'go', it.slug), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'go', it.slug, 'index.html'), goPage(it));
  }

  const pages = ['/', '/about/'];
  fs.writeFileSync(
    path.join(outDir, 'robots.txt'),
    `User-agent: *\nAllow: /\nDisallow: ${basePath}/go/\n\nSitemap: ${PLACEHOLDER}/sitemap.xml\n`,
  );
  fs.writeFileSync(
    path.join(outDir, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map((p) => `  <url>\n    <loc>${PLACEHOLDER}${p}</loc>\n    <lastmod>${updatedAt}</lastmod>\n  </url>`).join('\n')}
</urlset>
`,
  );
  fs.writeFileSync(path.join(outDir, 'sitemap.txt'), pages.map((p) => `${PLACEHOLDER}${p}\n`).join(''));
  fs.writeFileSync(path.join(outDir, 'llms.txt'), llms(data, faq));

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
