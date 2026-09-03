import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBeds, parsePoints, parsePrice, parseLabor,
  laborMode, canEditEstateLabor, canEditRoomLabor, laborLockMsg,
  cleanGaps, hasGap, parseUnits, parseAmount, isEstimatedJob,
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

describe('parseUnits —— 概算，只收 0.5 或 1（2026-09-03）', () => {
  // ★ 留空 = 行程來的正常一份工，不是「0 間」
  test('留空是 null', () => {
    assert.deepEqual(parseUnits(''), { ok: true, value: null });
    assert.deepEqual(parseUnits('  '), { ok: true, value: null });
  });

  test('0.5 與 1 收得下', () => {
    assert.deepEqual(parseUnits('0.5'), { ok: true, value: 0.5 });
    assert.deepEqual(parseUnits('1'), { ok: true, value: 1 });
  });

  /*
   * ★★★ 其他數字一律擋掉（使用者:「只有 0.5 or 1 可以合併記，其它不行」）。
   *   這個欄位是**概算**不是精確房間數 —— 我一度用 0.17／0.17／0.16
   *   去拆正隆那份工，那是把估計值裝成精確值。
   */
  test('★★★ 0.17、4、0 都要擋掉', () => {
    for (const v of ['0.17', '4', '0', '2.5', '1.5']) {
      assert.equal(parseUnits(v).ok, false, v + ' 應該被擋');
    }
  });

  test('★ 錯誤訊息要說得出去哪裡填金額', () => {
    const r = parseUnits('0.17');
    assert.equal(r.ok, false);
    assert.match((r as any).error, /金額/);
  });

  test('負數與亂打擋掉', () => {
    assert.equal(parseUnits('-1').ok, false);
    assert.equal(parseUnits('兩間').ok, false);
  });
});

describe('isEstimatedJob —— 有值就是人估的，床單不自動算（2026-09-03）', () => {
  /*
   * ★★★ 使用者:「無法記錄出要幾個床單，因為清三間不一定有換床單」。
   *   人估的那些，床單要手動填 —— 照床數乘只是編一個數字。
   */
  test('★★★ null 是正常一份工，床單照算', () => {
    assert.equal(isEstimatedJob(null), false);
    assert.equal(isEstimatedJob(undefined), false);
  });

  test('★★★ 0.5 與 1 都是人估的 —— 判斷「有沒有值」不是「值多少」', () => {
    assert.equal(isEstimatedJob(0.5), true);
    assert.equal(isEstimatedJob(1), true, '填 1 也是人估的，不等於沒填');
  });

  // ★ 舊資料還有 0.17／4 這種值 —— 一樣算人估的，不要因為擋輸入就漏掉它們
  test('★ 舊的非法值也算人估的', () => {
    assert.equal(isEstimatedJob(0.17), true);
    assert.equal(isEstimatedJob(4), true);
    assert.equal(isEstimatedJob(0), true);
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
