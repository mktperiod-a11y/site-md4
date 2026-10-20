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
  roll,
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
    out[it.slug] = summarize(Array.from({ length: 5 }, () => rnd() * 100));
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
    assert.ok(shown.filter((it, i) => it.prevRank !== i + 1).length <= 6);
    assert.equal(shown[0].score, '4.9');
    shown.forEach((it, i) => {
      if (it.prevRank != null) assert.ok(Math.abs(i + 1 - it.prevRank) <= 9);
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

test('같은 값은 같은 점수를 받는다', () => {
  const items = [
    { slug: 'a', v: 5 },
    { slug: 'b', v: 5 },
    { slug: 'c', v: 1 },
    { slug: 'd', v: null },
  ];
  assert.deepEqual([...rankPoints(items, (it) => it.v, 3)], [['a', 3], ['b', 3], ['c', 1]]);
});

test('바뀌는 업체 수를 제한하고, 그 안에서 점수 순서에 가깝게 고른다', () => {
  const chosen = ['a', 'b', 'c', 'd', 'e', 'f'].map((slug, i) => ({ slug, prevRank: i + 1 }));
  const ideal = ['f', 'e', 'd', 'c', 'b', 'a'].map((slug) => chosen.find((it) => it.slug === slug));
  const order = limitChanges(chosen, ideal, 2);
  assert.equal(order.filter((it, i) => it.prevRank !== i + 1).length, 2);
  assert.deepEqual(
    order.map((it) => it.slug),
    ['f', 'b', 'c', 'd', 'e', 'a'],
  );
});

test('많이 움직일수록 비용이 커서, 큰 이동은 점수 차가 클 때만 일어난다', () => {
  const chosen = Array.from({ length: 10 }, (_, i) => ({ slug: `s${i + 1}`, prevRank: i + 1 }));
  const last = chosen[9];
  const ideal = [last, ...chosen.slice(0, 9)];
  const order = limitChanges(chosen, ideal, 6);
  const moved = 10 - (order.indexOf(last) + 1);
  assert.ok(moved > 0 && moved < 9);
  const capped = limitChanges(chosen, ideal, 10, 2);
  assert.ok(10 - (capped.indexOf(last) + 1) <= 2);
});

test('maxRank는 점수보다 먼저 지킨다', () => {
  const order = arrange([{ slug: 'a' }, { slug: 'b' }, { slug: 'c', maxRank: 1 }]);
  assert.deepEqual(
    order.map((it) => it.slug),
    ['c', 'a', 'b'],
  );
});

test('검색 관심도를 하나라도 못 받으면 API 값을 섞지 않고 모두 지난 값을 쓴다', () => {
  const candidates = [
    { slug: 'a', name: 'A', interest: 100, momentum: 1.2 },
    { slug: 'b', name: 'B', interest: 50 },
    { slug: 'c', name: 'C' },
  ];
  const fresh = {
    weekly: new Map([
      ['a', [0, 50, 50, 50, 50]],
      ['b', [0, 25, 25, 25, 25]],
    ]),
  };
  const { trends, notes } = fillGaps(candidates, fresh);
  assert.deepEqual(trends.a, { interest: 100, momentum: null });
  assert.deepEqual(trends.b, { interest: 50, momentum: null });
  assert.deepEqual(trends.c, { interest: 50, momentum: null });
  assert.equal(notes.length, 2);
});

test('API를 전혀 부르지 못해도 지난 값만으로 계산한다', () => {
  const data = loadData();
  const { trends } = fillGaps(pool(data), { weekly: new Map() });
  const next = rerank(data, trends, '2026-10-26');
  const shown = next.items.slice(0, next.shown);
  assert.equal(shown.length, data.shown);
  assert.ok(shown.findIndex((it) => it.slug === 'ondisk') < 4);
  assert.ok(shown.every((it) => it.momentum === null));
});

test('주간 값은 날짜에 맞춰 빈 주를 0으로 채운다', () => {
  const start = '2026-09-14';
  assert.deepEqual(
    align([{ period: '2026-09-21', ratio: 5 }, { period: '2026-10-12', ratio: 9 }], start),
    [0, 5, 0, 0, 9],
  );
});

test('별점은 1위가 항상 4.9이고, 순위가 낮을수록 같거나 낮다', () => {
  assert.deepEqual(stars([16, 8, 10, 1]), ['4.9', '4.3', '4.3', '3.8']);
  assert.deepEqual(stars([9, 12, 5]), ['4.9', '4.9', '4.2']);
});

test('편의성·해지 점수는 0~2이고, 같은 날에는 같은 값, 주마다 바뀐다', () => {
  const values = Array.from({ length: 200 }, (_, i) => roll(`2026-10-26:s${i}:convenience`));
  assert.ok(values.every((v) => v >= 0 && v <= 2));
  for (const v of [0, 1, 2]) assert.ok(values.filter((x) => x === v).length > 40);
  assert.equal(roll('2026-10-26:ondisk:billing'), roll('2026-10-26:ondisk:billing'));
  const weeks = Array.from({ length: 20 }, (_, i) => roll(`${shift('2026-10-26', 7 * i)}:ondisk:billing`));
  assert.ok(new Set(weeks).size > 1);
});

test('완결된 주(월~일)만 받는다', () => {
  assert.deepEqual(period('2026-10-26'), { startDate: '2026-09-21', endDate: '2026-10-25' });
});

test('데이터 파일 형식을 그대로 유지한다', async () => {
  const fs = await import('node:fs');
  assert.equal(format(loadData()), fs.readFileSync('data/services.json', 'utf8'));
});
