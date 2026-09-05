import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  demandProgress, progressText, demandClass,
  DEMAND_STATUS_LABEL, DEMAND_STATUS_CLASS, DEMAND_PAID_CLASS, ITEM_STATUS_LABEL,
  manualStatusOptions, manualStatusPatch, manualStatusNote, isOrphanRequested,
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

// ══════════════════════════════════════════════════════════
// 第四個狀態：已採購（2026-09-05）
// ══════════════════════════════════════════════════════════

describe('已採購 —— 顯示字，不是第五個 status 值', () => {
  /*
   * ★★★ 加第五個 `status` 值要改資料庫 check、`demand_rollup`、
   *   前端三個地方 —— 而這件事只是要讓人看得懂那一行字。
   *   混進 status 的話，寫回資料庫時會撞 check 而且訊息看不懂。
   */
  test('★★★ 全部採購完時 status 還是 done，只有 label 變', () => {
    const p = demandProgress([it('done', 'A'), it('done', 'B')]);
    assert.equal(p.status, 'done');
    assert.equal(p.label, '已採購');
  });

  test('★ 一項送審一項還在請款中 → 還是「採購中」', () => {
    // 寫成 paid > 0 的話五項裡一項送審就會顯示已採購
    const p = demandProgress([it('done', 'A'), it('requested', 'B')]);
    assert.equal(p.label, '採購中');
    assert.equal(p.paid, 1);
    assert.equal(p.taken, 2);
  });

  test('全部只是進請款、都還沒送審 → 採購中', () => {
    const p = demandProgress([it('requested', 'A'), it('requested', 'B')]);
    assert.equal(p.label, '採購中');
    assert.equal(p.paid, 0);
  });

  test('★ 還有沒買的就不算 —— 部分採購優先', () => {
    const p = demandProgress([it('done', 'A'), it('pending', 'B')]);
    assert.equal(p.status, 'partial');
    assert.equal(p.label, '部分採購');
  });

  test('★ 空單不會被判成已採購', () => {
    // taken === paid === 0 時 0 === 0 會成立
    assert.equal(demandProgress([]).label, '尚未採購');
  });

  test('已採購用綠色，其餘照原本的', () => {
    assert.equal(demandClass(demandProgress([it('done', 'A')])), DEMAND_PAID_CLASS);
    assert.equal(demandClass(demandProgress([it('requested', 'A')])), DEMAND_STATUS_CLASS.done);
    assert.equal(demandClass(demandProgress([it('pending', 'A')])), DEMAND_STATUS_CLASS.open);
  });

  test('項目的 done 叫「已採購」不叫「已完成」', () => {
    assert.equal(ITEM_STATUS_LABEL.done, '已採購');
  });

  test('摘要文字三種都對', () => {
    assert.equal(progressText(demandProgress([it('done', 'A'), it('done', 'B')])), '2 項全部採購完');
    assert.equal(progressText(demandProgress([it('requested', 'A'), it('requested', 'B')])), '2 項全部進請款');
    assert.equal(progressText(demandProgress([it('done', 'A'), it('requested', 'B')])),
      '2 項全部進請款・已採購 1');
  });
});

// ══════════════════════════════════════════════════════════
// 會計手動改狀態
// ══════════════════════════════════════════════════════════

describe('手動改狀態（2026-09-05）', () => {
  const linked = { status: 'requested' as DemandItemStatus, request_item_id: 'r1' };
  const free = { status: 'pending' as DemandItemStatus, request_item_id: null };

  /*
   * ★★★ 不清 request_item_id 的話會留下「未採購但接著請款單」的項目 ——
   *   它可以被再帶一次（isTakeable('pending') 是 true），
   *   於是同一筆錢出現在兩張請款單上。
   */
  test('★★★ 從已進請款退回未採購，一定要清掉關聯', () => {
    assert.deepEqual(manualStatusPatch('pending', true),
      { status: 'pending', request_item_id: null });
  });

  test('★★ 改成已採購不動關聯 —— 那張請款單還在', () => {
    const p = manualStatusPatch('done', true);
    assert.equal(p.status, 'done');
    assert.equal('request_item_id' in p, false);
  });

  test('本來就沒關聯的不用清', () => {
    assert.equal('request_item_id' in manualStatusPatch('done', false), false);
  });

  /*
   * ★ 已經接到請款單的不給改成「已詢價」——
   *   那會變成「還在詢價中，但錢已經在請款單上了」。
   */
  test('★ 接到請款單的只給三個選項', () => {
    assert.deepEqual(manualStatusOptions(linked), ['requested', 'done', 'pending']);
  });

  test('沒接請款單的可以自由改', () => {
    assert.deepEqual(manualStatusOptions(free), ['pending', 'quoted', 'done', 'cancelled']);
  });

  // ★ 卡死的那筆（狀態 requested 但沒有關聯）要能救得回來
  test('★ 卡住的孤兒項目給的是自由選項', () => {
    const orphan = { status: 'requested' as DemandItemStatus, request_item_id: null };
    assert.ok(manualStatusOptions(orphan).includes('pending'));
    assert.equal(isOrphanRequested(orphan), true);
  });

  test('正常的已進請款不算孤兒', () => {
    assert.equal(isOrphanRequested(linked), false);
    assert.equal(isOrphanRequested(free), false);
  });

  test('解除關聯要先講', () => {
    assert.match(manualStatusNote('pending', true)!, /解除.*關聯/);
  });

  test('★ 沒請款單卻標已採購要講那是零用金那條路', () => {
    assert.match(manualStatusNote('done', false)!, /零用金/);
  });

  test('沒事的組合不囉嗦', () => {
    assert.equal(manualStatusNote('done', true), null);
    assert.equal(manualStatusNote('quoted', false), null);
  });
});
