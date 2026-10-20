#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLACEHOLDER = 'https://site-url.invalid';
const TEXT = /\.(html|txt|xml|json|svg|css|js|webmanifest)$/;
const SLUG = /^[a-z0-9-]+$/;
const PARTIALS = '_partials';
const LOGOS = 'logos';
const LOGO_TYPES = ['webp', 'png', 'svg'];
const normalize = (name) => name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

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
  if (typeof data.cycle !== 'string' || !data.cycle.trim()) throw new Error('cycle(점검 주기) 값이 없습니다');
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
    if (!Array.isArray(it.tags)) throw new Error(`${where}.tags는 배열이어야 합니다`);
  }
  const shown = data.shown ?? data.items.length;
  if (!Number.isInteger(shown) || shown < 1) throw new Error('shown은 1 이상의 정수여야 합니다');
  for (const key of ['blocked', 'required']) {
    const list = data[key] ?? [];
    if (!Array.isArray(list) || !list.every((n) => typeof n === 'string' && n.trim())) {
      throw new Error(`${key}는 업체 이름 배열이어야 합니다`);
    }
  }
  const names = new Set(data.items.map((it) => normalize(it.name)));
  const blocked = new Set((data.blocked ?? []).map(normalize));
  for (const name of data.required ?? []) {
    if (!names.has(normalize(name))) throw new Error(`required의 ${name}이(가) items에 없습니다`);
    if (blocked.has(normalize(name))) throw new Error(`${name}이(가) required와 blocked에 함께 있습니다`);
  }
  if ((data.required ?? []).length > shown) throw new Error('required가 shown보다 많습니다');
  if (data.scoreFloor !== undefined && typeof data.scoreFloor !== 'number') throw new Error('scoreFloor는 숫자여야 합니다');
  for (const [i, it] of data.items.entries()) {
    if (it.maxRank !== undefined && !(Number.isInteger(it.maxRank) && it.maxRank >= 1)) {
      throw new Error(`items[${i}].maxRank는 1 이상의 정수여야 합니다`);
    }
    if (it.prevRank !== undefined && it.prevRank !== null && !(Number.isInteger(it.prevRank) && it.prevRank >= 1)) {
      throw new Error(`items[${i}].prevRank는 1 이상의 정수나 null이어야 합니다`);
    }
  }
  const items = pick(data);
  for (const it of items) {
    if (data.scoreFloor !== undefined && Number(it.score) < data.scoreFloor) {
      throw new Error(`${it.name}의 별점 ${it.score}이(가) 하한 ${data.scoreFloor}보다 낮습니다`);
    }
  }
  for (const it of data.items) {
    if (it.maxRank === undefined || blocked.has(normalize(it.name))) continue;
    const rank = items.indexOf(it) + 1;
    if (!rank || rank > it.maxRank) throw new Error(`${it.name}은(는) ${it.maxRank}위 안에 있어야 합니다`);
  }
  return data;
}

export function moveHtml(it, rank) {
  if (it.prevRank === undefined) return '';
  if (it.prevRank === null) return '<span class="move new">NEW</span>';
  const diff = it.prevRank - rank;
  if (!diff) return '<span class="move same" aria-label="순위 변동 없음">-</span>';
  return diff > 0
    ? `<span class="move up" aria-label="${diff}계단 상승">▲${diff}</span>`
    : `<span class="move down" aria-label="${-diff}계단 하락">▼${-diff}</span>`;
}

export function changeSummary(items, n = items.length) {
  const tally = { up: 0, down: 0, fresh: 0 };
  items.slice(0, n).forEach((it, i) => {
    if (it.prevRank === undefined) return;
    if (it.prevRank === null) tally.fresh += 1;
    else if (it.prevRank > i + 1) tally.up += 1;
    else if (it.prevRank < i + 1) tally.down += 1;
  });
  const total = tally.up + tally.down + tally.fresh;
  if (!total) return '<p class="changes">이번 주 순위 변동 없음</p>';
  const parts = [
    tally.up && `<span class="up">▲ 상승 ${tally.up}</span>`,
    tally.down && `<span class="down">▼ 하락 ${tally.down}</span>`,
    tally.fresh && `<span class="new">NEW ${tally.fresh}</span>`,
  ].filter(Boolean);
  const pad = '\n              ';
  return `<p class="changes">${pad}이번 주 변동 <b>${total}곳</b>${pad}${parts.join(pad)}\n            </p>`;
}

export function pick(data) {
  const blocked = new Set((data.blocked ?? []).map(normalize));
  const required = new Set((data.required ?? []).map(normalize));
  const allowed = data.items.filter((it) => !blocked.has(normalize(it.name)));
  const limit = data.shown ?? allowed.length;
  const chosen = new Set(allowed.filter((it) => required.has(normalize(it.name))));
  for (const it of allowed) if (chosen.size < limit) chosen.add(it);
  return allowed.filter((it) => chosen.has(it));
}

export const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function ro(word) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return `${word}(으)로`;
  const final = code % 28;
  return `${word}${final === 0 || final === 8 ? '로' : '으로'}`;
}

export function displayWidth(text) {
  let width = 0;
  for (const ch of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(ch) ? 2 : 1;
  return width;
}

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

function findLogo(slug) {
  const find = (dir) => {
    const ext = LOGO_TYPES.find((e) => fs.existsSync(path.join('src', dir, `${slug}.${e}`)));
    return ext && `${dir}/${slug}.${ext}`;
  };
  return { wide: find(LOGOS), app: find(`${LOGOS}/app`) };
}

function markHtml(it, { wide, app } = {}) {
  const pad = '\n                ';
  const img = (src, cls, w, h) =>
    `<span class="mark logo ${cls}" aria-hidden="true">` +
    `${pad}  <img src="${escape(src)}" alt="" width="${w}" height="${h}" loading="lazy" />` +
    `${pad}</span>`;
  const initial = (cls) => `<span class="mark${cls ? ` ${cls}` : ''}" aria-hidden="true">${escape(it.mark)}</span>`;
  if (!wide && !app) return initial('');
  return [
    wide ? img(wide, 'for-desk', 132, 40) : initial('for-desk'),
    app ? img(app, 'for-app', 40, 40) : initial('for-app'),
  ].join(pad);
}

export function rankRow(it, i, logo) {
  const name = escape(it.name);
  const tags = it.tags.map((t) => `<span>#${escape(t)}</span>`).join(' ');
  const mark = markHtml(it, logo);
  return `            <li class="row${i < 3 ? ' top' : ''}" id="rank-${i + 1}">
              <span class="rank-no">
                <span class="no">${i + 1}</span>${moveHtml(it, i + 1) && `\n                ${moveHtml(it, i + 1)}`}
              </span>
              <div class="service">
                <div class="brand">
                  ${mark.replaceAll('\n                ', '\n                  ')}
                  <h2>${name}</h2>
                </div>
                <div class="meta">
                  <span class="score" aria-label="별점 ${escape(it.score)}">${escape(it.score)}</span>
                  <p class="benefit">${escape(it.benefit)}</p>
                </div>
              </div>
              <div class="act">
                <p class="tags">${tags}</p>
                <a
                  class="go"
                  href="go/${it.slug}/"
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  aria-label="${name} 바로가기 (새 창)"
                  >바로가기</a
                >
              </div>
            </li>`;
}

function faqItem(f, i) {
  return `            <details${i === 0 ? ' open' : ''}>
              <summary>${escape(f.q)}</summary>
              <p>
${wrap(escape(f.a), '                ')}
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
        rel="noopener noreferrer nofollow"
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

> 웹하드의 검색 관심도와 가입 혜택을 비교하는 한국어 웹하드 순위 가이드입니다.

페이지에 표시된 기준일과 각 서비스 공식 안내를 함께 확인해 주세요.

- 사이트: ${PLACEHOLDER}/
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

function hideAddress(outDir) {
  const findBase = `    <script>
      document.write('<base href="/' + location.pathname.split('/')[1] + '/" />');
    </script>`;
  for (const file of htmlFiles(outDir)) {
    const full = path.join(outDir, file);
    let text = fs.readFileSync(full, 'utf8')
      .split('\n')
      .filter((line) => !/rel="canonical"|property="og:url"|property="og:image/.test(line))
      .join('\n')
      .replace('content="summary_large_image"', 'content="summary"');
    if (file === '404.html') {
      text = text
        .replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n${findBase}`)
        .replaceAll(`href="${PLACEHOLDER}/"`, 'href="./"')
        .replaceAll(`${PLACEHOLDER}/`, '');
    }
    fs.writeFileSync(full, text.replaceAll(`${PLACEHOLDER}/`, './').replaceAll(PLACEHOLDER, '.'));
  }
}

export function build(outDir, site = '', data = loadData(), faq = loadFaq()) {
  site = site.replace(/\/+$/, '');
  if (site && !/^https?:\/\/[^/\s]+(\/[\w.-]+)*$/.test(site)) throw new Error(`사이트 주소 형식 오류: ${site}`);
  const basePath = site ? new URL(site).pathname.replace(/\/+$/, '') : '';
  const hidden = Boolean(site) && /\.github\.io$/i.test(new URL(site).hostname);
  const { updatedAt } = validate(data);
  const items = pick(data);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync('src', outDir, { recursive: true, filter: (src) => path.basename(src) !== PARTIALS });

  const partial = (name) => fs.readFileSync(path.join('src', PARTIALS, `${name}.html`), 'utf8').trimEnd();
  const top3 = items.slice(0, 3).map((it, i) => `${i + 1}위 ${it.name}`);
  const common = {
    COUNT: String(items.length),
    UPDATED: updatedAt.replaceAll('-', '.'),
    UPDATED_ISO: updatedAt,
    CYCLE: escape(data.cycle),
  };
  const pageValues = {
    ...common,
    DESCRIPTION: escape(
      `웹하드 순위 2026 TOP ${items.length}. ${top3.join(', ')} 등 검색 관심도와 혜택을 한눈에 비교해요.`,
    ),
    RANKING: items.map((it, i) => rankRow(it, i, findLogo(it.slug))).join('\n'),
    TOP3: items
      .slice(0, 3)
      .map((it, i) => `            <li>\n              <a href="#rank-${i + 1}"><b>${i + 1}</b>${escape(it.name)}</a>\n            </li>`)
      .join('\n'),
    FAQ: faq.map(faqItem).join('\n'),
    CHANGES: changeSummary(items),
    JSONLD: jsonLd({ updatedAt, items }, faq),
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

  const pages = ['/'];
  if (hidden) {
    fs.writeFileSync(path.join(outDir, 'robots.txt'), 'User-agent: *\nAllow: /\n');
    fs.writeFileSync(path.join(outDir, 'llms.txt'), llms({ updatedAt, items }, faq).replace(/^- 사이트: .*\n/m, ''));
    hideAddress(outDir);
    return items.length;
  }
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
  fs.writeFileSync(path.join(outDir, 'llms.txt'), llms({ updatedAt, items }, faq));

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
