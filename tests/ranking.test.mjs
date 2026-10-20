import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadData } from '../scripts/build.mjs';
import { arrange, format, period, pool, rerank, stars, summarize } from '../scripts/update-ranking.mjs';

function randomTrends(data, seed) {
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const out = {};
  for (const it of pool(data)) out[it.slug] = summarize(Array.from({ length: 5 }, () => rnd() * 100));
  return out;
}

test('검색량이 어떻게 바뀌어도 제1원칙과 이동 상한을 지킨다', () => {
  const data = loadData();
  let week = data;
  for (let seed = 1; seed <= 300; seed += 1) {
    const next = rerank(week, randomTrends(week, seed), '2026-10-20');
    week = next;
    const shown = next.items.slice(0, next.shown);
    const rankOf = (slug) => shown.findIndex((it) => it.slug === slug) + 1;
    assert.ok(rankOf('ondisk') >= 1 && rankOf('ondisk') <= 4);
    assert.ok(rankOf('kdisk') >= 1 && rankOf('kdisk') <= 6);
    for (const name of data.required) assert.ok(shown.some((it) => it.name === name));
    shown.forEach((it, i) => {
      if (it.prevRank != null) assert.ok(Math.abs(i + 1 - it.prevRank) <= data.moveLimit);
      if (i) assert.ok(Number(it.score) <= Number(shown[i - 1].score));
      assert.ok(Number(it.score) >= data.scoreFloor);
    });
  }
});

test('검색 관심도는 최근 4주 합, 변화율은 지난주와 그 전 3주 평균의 비율이다', () => {
  assert.deepEqual(summarize([10, 10, 20, 30, 40]), { interest: 100, momentum: 2 });
});

test('이동 상한 안에서는 점수 순서를 따른다', () => {
  const order = arrange(
    [
      { slug: 'c', prevRank: 3 },
      { slug: 'a', prevRank: 1 },
      { slug: 'b', prevRank: 2 },
    ],
    4,
  );
  assert.deepEqual(
    order.map((it) => it.slug),
    ['c', 'a', 'b'],
  );
});

test('별점은 3.8~4.9 안에서 순위가 낮을수록 같거나 낮다', () => {
  assert.deepEqual(stars([19, 10, 12, 1]), ['4.9', '4.4', '4.4', '3.8']);
});

test('완결된 주(월~일)만 받는다', () => {
  assert.deepEqual(period('2026-10-26'), { startDate: '2026-09-21', endDate: '2026-10-25' });
});

test('데이터 파일 형식을 그대로 유지한다', async () => {
  const fs = await import('node:fs');
  assert.equal(format(loadData()), fs.readFileSync('data/services.json', 'utf8'));
});
