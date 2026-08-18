import test from 'node:test';
import assert from 'node:assert/strict';
import {
  demandProgress, progressText, DEMAND_STATUS_LABEL,
  type DemandItemLike, type DemandItemStatus,
} from './purchase-demand.ts';

const it = (status: DemandItemStatus, name = ''): DemandItemLike =>
  ({ status, item_name: name });

// ── 三個狀態 ──────────────────────────────────────

test('★ 一項都沒進請款 → 尚未採購', () => {
  const p = demandProgress([it('pending', '垃圾袋'), it('pending', '抹布')]);
  assert.equal(p.status, 'open');
  assert.equal(p.label, '尚未採購');
});

test('詢價過但還沒進請款，仍然是尚未採購', () => {
  // 詢價是會計的中間動作，對提需求的人來說東西還是沒買
  const p = demandProgress([it('quoted', '垃圾袋'), it('pending', '抹布')]);
  assert.equal(p.status, 'open');
});

test('★ 有些進請款、有些還沒 → 部分採購', () => {
  const p = demandProgress([it('requested', '洗衣精'), it('pending', '抹布')]);
  assert.equal(p.status, 'partial');
  assert.equal(p.label, '部分採購');
});

test('★ 全部進請款 → 採購中（不是「完成」）', () => {
  // 進請款只代表會計開始處理，東西還沒到、錢也還沒付
  const p = demandProgress([it('requested', '洗衣精'), it('requested', '拖把')]);
  assert.equal(p.status, 'done');
  assert.equal(p.label, '採購中');
  assert.notEqual(p.label, '已完成');
});

test('作廢的單直接回已作廢，不看項目', () => {
  const p = demandProgress([it('pending', 'x')], true);
  assert.equal(p.status, 'cancelled');
  assert.equal(p.label, '已作廢');
});

// ── 已取消的項目不算進分母 ────────────────────────

test('★ 取消的項目不算 —— 其餘全部進請款就是採購中', () => {
  // 算進分母的話那張單會永遠停在 3/5，看起來像還有事沒做
  const p = demandProgress([
    it('requested', 'A'), it('requested', 'B'), it('requested', 'C'),
    it('cancelled', 'D'), it('cancelled', 'E'),
  ]);
  assert.equal(p.status, 'done');
  assert.equal(p.total, 3);
});

test('全部取消 → 尚未採購（沒有有效項目）', () => {
  const p = demandProgress([it('cancelled', 'A'), it('cancelled', 'B')]);
  assert.equal(p.status, 'open');
  assert.equal(p.total, 0);
});

test('★ 空單是尚未採購，不是採購中', () => {
  // 0 === 0 會讓「全部進請款」的判斷成立 —— 而那張單其實是剛建好還沒填
  const p = demandProgress([]);
  assert.equal(p.status, 'open');
});

// ── 還沒買的品名 ──────────────────────────────────

test('★ 部分採購要講得出哪幾樣還沒買', () => {
  // 只給一個 partial 標籤的話，提需求的人還是得點開單子一項一項看
  const p = demandProgress([
    it('requested', '洗衣精'), it('requested', '拖把'),
    it('pending', '垃圾袋'), it('pending', '抹布'), it('pending', '手套'),
  ]);
  assert.deepEqual(p.leftNames, ['垃圾袋', '抹布', '手套']);
  assert.equal(p.taken, 2);
  assert.equal(p.left, 3);
});

test('沒填品名的不進清單，不要出現空字串', () => {
  const p = demandProgress([it('pending', ''), it('pending', '  '), it('pending', '抹布')]);
  assert.deepEqual(p.leftNames, ['抹布']);
});

// ── 摘要文字 ──────────────────────────────────────

test('尚未採購的摘要', () => {
  assert.equal(progressText(demandProgress([it('pending', 'A'), it('pending', 'B')])),
    '2 項待採購');
});

test('採購中的摘要', () => {
  assert.equal(progressText(demandProgress([it('requested', 'A'), it('requested', 'B')])),
    '2 項全部進請款');
});

test('部分採購的摘要要列出還缺什麼', () => {
  const p = demandProgress([
    it('requested', '洗衣精'), it('pending', '垃圾袋'), it('pending', '抹布'),
  ]);
  assert.equal(progressText(p), '已進請款 1 / 3・還缺：垃圾袋、抹布');
});

test('★ 還缺太多樣時只列三樣 —— 列表一列只有一行的高度', () => {
  const p = demandProgress([
    it('requested', 'X'),
    it('pending', 'A'), it('pending', 'B'), it('pending', 'C'),
    it('pending', 'D'), it('pending', 'E'),
  ]);
  assert.equal(progressText(p), '已進請款 1 / 6・還缺：A、B、C 等 5 樣');
});

test('空單的摘要不是「0 項待採購」', () => {
  assert.equal(progressText(demandProgress([])), '還沒有項目');
});

// ── 標籤本身 ──────────────────────────────────────

test('★ done 的標籤是「採購中」不是「已完成」', () => {
  // 資料庫欄位值叫 done，直覺會翻成「已完成」——
  // 然後畫面上就會出現「已完成」卻沒有人拿到東西
  assert.equal(DEMAND_STATUS_LABEL.done, '採購中');
});
