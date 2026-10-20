import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pick, validate } from './build.mjs';

const FILE = 'data/services.json';
const ENDPOINT = 'https://naverapihub.apigw.ntruss.com/search-trend/v1/search';
const WEEKS = 5;
const BATCH = 4;
const STAR_MIN = 3.8;
const STAR_MAX = 4.9;
const POINTS_MIN = 1;
const POINTS_MAX = 19;

const key = (name) => name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

export function kstDate(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
}

function shift(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function pool(data) {
  const hidden = new Set([...(data.blocked ?? []), ...(data.archived ?? [])].map(key));
  return data.items.filter((it) => !hidden.has(key(it.name)));
}

export function summarize(weekly) {
  const recent = weekly.slice(-4);
  const interest = recent.reduce((a, b) => a + b, 0);
  const last = weekly.at(-1) ?? 0;
  const before = weekly.slice(-4, -1);
  const base = before.length ? before.reduce((a, b) => a + b, 0) / before.length : 0;
  const momentum = base > 0 ? last / base : last > 0 ? 2 : 1;
  return { interest: round(interest, 2), momentum: round(momentum, 3) };
}

export function rankPoints(items, value, top) {
  const order = [...items].sort((a, b) => value(b) - value(a));
  return new Map(order.map((it, i) => [it.slug, top === undefined ? order.length - i : Math.max(top - i, 0)]));
}

export function totals(items) {
  const search = rankPoints(items, (it) => it.interest ?? 0);
  const benefit = rankPoints(
    items.filter((it) => Number(it.benefitValue) > 0),
    (it) => Number(it.benefitValue),
    3,
  );
  const momentum = rankPoints(items, (it) => it.momentum ?? 1, 3);
  return new Map(
    items.map((it) => [
      it.slug,
      search.get(it.slug) + (benefit.get(it.slug) ?? 0) + momentum.get(it.slug) + (it.editorial ?? 0),
    ]),
  );
}

export function arrange(ranked, limit) {
  const n = ranked.length;
  const window = (it) => {
    const lo = it.prevRank == null ? 1 : Math.max(1, it.prevRank - limit);
    const hi = Math.min(n, it.prevRank == null ? n : it.prevRank + limit, it.maxRank ?? n);
    return { lo, hi };
  };
  const fits = (rest, pos) => {
    for (let k = pos; k <= n; k += 1) {
      if (rest.filter((c) => c.hi <= k).length > k - pos) return false;
    }
    return true;
  };
  const left = ranked.map((it, order) => ({ it, order, ...window(it) }));
  const placed = [];
  for (let pos = 1; pos <= n; pos += 1) {
    const options = [...left].sort((a, b) => a.order - b.order);
    const ok = (c) => c.lo <= pos && fits(left.filter((x) => x !== c), pos);
    const best = options.find(ok) ?? options.find((c) => fits(left.filter((x) => x !== c), pos)) ?? options[0];
    placed.push(best.it);
    left.splice(left.indexOf(best), 1);
  }
  return placed;
}

export function stars(points) {
  let cap = STAR_MAX;
  return points.map((p) => {
    const ratio = Math.min(Math.max((p - POINTS_MIN) / (POINTS_MAX - POINTS_MIN), 0), 1);
    cap = Math.min(cap, Math.round((STAR_MIN + (STAR_MAX - STAR_MIN) * ratio) * 10) / 10);
    return cap.toFixed(1);
  });
}

export function rerank(data, trends, today) {
  const shownBefore = pick(data);
  const before = new Map(shownBefore.map((it, i) => [it.slug, i + 1]));
  const items = data.items.map((it) => ({ ...it, ...(trends[it.slug] ?? {}) }));
  const candidates = pool({ ...data, items });
  const total = totals(candidates);
  const sorted = [...candidates].sort(
    (a, b) => total.get(b.slug) - total.get(a.slug) || (before.get(a.slug) ?? 99) - (before.get(b.slug) ?? 99),
  );
  const chosen = pick({ ...data, items: sorted }).map((it) => ({ ...it, prevRank: before.get(it.slug) ?? null }));
  const finalOrder = arrange(chosen, data.moveLimit ?? 4);
  const star = stars(finalOrder.map((it) => total.get(it.slug)));
  const shown = finalOrder.map((it, i) => ({ ...it, score: star[i] }));
  const rest = items.filter((it) => !shown.some((s) => s.slug === it.slug));
  return { ...data, updatedAt: today, items: [...shown, ...rest] };
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

async function fetchBatch(keywords, startDate, endDate) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-NCP-APIGW-API-KEY-ID': process.env.NAVER_CLIENT_ID,
      'X-NCP-APIGW-API-KEY': process.env.NAVER_CLIENT_SECRET,
    },
    body: JSON.stringify({
      startDate,
      endDate,
      timeUnit: 'week',
      keywordGroups: keywords.map((name) => ({ groupName: name, keywords: [name] })),
    }),
  });
  if (!res.ok) throw new Error(`검색어 트렌드 요청 실패: ${res.status}`);
  const body = await res.json();
  return new Map(body.results.map((r) => [r.title, r.data.map((p) => p.ratio)]));
}

export function period(today) {
  const day = new Date(`${today}T00:00:00Z`).getUTCDay();
  const endDate = shift(today, -(day === 0 ? 7 : day));
  return { startDate: shift(endDate, -(7 * WEEKS - 1)), endDate };
}

export function format(data) {
  return `${JSON.stringify(data, null, 2).replace(/\[\n\s+((?:"[^"\n]*",?\s*)+)\]/g, (_, body) =>
    `[${body.trim().split(/,\s*/).join(', ')}]`,
  )}\n`;
}

export async function collect(names, today) {
  const { startDate, endDate } = period(today);
  const [anchor, ...others] = names;
  const series = new Map();
  let anchorTotal = 0;
  for (let i = 0; i < Math.max(others.length, 1); i += BATCH) {
    const got = await fetchBatch([anchor, ...others.slice(i, i + BATCH)], startDate, endDate);
    const base = (got.get(anchor) ?? []).reduce((a, b) => a + b, 0);
    if (!anchorTotal) anchorTotal = base;
    const scale = base > 0 ? anchorTotal / base : 1;
    for (const [name, values] of got) if (!series.has(name)) series.set(name, values.map((v) => v * scale));
  }
  return series;
}

async function main() {
  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
    throw new Error('NAVER_CLIENT_ID와 NAVER_CLIENT_SECRET이 필요합니다');
  }
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const today = kstDate();
  const candidates = pool(data);
  const series = await collect(
    candidates.map((it) => it.name),
    today,
  );
  const trends = {};
  for (const it of candidates) {
    const weekly = series.get(it.name);
    if (!weekly) throw new Error(`${it.name} 검색량을 받지 못했습니다`);
    trends[it.slug] = summarize(weekly);
  }
  const next = rerank(data, trends, today);
  validate(next);
  fs.writeFileSync(FILE, format(next));
  next.items.slice(0, next.shown).forEach((it, i) => console.log(`${i + 1}. ${it.name} ${it.score}`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
