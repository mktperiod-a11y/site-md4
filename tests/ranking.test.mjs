import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadData } from '../scripts/build.mjs';
import {
  align,
  arrange,
  fillGaps,
  format,
  limitChanges,
  period,
  pool,
  rankPoints,
  rerank,
  shift,
  stars,
  summarize,
} from '../scripts/update-ranking.mjs';

function random(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}

function randomTrends(data, seed) {
  const rnd = random(seed);
  const out = {};
  for (const it of pool(data)) {
    out[it.slug] = {
      ...summarize(Array.from({ length: 5 }, () => rnd() * 100)),
      convenience: rnd() < 0.2 ? undefined : rnd() * 0.1,
      billing: rnd() < 0.2 ? undefined : rnd() * 0.1,
    };
  }
  return out;
}

test('검색량이 어떻게 바뀌어도 제1원칙과 주간 변동 상한을 지킨다', () => {
  const data = loadData();
  let week = data;
  let day = '2026-10-26';
  for (let seed = 1; seed <= 300; seed += 1) {
    const next = rerank(week, randomTrends(week, seed), day);
    const shown = next.items.slice(0, next.shown);
    const rankOf = (slug) => shown.findIndex((it) => it.slug === slug) + 1;
    assert.ok(rankOf('ondisk') >= 1 && rankOf('ondisk') <= 4);
    assert.ok(rankOf('kdisk') >= 1 && rankOf('kdisk') <= 6);
    for (const name of data.required) assert.ok(shown.some((it) => it.name === name));
    assert.ok(shown.filter((it, i) => it.prevRank !== i + 1).length <= 4);
    shown.forEach((it, i) => {
      if (i) assert.ok(Number(it.score) <= Number(shown[i - 1].score));
      assert.ok(Number(it.score) >= data.scoreFloor);
    });
    week = next;
    day = shift(day, 7);
  }
});

test('같은 날 다시 돌려도 지난주 순위를 기준으로 계산한다', () => {
  const data = loadData();
  const trends = randomTrends(data, 7);
  const once = rerank(data, trends, '2026-10-26');
  const twice = rerank(once, trends, '2026-10-26');
  assert.deepEqual(
    twice.items.map((it) => [it.slug, it.prevRank, it.score]),
    once.items.map((it) => [it.slug, it.prevRank, it.score]),
  );
});

test('검색 관심도는 최근 4주 합, 변화율은 지난주와 그 전 3주 평균의 비율이다', () => {
  assert.deepEqual(summarize([10, 10, 20, 30, 40]), { interest: 100, momentum: 2 });
});

test('같은 값은 같은 점수를 받고, 비율은 낮을수록 높은 점수다', () => {
  const items = [
    { slug: 'a', v: 0.01 },
    { slug: 'b', v: 0.01 },
    { slug: 'c', v: 0.05 },
    { slug: 'd', v: null },
  ];
  const points = rankPoints(items, (it) => it.v, 3, (x, y) => x < y);
  assert.deepEqual([...points], [['a', 3], ['b', 3], ['c', 1]]);
});

test('바뀌는 업체는 10곳 중 4곳까지만 두고, 점수 순서에 가장 가깝게 고른다', () => {
  const chosen = ['a', 'b', 'c', 'd', 'e', 'f'].map((slug, i) => ({ slug, prevRank: i + 1 }));
  const ideal = ['f', 'e', 'd', 'c', 'b', 'a'].map((slug) => chosen.find((it) => it.slug === slug));
  const order = limitChanges(chosen, ideal, 2);
  assert.equal(order.filter((it, i) => it.prevRank !== i + 1).length, 2);
  assert.deepEqual(
    order.map((it) => it.slug),
    ['f', 'b', 'c', 'd', 'e', 'a'],
  );
});

test('maxRank는 점수보다 먼저 지킨다', () => {
  const order = arrange(
    [{ slug: 'a' }, { slug: 'b' }, { slug: 'c', maxRank: 1 }],
    3,
  );
  assert.deepEqual(
    order.map((it) => it.slug),
    ['c', 'a', 'b'],
  );
});

test('검색량을 못 받은 업체는 지난 값×전체 변화율, 비율은 지난 값→중앙값으로 채운다', () => {
  const candidates = [
    { slug: 'a', name: 'A', interest: 100, convenience: 0.02 },
    { slug: 'b', name: 'B', interest: 50 },
    { slug: 'c', name: 'C', interest: 10, billing: 0.3 },
  ];
  const fresh = {
    weekly: new Map([
      ['a', [0, 50, 50, 50, 50]],
      ['b', [0, 25, 25, 25, 25]],
    ]),
    signals: new Map([
      ['a', { brand: 200, convenience: 4, billing: 10 }],
      ['b', { brand: 100, convenience: 0, billing: 0 }],
    ]),
  };
  const { trends, notes } = fillGaps(candidates, fresh);
  assert.deepEqual(trends.a, { interest: 200, momentum: 1, convenience: 0.02, billing: 0.05 });
  assert.equal(trends.c.interest, 20);
  assert.equal(trends.c.momentum, 1);
  assert.equal(trends.c.billing, 0.3);
  assert.equal(trends.c.convenience, 0.01);
  assert.ok(notes.length >= 2);
});

test('검색량을 전혀 못 받아도 지난 값으로 계산한다', () => {
  const candidates = [
    { slug: 'a', name: 'A', interest: 100, convenience: 0.02, billing: 0.01 },
    { slug: 'b', name: 'B' },
  ];
  const { trends } = fillGaps(candidates, { weekly: new Map(), signals: new Map() });
  assert.deepEqual(trends.a, { interest: 100, momentum: 1, convenience: 0.02, billing: 0.01 });
  assert.deepEqual(trends.b, { interest: 100, momentum: 1 });
});

test('검색량이 적은 업체의 0은 데이터 부족으로 보고 대체한다', () => {
  const candidates = [
    { slug: 'a', name: 'A' },
    { slug: 'b', name: 'B' },
  ];
  const fresh = {
    weekly: new Map([
      ['a', [0, 100, 100, 100, 100]],
      ['b', [0, 1, 1, 1, 1]],
    ]),
    signals: new Map([
      ['a', { brand: 400, convenience: 8, billing: 4 }],
      ['b', { brand: 4, convenience: 0, billing: 0 }],
    ]),
  };
  const { trends } = fillGaps(candidates, fresh);
  assert.equal(trends.b.convenience, 0.02);
  assert.equal(trends.b.billing, 0.01);
});

test('주간 값은 날짜에 맞춰 빈 주를 0으로 채운다', () => {
  const start = '2026-09-14';
  assert.deepEqual(
    align([{ period: '2026-09-21', ratio: 5 }, { period: '2026-10-12', ratio: 9 }], start),
    [0, 5, 0, 0, 9],
  );
});

test('별점은 3.8~4.9 안에서 순위가 낮을수록 같거나 낮다', () => {
  assert.deepEqual(stars([22, 10, 12, 1]), ['4.9', '4.3', '4.3', '3.8']);
});

test('완결된 주(월~일)만 받는다', () => {
  assert.deepEqual(period('2026-10-26'), { startDate: '2026-09-21', endDate: '2026-10-25' });
});

test('데이터 파일 형식을 그대로 유지한다', async () => {
  const fs = await import('node:fs');
  assert.equal(format(loadData()), fs.readFileSync('data/services.json', 'utf8'));
});
