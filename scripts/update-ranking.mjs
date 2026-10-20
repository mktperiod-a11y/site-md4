import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pick, validate } from './build.mjs';

const FILE = 'data/services.json';
const ENDPOINT = 'https://naverapihub.apigw.ntruss.com/search-trend/v1/search';
const WEEKS = 5;
const BATCH = 4;
const TRIES = 3;
const STAR_MIN = 3.8;
const STAR_MAX = 4.9;
const POINTS_MIN = 1;
const POINTS_MAX = 22;
const ENOUGH_VOLUME = 0.2;
const SIGNALS = ['convenience', 'billing'];

const key = (name) => name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const sum = (list) => list.reduce((a, b) => a + b, 0);
const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  if (!s.length) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function kstDate(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
}

export function shift(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function pool(data) {
  const hidden = new Set([...(data.blocked ?? []), ...(data.archived ?? [])].map(key));
  return data.items.filter((it) => !hidden.has(key(it.name)));
}

export function summarize(weekly) {
  const interest = sum(weekly.slice(-4));
  const last = weekly.at(-1) ?? 0;
  const before = weekly.slice(-4, -1);
  const base = before.length ? sum(before) / before.length : 0;
  const momentum = base > 0 ? last / base : last > 0 ? 2 : 1;
  return { interest: round(interest, 2), momentum: round(momentum, 3) };
}

export function rankPoints(items, value, top, better = (a, b) => a > b) {
  const scored = items.filter((it) => value(it) != null);
  const points = new Map();
  for (const it of scored) {
    const ahead = scored.filter((o) => better(value(o), value(it))).length;
    points.set(it.slug, top === undefined ? scored.length - ahead : Math.max(top - ahead, 0));
  }
  return points;
}

export function totals(items) {
  const parts = [
    rankPoints(items, (it) => it.interest ?? 0),
    rankPoints(items, (it) => (Number(it.benefitValue) > 0 ? Number(it.benefitValue) : null), 3),
    rankPoints(items, (it) => it.momentum ?? 1, 3),
    ...SIGNALS.map((name) => rankPoints(items, (it) => it[name] ?? null, 3, (a, b) => a < b)),
  ];
  return new Map(items.map((it) => [it.slug, sum(parts.map((p) => p.get(it.slug) ?? 0))]));
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

const changes = (order) => order.filter((it, i) => it.prevRank !== i + 1).length;
const allowed = (order) => order.every((it, i) => i + 1 <= (it.maxRank ?? Infinity));

function* subsets(n, size, from = 0, acc = []) {
  if (acc.length === size) {
    yield acc;
    return;
  }
  for (let i = from; i <= n - (size - acc.length); i += 1) yield* subsets(n, size, i + 1, [...acc, i]);
}

function* permutations(list) {
  if (list.length <= 1) {
    yield list;
    return;
  }
  for (let i = 0; i < list.length; i += 1) {
    for (const rest of permutations([...list.slice(0, i), ...list.slice(i + 1)])) yield [list[i], ...rest];
  }
}

export function limitChanges(chosen, ideal, limit) {
  const target = new Map(ideal.map((it, i) => [it.slug, i]));
  const base = [...chosen].sort(
    (a, b) => (a.prevRank ?? Infinity) - (b.prevRank ?? Infinity) || target.get(a.slug) - target.get(b.slug),
  );
  const cap = Math.max(limit, changes(base));
  const cost = (order) => [sum(order.map((it, i) => Math.abs(i - target.get(it.slug)))), changes(order)];
  let best = null;
  let bestCost = null;
  for (let size = 0; size <= Math.min(limit, base.length); size += 1) {
    for (const spots of subsets(base.length, size)) {
      for (const moved of permutations(spots.map((i) => base[i]))) {
        const order = [...base];
        spots.forEach((spot, j) => {
          order[spot] = moved[j];
        });
        if (!allowed(order) || changes(order) > cap) continue;
        const c = cost(order);
        if (!bestCost || c[0] < bestCost[0] || (c[0] === bestCost[0] && c[1] < bestCost[1])) {
          best = order;
          bestCost = c;
        }
      }
    }
  }
  return best ?? ideal;
}

export function stars(points) {
  let cap = STAR_MAX;
  return points.map((p) => {
    const ratio = Math.min(Math.max((p - POINTS_MIN) / (POINTS_MAX - POINTS_MIN), 0), 1);
    cap = Math.min(cap, Math.round((STAR_MIN + (STAR_MAX - STAR_MIN) * ratio) * 10) / 10);
    return cap.toFixed(1);
  });
}

function previousRanks(data, today) {
  const sameDay = (data.rankedOn ?? data.updatedAt) === today;
  if (sameDay && data.items.some((it) => it.prevRank !== undefined)) {
    return new Map(data.items.filter((it) => it.prevRank != null).map((it) => [it.slug, it.prevRank]));
  }
  return new Map(pick(data).map((it, i) => [it.slug, i + 1]));
}

export function rerank(data, trends, today) {
  const before = previousRanks(data, today);
  const items = data.items.map((it) => ({ ...it, ...(trends[it.slug] ?? {}) }));
  const candidates = pool({ ...data, items });
  const total = totals(candidates);
  const sorted = [...candidates].sort(
    (a, b) => total.get(b.slug) - total.get(a.slug) || (before.get(a.slug) ?? 99) - (before.get(b.slug) ?? 99),
  );
  const chosen = pick({ ...data, items: sorted }).map((it) => ({ ...it, prevRank: before.get(it.slug) ?? null }));
  const ideal = arrange(
    chosen.map(({ prevRank, ...it }) => it),
    chosen.length,
  ).map((it) => chosen.find((c) => c.slug === it.slug));
  const limit = Math.floor(chosen.length * (data.changeLimit ?? 0.4) + 1e-9);
  const finalOrder = limitChanges(chosen, ideal, limit);
  const star = stars(finalOrder.map((it) => total.get(it.slug)));
  const shown = finalOrder.map((it, i) => ({ ...it, score: star[i] }));
  const rest = items.filter((it) => !shown.some((s) => s.slug === it.slug));
  return { ...data, updatedAt: today, rankedOn: today, items: [...shown, ...rest] };
}

export function fillGaps(candidates, fresh) {
  const notes = [];
  const trends = {};
  const got = candidates.filter((it) => fresh.weekly.has(it.slug));
  const summary = new Map(got.map((it) => [it.slug, summarize(fresh.weekly.get(it.slug))]));
  const growth = median(
    got.filter((it) => it.interest > 0).map((it) => summary.get(it.slug).interest / it.interest),
  );
  const fallbackInterest = median([...summary.values()].map((s) => s.interest)) ?? median(
    candidates.filter((it) => it.interest != null).map((it) => it.interest),
  ) ?? 0;
  const topInterest = Math.max(0, ...[...summary.values()].map((s) => s.interest));
  for (const it of candidates) {
    let next = summary.get(it.slug);
    if (!next) {
      const interest = it.interest != null ? it.interest * (growth ?? 1) : fallbackInterest;
      next = { interest: round(interest, 2), momentum: 1 };
      notes.push(`${it.name}: 검색 관심도 대체(${it.interest != null ? '지난 값×전체 변화율' : '중앙값'}), 관심 변화 1`);
    }
    trends[it.slug] = next;
  }
  for (const name of SIGNALS) {
    const ratios = new Map();
    for (const it of candidates) {
      const s = fresh.signals.get(it.slug);
      if (!s || !(s.brand > 0)) continue;
      const enough = s[name] > 0 || trends[it.slug].interest >= topInterest * ENOUGH_VOLUME;
      if (enough) ratios.set(it.slug, round(s[name] / s.brand, 4));
    }
    const middle = median([...ratios.values()]);
    for (const it of candidates) {
      if (ratios.has(it.slug)) {
        trends[it.slug][name] = ratios.get(it.slug);
      } else if (it[name] != null) {
        trends[it.slug][name] = it[name];
        notes.push(`${it.name}: ${name} 지난 값 사용`);
      } else if (middle != null) {
        trends[it.slug][name] = middle;
        notes.push(`${it.name}: ${name} 중앙값 사용`);
      }
    }
  }
  return { trends, notes };
}

export function period(today) {
  const day = new Date(`${today}T00:00:00Z`).getUTCDay();
  const endDate = shift(today, -(day === 0 ? 7 : day));
  return { startDate: shift(endDate, -(7 * WEEKS - 1)), endDate };
}

export function align(points, startDate) {
  const weeks = Array.from({ length: WEEKS }, (_, i) => shift(startDate, 7 * i));
  const byDate = new Map(points.map((p) => [p.period, p.ratio]));
  if (points.some((p) => byDate.has(p.period) && weeks.includes(p.period))) return weeks.map((w) => byDate.get(w) ?? 0);
  const values = points.map((p) => p.ratio).slice(-WEEKS);
  return [...Array(WEEKS - values.length).fill(0), ...values];
}

export function format(data) {
  return `${JSON.stringify(data, null, 2).replace(/\[\n\s+((?:"[^"\n]*",?\s*)+)\]/g, (_, body) =>
    `[${body.trim().split(/,\s*/).join(', ')}]`,
  )}\n`;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function request(groups, startDate, endDate) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: {
          'Content-Type': 'application/json',
          'X-NCP-APIGW-API-KEY-ID': process.env.NAVER_CLIENT_ID,
          'X-NCP-APIGW-API-KEY': process.env.NAVER_CLIENT_SECRET,
        },
        body: JSON.stringify({ startDate, endDate, timeUnit: 'week', keywordGroups: groups }),
      });
      if (!res.ok) throw new Error(`응답 ${res.status}`);
      const body = await res.json();
      return new Map(body.results.map((r) => [r.title, align(r.data ?? [], startDate)]));
    } catch (err) {
      if (attempt >= TRIES) throw err;
      await wait(2000 * 2 ** (attempt - 1));
    }
  }
}

async function collect(candidates, signals, today) {
  const { startDate, endDate } = period(today);
  const fresh = { weekly: new Map(), signals: new Map() };
  const errors = [];
  const byInterest = [...candidates].sort((a, b) => (b.interest ?? 0) - (a.interest ?? 0));
  const [anchor, ...others] = byInterest;
  let anchorTotal = 0;
  for (let i = 0; i < Math.max(others.length, 1); i += BATCH) {
    const batch = [anchor, ...others.slice(i, i + BATCH)];
    try {
      const got = await request(
        batch.map((it) => ({ groupName: it.slug, keywords: [it.name] })),
        startDate,
        endDate,
      );
      const base = sum(got.get(anchor.slug) ?? []);
      if (!base) throw new Error('기준 업체 값이 0');
      if (!anchorTotal) anchorTotal = base;
      for (const it of batch) {
        if (!fresh.weekly.has(it.slug) && got.has(it.slug)) {
          fresh.weekly.set(it.slug, got.get(it.slug).map((v) => (v * anchorTotal) / base));
        }
      }
    } catch (err) {
      errors.push(`검색 관심도 ${batch.map((it) => it.name).join('·')}: ${err.message}`);
    }
  }
  for (const it of candidates) {
    try {
      const got = await request(
        [
          { groupName: 'brand', keywords: [it.name] },
          ...SIGNALS.map((name) => ({ groupName: name, keywords: signals[name].map((w) => `${it.name} ${w}`) })),
        ],
        startDate,
        endDate,
      );
      const recent = (name) => sum((got.get(name) ?? []).slice(-4));
      fresh.signals.set(it.slug, Object.fromEntries(['brand', ...SIGNALS].map((name) => [name, recent(name)])));
    } catch (err) {
      errors.push(`${it.name} 편의성·해지 검색: ${err.message}`);
    }
  }
  return { fresh, errors };
}

async function main() {
  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
    throw new Error('NAVER_CLIENT_ID와 NAVER_CLIENT_SECRET이 필요합니다');
  }
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const today = kstDate();
  const candidates = pool(data);
  const { fresh, errors } = await collect(candidates, data.signals, today);
  const { trends, notes } = fillGaps(candidates, fresh);
  for (const line of [...errors, ...notes]) console.log(`::warning::${line}`);
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
