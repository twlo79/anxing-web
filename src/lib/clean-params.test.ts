import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBeds, parsePoints, parsePrice, parseLabor,
  laborMode, canEditEstateLabor, canEditRoomLabor, laborLockMsg,
  cleanGaps, hasGap, parseUnits, parseAmount,
} from './clean-params.ts';

describe('parse* —— 四個參數的驗證（2026-09-03）', () => {
  /*
   * ★★★ 留空回 null 不是 0。
   *   沒設 = 不產生支出；0 = 免費。畫面上都是空格子，帳上差一截。
   */
  test('★★★ 留空是 null 不是 0', () => {
    assert.deepEqual(parsePrice(''), { ok: true, value: null });
    assert.deepEqual(parsePrice('  '), { ok: true, value: null });
    assert.deepEqual(parsePrice('0'), { ok: true, value: 0 }, '真的填 0 才是 0');
  });

  // ★ 從 Excel 貼過來就是這個樣子 —— 擋掉的話使用者以為系統壞了
  test('千分位逗號要收得下', () => {
    assert.deepEqual(parseLabor('200,000'), { ok: true, value: 200000 });
    assert.deepEqual(parsePrice('9,000'), { ok: true, value: 9000 });
  });

  test('負數擋下來', () => {
    assert.equal(parsePrice('-5').ok, false);
    assert.equal(parseBeds('-1').ok, false);
  });

  test('床位只收整數', () => {
    assert.deepEqual(parseBeds('4'), { ok: true, value: 4 });
    assert.equal(parseBeds('4.5').ok, false, '半張床不存在');
    assert.deepEqual(parseBeds('0'), { ok: true, value: 0 }, '公區填 0');
  });

  // ★ 合掃是 0.5，所以點數一定要收一位小數
  test('打掃點數收一位小數，不收兩位', () => {
    assert.deepEqual(parsePoints('3.5'), { ok: true, value: 3.5 });
    assert.equal(parsePoints('3.55').ok, false);
  });

  test('清潔費收兩位小數', () => {
    assert.deepEqual(parsePrice('2500.25'), { ok: true, value: 2500.25 });
    assert.equal(parsePrice('2500.255').ok, false);
  });

  // ★ 月薪不會有零頭，收小數只會讓人打錯不自知
  test('人事費只收整數', () => {
    assert.deepEqual(parseLabor('12000'), { ok: true, value: 12000 });
    assert.equal(parseLabor('12000.5').ok, false);
  });

  test('亂打的擋下來，而且訊息說得出是哪個欄位', () => {
    const r = parsePoints('abc');
    assert.equal(r.ok, false);
    assert.match((r as any).error, /打掃點數/);
  });
});

describe('laborMode —— 整棟與逐間互斥（2026-09-03）', () => {
  /*
   * ★★★ 資料庫**不擋**同一個物業既有整棟又有逐間 ——
   *   那個 check 只管單獨一列合不合法。兩邊都產生支出的話
   *   總額只是「比較大」，沒有任何錯誤。
   */
  test('正隆:整棟一筆', () => {
    assert.equal(laborMode(200000, [null, null, null]), 'estate');
  });

  test('開封:逐間', () => {
    assert.equal(laborMode(null, [4000, 12000, null]), 'rooms');
  });

  test('都沒設', () => {
    assert.equal(laborMode(null, []), 'none');
    assert.equal(laborMode(null, [null, null]), 'none');
  });

  test('★ 0 也算「有設」—— 免費不等於沒填', () => {
    assert.equal(laborMode(0, []), 'estate');
    assert.equal(laborMode(null, [0]), 'rooms');
  });

  test('沒設的時候兩邊都能填', () => {
    assert.equal(canEditEstateLabor('none'), true);
    assert.equal(canEditRoomLabor('none'), true);
  });

  test('設了整棟就鎖住逐間', () => {
    assert.equal(canEditRoomLabor('estate'), false);
    assert.equal(canEditEstateLabor('estate'), true, '整棟自己還要能改與清空');
  });

  test('設了逐間就鎖住整棟', () => {
    assert.equal(canEditEstateLabor('rooms'), false);
    assert.equal(canEditRoomLabor('rooms'), true);
  });

  // ★ 鎖住要講得出怎麼解開，不然使用者不知道是壞了還是故意的
  test('鎖住的訊息說得出怎麼解開', () => {
    assert.match(laborLockMsg('rooms', 'estate')!, /先把下面各間的清空/);
    assert.match(laborLockMsg('estate', 'room')!, /先把上面那一列清空/);
    assert.equal(laborLockMsg('none', 'estate'), null);
    assert.equal(laborLockMsg('estate', 'estate'), null);
  });
});

describe('cleanGaps —— 缺什麼要講出房源名（2026-09-03）', () => {
  const rooms = [
    { name: '1485', beds: 4, clean_points: 7, clean_price: 9000 },
    { name: '4B2', beds: null, clean_points: 7, clean_price: 9000 },
    { name: '復興', beds: 2, clean_points: null, clean_price: null },
  ];

  // ★ 回房源名不是筆數 —— 「3 間沒設」要人在 74 列裡自己找
  test('回的是名字', () => {
    const g = cleanGaps(rooms);
    assert.deepEqual(g.beds, ['4B2']);
    assert.deepEqual(g.points, ['復興']);
    assert.deepEqual(g.price, ['復興']);
  });

  test('全部填好就沒有缺口', () => {
    const g = cleanGaps([rooms[0]]);
    assert.equal(hasGap(g), false);
  });

  test('有任何一種缺就要出現', () => {
    assert.equal(hasGap(cleanGaps(rooms)), true);
  });

  test('★ 0 不算缺 —— 公區床數 0、免費清潔 0 都是填過的', () => {
    const g = cleanGaps([{ name: '公區', beds: 0, clean_points: 0, clean_price: 0 }]);
    assert.equal(hasGap(g), false);
  });

  test('空清單不會爆', () => {
    assert.equal(hasGap(cleanGaps([])), false);
  });
});

describe('parseUnits —— 這份工算幾間（2026-09-03）', () => {
  /*
   * ★★★ 留空是 null（用預設的一間），填 0 是「不算間數」。
   *   兩者在畫面上都是空格子，但一個算錢一個不算。
   */
  test('★★★ 留空 null、填 0 是 0', () => {
    assert.deepEqual(parseUnits(''), { ok: true, value: null });
    assert.deepEqual(parseUnits('0'), { ok: true, value: 0 });
  });

  test('合掃的 0.5', () => {
    assert.deepEqual(parseUnits('0.5'), { ok: true, value: 0.5 });
  });

  // ★ 正隆多間那次是 1/(2×3)=0.1667，兩位小數只能存 0.17
  test('兩位小數收得下，三位擋掉', () => {
    assert.deepEqual(parseUnits('0.17'), { ok: true, value: 0.17 });
    assert.equal(parseUnits('0.167').ok, false);
  });

  test('批量:一列算 4 間', () => {
    assert.deepEqual(parseUnits('4'), { ok: true, value: 4 });
  });

  test('負數與亂打擋掉', () => {
    assert.equal(parseUnits('-1').ok, false);
    assert.equal(parseUnits('兩間').ok, false);
  });
});

describe('parseAmount —— 直接指定金額（2026-09-03）', () => {
  // ★★★ 留空 = 用公式算；填 0 = 這份工不用錢。兩者不同
  test('★★★ 留空 null、填 0 是 0', () => {
    assert.deepEqual(parseAmount(''), { ok: true, value: null });
    assert.deepEqual(parseAmount('0'), { ok: true, value: 0 });
  });

  test('1500 收得下，千分位也收', () => {
    assert.deepEqual(parseAmount('1500'), { ok: true, value: 1500 });
    assert.deepEqual(parseAmount('1,500'), { ok: true, value: 1500 });
  });

  test('負數擋掉', () => assert.equal(parseAmount('-1').ok, false));
});
