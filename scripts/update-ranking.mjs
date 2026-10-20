import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pick, validate } from './build.mjs';

const FILE = 'data/services.json';
const HOST = 'https://naverapihub.apigw.ntruss.com';
const WEEKS = 5;
const BATCH = 4;
const RETRIES = 2;
const STAR_MIN = 3.8;
const STAR_MAX = 4.9;
const POINTS_MIN = 1;
const ROLLS = ['convenience', 'billing'];
const ROLL_MAX = 2;

const key = (name) => name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const sum = (list) => list.reduce((a, b) => a + b, 0);

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

export function rankPoints(items, value, top) {
  const scored = items.filter((it) => value(it) != null);
  const points = new Map();
  for (const it of scored) {
    const ahead = scored.filter((o) => value(o) > value(it)).length;
    points.set(it.slug, top === undefined ? scored.length - ahead : Math.max(top - ahead, 0));
  }
  return points;
}

export function totals(items) {
  const parts = [
    rankPoints(items, (it) => it.interest ?? 0),
    rankPoints(items, (it) => (Number(it.benefitValue) > 0 ? Number(it.benefitValue) : null), 3),
    rankPoints(items, (it) => it.momentum ?? null, 3),
    new Map(items.map((it) => [it.slug, sum(ROLLS.map((name) => it[name] ?? 0))])),
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

const movePenalty = (d) => (d / 3) ** 2;

function assign(items, spots, cost) {
  const size = items.length;
  const best = new Array(1 << size).fill(Infinity);
  const from = new Array(1 << size).fill(-1);
  best[0] = 0;
  for (let mask = 0; mask < 1 << size; mask += 1) {
    if (best[mask] === Infinity) continue;
    const spot = spots[popcount(mask)];
    for (let i = 0; i < size; i += 1) {
      if (mask & (1 << i)) continue;
      const next = mask | (1 << i);
      const c = best[mask] + cost(items[i], spot);
      if (c < best[next]) {
        best[next] = c;
        from[next] = i;
      }
    }
  }
  const full = (1 << size) - 1;
  if (best[full] === Infinity) return null;
  const placed = new Map();
  for (let mask = full; mask; mask &= ~(1 << from[mask])) placed.set(spots[popcount(mask) - 1], items[from[mask]]);
  return { cost: best[full], placed };
}

const popcount = (n) => {
  let c = 0;
  for (let m = n; m; m &= m - 1) c += 1;
  return c;
};

export function limitChanges(chosen, ideal, limit, maxMove = Infinity) {
  const n = chosen.length;
  const target = new Map(ideal.map((it, i) => [it.slug, i + 1]));
  const cost = (it, pos) => {
    if (pos > (it.maxRank ?? Infinity)) return Infinity;
    if (it.prevRank == null) return Math.abs(pos - target.get(it.slug));
    const d = Math.abs(pos - it.prevRank);
    if (d > maxMove) return Infinity;
    return Math.abs(pos - target.get(it.slug)) + movePenalty(d);
  };
  const fixable = chosen.filter((it) => it.prevRank != null && it.prevRank <= n);
  const cap = Math.max(limit, n - fixable.length);
  let best = null;
  let bestCost = Infinity;
  for (let mask = 0; mask < 1 << fixable.length; mask += 1) {
    const fixed = fixable.filter((_, i) => mask & (1 << i));
    if (n - fixed.length > cap) continue;
    const taken = new Set(fixed.map((it) => it.prevRank));
    if (taken.size !== fixed.length) continue;
    const base = sum(fixed.map((it) => cost(it, it.prevRank)));
    if (base === Infinity) continue;
    const movers = chosen.filter((it) => !fixed.includes(it));
    const spots = Array.from({ length: n }, (_, i) => i + 1).filter((p) => !taken.has(p));
    const result = assign(movers, spots, cost);
    if (!result) continue;
    const total = base + result.cost + (n - fixed.length) * 1e-6;
    if (total < bestCost) {
      bestCost = total;
      best = Array.from({ length: n }, (_, i) =>
        taken.has(i + 1) ? fixed.find((it) => it.prevRank === i + 1) : result.placed.get(i + 1),
      );
    }
  }
  return best ?? ideal;
}

export function stars(points) {
  const top = Math.max(...points);
  let cap = STAR_MAX;
  return points.map((p, i) => {
    if (i === 0) return STAR_MAX.toFixed(1);
    const ratio = top > POINTS_MIN ? Math.min(Math.max((p - POINTS_MIN) / (top - POINTS_MIN), 0), 1) : 1;
    cap = Math.min(cap, Math.round((STAR_MIN + (STAR_MAX - STAR_MIN) * ratio) * 10) / 10);
    return cap.toFixed(1);
  });
}

export function roll(seed) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  h = Math.imul(h ^ (h >>> 15), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^ (h >>> 16)) >>> 0) % (ROLL_MAX + 1);
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
  const items = data.items.map((it) => ({
    ...it,
    ...(trends[it.slug] ?? {}),
    ...Object.fromEntries(ROLLS.map((name) => [name, roll(`${today}:${it.slug}:${name}`)])),
  }));
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
  const limit = Math.floor(chosen.length * (data.changeLimit ?? 0.6) + 1e-9);
  const finalOrder = limitChanges(chosen, ideal, limit, data.moveLimit ?? 9);
  const star = stars(finalOrder.map((it) => total.get(it.slug)));
  const shown = finalOrder.map((it, i) => ({ ...it, score: star[i] }));
  const rest = items.filter((it) => !shown.some((s) => s.slug === it.slug));
  return { ...data, updatedAt: today, rankedOn: today, items: [...shown, ...rest] };
}

export function fillGaps(candidates, fresh) {
  const notes = [];
  const trends = {};
  const complete = candidates.every((it) => fresh.weekly.has(it.slug));
  const stored = candidates.filter((it) => it.interest != null).map((it) => it.interest);
  const lowest = stored.length ? Math.min(...stored) : 0;
  if (!complete) notes.push('검색 관심도를 다 받지 못해 모든 업체에 지난 값을 쓰고, 관심 변화 점수는 이번 주에 뺀다');
  for (const it of candidates) {
    if (complete) {
      trends[it.slug] = summarize(fresh.weekly.get(it.slug));
    } else {
      trends[it.slug] = { interest: it.interest ?? lowest, momentum: null };
      if (it.interest == null) notes.push(`${it.name}: 지난 검색 관심도가 없어 가장 낮은 값을 쓴다`);
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

async function call(path, init = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${HOST}${path}`, {
        ...init,
        signal: AbortSignal.timeout(20000),
        headers: {
          'Content-Type': 'application/json',
          'X-NCP-APIGW-API-KEY-ID': process.env.NAVER_CLIENT_ID,
          'X-NCP-APIGW-API-KEY': process.env.NAVER_CLIENT_SECRET,
        },
      });
      if (!res.ok) {
        const err = new Error(`응답 ${res.status}`);
        err.final = res.status >= 400 && res.status < 500 && res.status !== 429;
        throw err;
      }
      return await res.json();
    } catch (err) {
      if (err.final || attempt > RETRIES) throw err;
      await wait(2000 * 2 ** (attempt - 1));
    }
  }
}

async function request(groups, startDate, endDate) {
  const body = await call('/search-trend/v1/search', {
    method: 'POST',
    body: JSON.stringify({ startDate, endDate, timeUnit: 'week', keywordGroups: groups }),
  });
  return new Map(body.results.map((r) => [r.title, align(r.data ?? [], startDate)]));
}

async function collect(candidates, today) {
  const { startDate, endDate } = period(today);
  const fresh = { weekly: new Map() };
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
  return { fresh, errors };
}

async function main() {
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const today = kstDate();
  const candidates = pool(data);
  const keys = process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET;
  const { fresh, errors } = keys
    ? await collect(candidates, today)
    : { fresh: { weekly: new Map() }, errors: ['API 키가 없어 호출하지 않음'] };
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
