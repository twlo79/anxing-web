import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  oweOf, isOpen, repayOrder, allocate, validateRepay, owedTotal,
  type RepayRow,
} from './advance-repay.ts';

/*
 * 資料照 2026-09-21 那支查詢第 ⑥ 段印出來的**真實順序與金額**
 * （愛皮 8 列，合計 13,209）。自己編一組的話測的是我想像中的形狀。
 */
const R = (
  id: string, paid_on: string, created_at: string, amount: number,
  extra: Partial<RepayRow> = {},
): RepayRow => ({
  id, paid_on, created_at, amount,
  category: '代墊', counterparty: '愛皮', ...extra,
});

const AIPI: RepayRow[] = [
  R('a', '2026-09-07', '2026-09-07T10:00:00Z', 7350),   // 115/7-8月管理服務費
  R('b', '2026-09-09', '2026-09-09T10:01:00Z', 261),    // 旅平險
  R('c', '2026-09-09', '2026-09-09T10:02:00Z', 1428),   // 115/7月健保費
  R('d', '2026-09-09', '2026-09-09T10:03:00Z', 246),
  R('e', '2026-09-09', '2026-09-09T10:04:00Z', 217),
  R('f', '2026-09-09', '2026-09-09T10:05:00Z', 300),
  R('g', '2026-09-09', '2026-09-09T10:06:00Z', 3102),   // 115/7月勞保費
  R('h', '2026-09-09', '2026-09-09T10:07:00Z', 305),
];
const TOTAL = 13209;

const OK = { on: '2026-09-21', pay: 6000, inAccount: '8088', outAccount: '4195', picked: false };
const cut = (p: ReturnType<typeof allocate>, id: string) =>
  p.lines.find((l) => l.id === id)?.cut;

/* ══════════════════════════════════════════════════════════
 * 順序
 * ══════════════════════════════════════════════════════════ */
describe('扣款順序', () => {
  test('★★★ 舊的先扣 —— 09/07 那筆排第一，不是畫面上最上面那筆', () => {
    /* ★ 畫面是 paid_on DESC（新的在上面），所以 09/07 在最底下。
         這一條釘的就是「扣款順序不可以跟著畫面走」。 */
    assert.equal(repayOrder(AIPI)[0].id, 'a');
    assert.equal(repayOrder([...AIPI].reverse())[0].id, 'a', '輸入順序不該影響結果');
  });

  test('★★★ 同一天照建立時間 —— 沒有第二鍵的話順序每次都可能不一樣', () => {
    assert.deepEqual(repayOrder(AIPI).map((r) => r.id),
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);

    /*
     * ★★★ 上面那組的 id 剛好照字母排，**所以它證明不了第二鍵有沒有用** ——
     *   拿掉 created_at 的話 id 會接手，答案一模一樣。
     *   （2026-09-21 故意把 created_at 那一段刪掉測，30 條還是全綠。）
     *
     * 這一組讓 id 的字母順序跟建立時間**相反**:第二鍵不在，
     * 就會排成 a、b、c，而正確答案是 c、b、a。
     */
    const fight = [
      R('a', '2026-09-09', '2026-09-09T10:09:00Z', 100),
      R('b', '2026-09-09', '2026-09-09T10:08:00Z', 100),
      R('c', '2026-09-09', '2026-09-09T10:07:00Z', 100),
    ];
    assert.deepEqual(repayOrder(fight).map((r) => r.id), ['c', 'b', 'a'],
      '排成 a,b,c 就是第二鍵（建立時間）沒有生效,順序會跟著 id 跑');
  });

  test('★★ 出款日與建立時間都一樣時靠 id 定勝負 —— 結果必須唯一', () => {
    const same = [
      R('z', '2026-09-09', '2026-09-09T10:00:00Z', 100),
      R('y', '2026-09-09', '2026-09-09T10:00:00Z', 100),
    ];
    assert.deepEqual(repayOrder(same).map((r) => r.id), ['y', 'z']);
    assert.deepEqual(repayOrder([...same].reverse()).map((r) => r.id), ['y', 'z']);
  });

  test('排序不會改到原本的陣列', () => {
    const before = AIPI.map((r) => r.id);
    repayOrder(AIPI);
    assert.deepEqual(AIPI.map((r) => r.id), before);
  });
});

/* ══════════════════════════════════════════════════════════
 * 還欠多少
 * ══════════════════════════════════════════════════════════ */
describe('還欠多少', () => {
  test('還沒還過就是欠全額', () => {
    assert.equal(oweOf(AIPI[0]), 7350);
  });

  test('還過一部分就扣掉已還的', () => {
    assert.equal(oweOf({ ...AIPI[0], refunded_amount: 6000 }), 1350);
  });

  test('★★★ 已結清的回 0 —— 差額已經是被扣不是應收', () => {
    const settled = { ...AIPI[0], refunded_amount: 6000, refunded_on: '2026-09-30' };
    assert.equal(oweOf(settled), 0, '結清之後那 1,350 不該再被扣一次');
    assert.equal(isOpen(settled), false);
  });

  test('★★ 已還等於代墊金額就不再是待收回', () => {
    assert.equal(isOpen({ ...AIPI[0], refunded_amount: 7350 }), false);
  });
});

/* ══════════════════════════════════════════════════════════
 * 攤還
 * ══════════════════════════════════════════════════════════ */
describe('一筆金額攤還', () => {
  test('★★★ 6,000 全部扣在第一列（7,350），其餘八列一毛都不動', () => {
    const p = allocate(AIPI, 6000);
    assert.equal(cut(p, 'a'), 6000);
    assert.equal(p.lines.find((l) => l.id === 'a')!.rest, 1350);
    assert.equal(p.lines.filter((l) => l.cut > 0).length, 1);
    assert.equal(p.cleared, 0, '一列都沒收完');
  });

  test('扣完第一列才輪到下一列', () => {
    const p = allocate(AIPI, 7350 + 100);
    assert.equal(cut(p, 'a'), 7350);
    assert.equal(cut(p, 'b'), 100);
    assert.equal(p.cleared, 1);
  });

  test('★★ 每一列扣的加起來要等於實際扣掉的 —— 錢不可以憑空多出來或不見', () => {
    for (const pay of [0, 1, 1000, 5000, 6000, 7350, 9999, 13209]) {
      const p = allocate(AIPI, pay);
      const sum = p.lines.reduce((n, l) => n + l.cut, 0);
      assert.equal(Math.round(sum * 100) / 100, p.used, `還 ${pay} 時對不起來`);
    }
  });

  test('★★★ 還的比欠的多:allocate 只算不擋，多的放進 over（擋的是 validateRepay）', () => {
    const p = allocate(AIPI, 20000);
    assert.equal(p.used, TOTAL);
    assert.equal(p.over, 20000 - TOTAL);
    assert.ok(p.lines.every((l) => l.rest === 0), '全部收完');
    assert.equal(p.cleared, 8);
  });

  test('剛好還清時沒有 over', () => {
    assert.equal(allocate(AIPI, TOTAL).over, 0);
  });

  test('★★ 沒有一列會被扣成負的', () => {
    for (const pay of [0, 0.01, 7349.99, 13208.99, 99999]) {
      assert.ok(allocate(AIPI, pay).lines.every((l) => l.cut >= 0 && l.rest >= 0),
        `還 ${pay} 時出現負數`);
    }
  });

  test('★★ 已經還過一部分的列，接著扣的是「還欠的」不是「全額」', () => {
    const half = AIPI.map((r) => (r.id === 'a' ? { ...r, refunded_amount: 6000 } : r));
    const p = allocate(half, 2000);
    assert.equal(cut(p, 'a'), 1350, '第一列只剩 1,350 可以扣');
    /* ★ 剩下的 650 不是整塊流到第二列 —— 第二列只欠 261，
         收完之後還有 389 要繼續往下流。2026-09-21 這一條我第一次
         寫成「cut(b) = 650」，是**測試寫錯**不是程式錯。 */
    assert.equal(cut(p, 'b'), 261, '第二列只欠 261，扣完就滿了');
    assert.equal(cut(p, 'c'), 389, '剩下的 389 要繼續流到第三列');
    assert.equal(p.used, 2000);
  });

  test('★★★ 已結清的列不會被扣到 —— 它的差額是被扣，不是應收', () => {
    const rows = AIPI.map((r) => (r.id === 'a'
      ? { ...r, refunded_amount: 6000, refunded_on: '2026-09-30' } : r));
    const p = allocate(rows, 500);
    assert.equal(p.lines.find((l) => l.id === 'a'), undefined, '結清的列不該出現在計畫裡');
    assert.equal(cut(p, 'b'), 261);
  });

  test('★ 小數不會漂 —— 那個數字會直接寫進資料庫', () => {
    const p = allocate([R('x', '2026-09-01', '2026-09-01T00:00:00Z', 7350)], 6000.1);
    assert.equal(p.lines[0].rest, 1349.9, '1349.8999999999996 就是漂掉了');
  });

  test('一列都沒有時不會當掉', () => {
    const p = allocate([], 1000);
    assert.deepEqual(p.lines, []);
    assert.equal(p.used, 0);
    assert.equal(p.over, 1000);
  });
});

/* ══════════════════════════════════════════════════════════
 * 範圍（使用者 2026-09-21：勾了就扣勾的，沒勾就扣全部）
 * ══════════════════════════════════════════════════════════ */
describe('範圍由呼叫端決定', () => {
  test('★★★ 只傳勾起來的兩列，就只會扣那兩列', () => {
    const picked = AIPI.filter((r) => r.id === 'g' || r.id === 'h');   // 3102 + 305
    const p = allocate(picked, 6000);
    assert.equal(p.owed, 3407);
    assert.equal(p.used, 3407, '扣到欠的為止');
    assert.equal(p.over, 6000 - 3407, '多出來的算得出來 —— 擋是 validateRepay 的事');
    assert.deepEqual(p.lines.map((l) => l.id), ['g', 'h'], '勾起來的也照舊的先扣');
  });

  test('★★ 傳全部就是全部待收回', () => {
    assert.equal(allocate(AIPI, 99999).owed, TOTAL);
  });
});

/* ══════════════════════════════════════════════════════════
 * 存檔前的檢查
 * ══════════════════════════════════════════════════════════ */
describe('存檔前的檢查', () => {
  test('填好了就過', () => {
    assert.equal(validateRepay(AIPI, OK), null);
  });

  test('★★ 沒填金額與填 0 是兩句不同的話', () => {
    assert.match(validateRepay(AIPI, { ...OK, pay: '' })!, /要填還款金額/);
    assert.match(validateRepay(AIPI, { ...OK, pay: 0 })!, /要大於 0/);
    assert.match(validateRepay(AIPI, { ...OK, pay: null })!, /要填還款金額/);
  });

  test('金額只到分', () => {
    assert.equal(validateRepay(AIPI, { ...OK, pay: 100.25 }), null);
    assert.match(validateRepay(AIPI, { ...OK, pay: 100.256 })!, /小數點後兩位/);
  });

  test('沒填還款日', () => {
    assert.match(validateRepay(AIPI, { ...OK, on: '' })!, /要填還款日/);
  });

  test('★★ 還款日不能早於出款日', () => {
    assert.match(validateRepay(AIPI, { ...OK, on: '2026-09-06' })!, /早於出款日 2026-09-07/);
  });

  test('★★★ 兩個帳戶都要選，而且不能是同一個', () => {
    assert.match(validateRepay(AIPI, { ...OK, inAccount: '' })!, /還入哪個帳戶/);
    assert.match(validateRepay(AIPI, { ...OK, outAccount: ' ' })!, /哪個帳戶出去/);
    assert.match(validateRepay(AIPI, { ...OK, outAccount: '8088' })!, /沒有移動過/);
  });

  test('★★★ 一次只能收同一個對象', () => {
    const mixed = [...AIPI, R('x', '2026-09-10', '2026-09-10T00:00:00Z', 500,
      { counterparty: '洪鯊' })];
    assert.match(validateRepay(mixed, OK)!, /只能收同一個對象/);
  });

  test('★★ 押金不走這條路 —— 被扣時要選會計科目，攤還問不了', () => {
    const dep = [R('x', '2026-09-01', '2026-09-01T00:00:00Z', 20000, { category: '押金' })];
    assert.match(validateRepay(dep, OK)!, /只處理代墊/);
  });

  test('★★ 全部都收回了要說出來 —— 不要讓人按一顆什麼都不會發生的鈕', () => {
    const done = AIPI.map((r) => ({ ...r, refunded_amount: r.amount, refunded_on: '2026-09-20' }));
    assert.match(validateRepay(done, OK)!, /都已經收回了/);
  });

  /* ══════════════════════════════════════════════════
   * 金額要跟範圍對得起來（2026-09-21 使用者：
   *   「打勾與還款配不上 就擋住」「金額不能超過總欠款 > 會擋」）
   * ══════════════════════════════════════════════════ */

  test('★★★ 剩餘款:還過一部分之後,剩的是「還欠的」不是代墊總額', () => {
    /* ★ 統計卡的「待收回」讀的就是這個數字。還了 6,000 之後
         還印 13,209 的話,那張卡會永遠說欠原價。 */
    assert.equal(owedTotal(AIPI), TOTAL);
    const half = AIPI.map((r) => (r.id === 'a' ? { ...r, refunded_amount: 6000 } : r));
    assert.equal(owedTotal(half), TOTAL - 6000);
  });

  test('★★★ 剩餘款:已結清（認賠）的那筆零頭不算在剩餘裡', () => {
    const settled = AIPI.map((r) => (r.id === 'h'
      ? { ...r, refunded_amount: 96, refunded_on: '2026-10-05' } : r));
    assert.equal(owedTotal(settled), TOTAL - 305,
      '結清那一列整個退出剩餘款 —— 沒還的 209 已經變成費用,不是應收');
  });

  test('★★ 還到完為止:一路還下去剩餘款會歸零,而且不會變成負的', () => {
    let rows: RepayRow[] = AIPI.map((r) => ({ ...r }));
    for (const pay of [6000, 1000, 5000, 1209]) {
      const p = allocate(rows, pay);
      rows = rows.map((r) => {
        const l = p.lines.find((x) => x.id === r.id);
        return l ? { ...r, refunded_amount: Number(r.refunded_amount ?? 0) + l.cut } : r;
      });
    }
    assert.equal(owedTotal(rows), 0, '6000+1000+5000+1209 = 13,209 剛好還完');
    assert.ok(rows.every((r) => !isOpen(r)), '每一列都收滿了');
  });

  test('★★★ 勾了列:金額剛好等於欠款總和才過', () => {
    const picked = AIPI.filter((r) => r.id === 'g' || r.id === 'h');   // 3102 + 305
    assert.equal(owedTotal(picked), 3407);
    assert.equal(validateRepay(picked, { ...OK, pay: 3407, picked: true }), null);
  });

  test('★★★ 勾了列:多一塊少一塊都擋，而且訊息要寫出差多少', () => {
    const picked = AIPI.filter((r) => r.id === 'g' || r.id === 'h');
    const more = validateRepay(picked, { ...OK, pay: 3408, picked: true })!;
    assert.match(more, /多 1/);
    assert.match(more, /3407/, '訊息要把欠款總和寫出來,不然人得自己加一遍');
    const less = validateRepay(picked, { ...OK, pay: 3406, picked: true })!;
    assert.match(less, /少 1/);
    assert.match(less, /取消/, '少的那句要講出路怎麼走');
  });

  test('★★★ 沒勾:金額不能超過總欠款', () => {
    assert.equal(validateRepay(AIPI, { ...OK, pay: TOTAL, picked: false }), null);
    assert.match(validateRepay(AIPI, { ...OK, pay: TOTAL + 1, picked: false })!,
      new RegExp(`比總欠款 ${TOTAL} 多 1`));
  });

  test('★★ 沒勾:少於總欠款是正常的（那就是攤還）', () => {
    for (const pay of [1, 1000, 5000, 6000]) {
      assert.equal(validateRepay(AIPI, { ...OK, pay, picked: false }), null, `還 ${pay} 被擋了`);
    }
  });

  test('★★★ 同一個金額,勾了跟沒勾的答案不一樣 —— 所以 picked 不能用推的', () => {
    const picked = AIPI.filter((r) => r.id === 'g' || r.id === 'h');
    /* 1,000 對「沒勾」是合法的攤還,對「勾了兩列」是配不上 */
    assert.equal(validateRepay(picked, { ...OK, pay: 1000, picked: false }), null);
    assert.match(validateRepay(picked, { ...OK, pay: 1000, picked: true })!, /少 2407/);
  });

  test('★★ 勾起來的那幾列已經還過一部分時,要剛好還完的是「還欠的」不是「全額」', () => {
    const picked = AIPI.filter((r) => r.id === 'g' || r.id === 'h')
      .map((r) => (r.id === 'g' ? { ...r, refunded_amount: 100 } : r));
    assert.equal(owedTotal(picked), 3307, '3102 − 100 ＋ 305');
    assert.equal(validateRepay(picked, { ...OK, pay: 3307, picked: true }), null);
    assert.match(validateRepay(picked, { ...OK, pay: 3407, picked: true })!, /多 100/);
  });

  test('★ 一次只回一個錯 —— 全部列出來會變成一段文章，而人只看第一行', () => {
    const bad = validateRepay(AIPI, { on: '', pay: '', inAccount: '', outAccount: '' });
    assert.equal(bad, '要填還款日', '應該停在第一個錯');
  });
});
