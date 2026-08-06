import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  type RevRow, sum, classOf, skeleton, roomLines, reconcile,
  inEstateBlock, isOffice, isCompany, estateOf, ROOM_NONE,
} from './revenue-report.ts';

/**
 * 營收報表的測試。跑法:npm test
 *
 * 這支釘住兩件事:
 *   1. 三段(物業 / 辦公室 / 公司登記)相加必須等於總營收
 *   2. 列骨架取的是所有月份的聯集,不是單月各自長出來的
 *
 * 第 2 點是舊版總表最嚴重的問題:每個月各自展開標籤,月份之間的列會錯開,
 * 橫著讀同一列會拿到不同科目的數字。而且不會報錯。
 */

const r = (o: Partial<RevRow>): RevRow => ({
  source: 'airbnb', estate_name: '時兆', property_raw: 'A3',
  guest_name: null, month_amount: 0, ...o,
});

describe('三段分法', () => {
  test('辦公室與公司登記不算在物業段', () => {
    const rows = [
      r({ source: 'airbnb', month_amount: 100 }),
      r({ source: 'longterm', month_amount: 200 }),
      r({ source: 'oneoff', month_amount: 50 }),
      r({ source: 'office', estate_name: null, guest_name: '○○公司', month_amount: 300 }),
      r({ source: 'company', estate_name: null, guest_name: '××科技', month_amount: 40 }),
    ];
    assert.equal(sum(rows, inEstateBlock), 350);
    assert.equal(sum(rows, isOffice), 300);
    assert.equal(sum(rows, isCompany), 40);
  });

  test('三段相加等於總營收 —— 內建的對帳點', () => {
    const rows = [
      r({ source: 'airbnb', month_amount: 100 }),
      r({ source: 'agoda', month_amount: 33 }),
      r({ source: 'private', month_amount: 7 }),
      r({ source: 'longterm', month_amount: 200 }),
      r({ source: 'oneoff', month_amount: 50 }),
      r({ source: 'other', month_amount: 1 }),
      r({ source: 'office', month_amount: 300 }),
      r({ source: 'company', month_amount: 40 }),
    ];
    assert.equal(reconcile(rows), null, '沒有任何來源可以掉出三段之外');
    assert.equal(sum(rows), 731);
  });

  test('新增一種來源時對帳會失敗,不會安靜地少算', () => {
    // inEstateBlock 是「扣掉 office 與 company 的其餘全部」,
    // 寫成白名單的話,將來多一種來源就會從三段之間掉出去而沒人發現。
    const rows = [r({ source: '未來才有的來源', month_amount: 999 })];
    assert.equal(reconcile(rows), null);
    assert.equal(sum(rows, inEstateBlock), 999);
  });
});

describe('金額', () => {
  test('numeric 從 Supabase 回來是字串,也要能加', () => {
    const rows = [r({ month_amount: '1200.4' }), r({ month_amount: '800.6' })];
    assert.equal(sum(rows), 2001);
  });

  test('空值當 0,不要變成 NaN 汙染整欄', () => {
    const rows = [r({ month_amount: 100 }), r({ month_amount: null as any })];
    assert.equal(sum(rows), 100);
  });
});

describe('列骨架取所有月份的聯集', () => {
  const eSort = (a: string, b: string) => a.localeCompare(b);

  test('某個月沒有的物業,骨架裡仍然要有', () => {
    // 7 月有亞曼尼、8 月沒有。舊版 8 月那一欄不會長出亞曼尼這一列,
    // 底下所有列往上推一格,跟 7 月就對不齊了。
    const july = [r({ estate_name: '時兆', month_amount: 100 }), r({ estate_name: '亞曼尼', month_amount: 50 })];
    const aug = [r({ estate_name: '時兆', month_amount: 120 })];
    const sk = skeleton([...july, ...aug], eSort);
    assert.deepEqual(sk.estates, ['亞曼尼', '時兆']);
    // 8 月的亞曼尼是 0,不是「這一列不存在」
    assert.equal(sum(aug, (x) => inEstateBlock(x) && estateOf(x) === '亞曼尼'), 0);
  });

  test('沒有物業的列歸到「無物業」,不能消失', () => {
    const sk = skeleton([r({ estate_name: null, month_amount: 10 })], eSort);
    assert.deepEqual(sk.estates, ['無物業']);
  });

  test('辦公室與公司登記依客戶展開,各自成段', () => {
    const rows = [
      r({ source: 'office', guest_name: 'B 工作室', month_amount: 1 }),
      r({ source: 'office', guest_name: 'A 公司', month_amount: 2 }),
      r({ source: 'company', guest_name: 'C 科技', month_amount: 3 }),
    ];
    const sk = skeleton(rows, eSort);
    assert.deepEqual(sk.offices, ['A 公司', 'B 工作室']);
    assert.deepEqual(sk.companies, ['C 科技']);
    assert.deepEqual(sk.estates, [], '這三筆都不該進物業段');
  });
});

describe('房源分類', () => {
  test('短租是三個平台的小計', () => {
    assert.equal(classOf(r({ source: 'airbnb' })), '短租');
    assert.equal(classOf(r({ source: 'agoda' })), '短租');
    assert.equal(classOf(r({ source: 'private' })), '短租');
    assert.equal(classOf(r({ source: 'longterm' })), '長租');
    assert.equal(classOf(r({ source: 'oneoff' })), '一次性');
    assert.equal(classOf(r({ source: 'other' })), '其他');
  });

  test('同一間房同月有長租又有一次性,要拆成兩列', () => {
    const rows = [
      r({ estate_name: '時兆', property_raw: 'A8', source: 'longterm', month_amount: 38000 }),
      r({ estate_name: '時兆', property_raw: 'A8', source: 'oneoff', month_amount: 1200 }),
    ];
    const lines = roomLines(rows, '時兆');
    assert.equal(lines.length, 2, '合成一列就看不出組成');
    assert.deepEqual(lines.map((l) => l.cls).sort(), ['一次性', '長租']);
  });

  test('房號空白要單獨成一列,不能整筆不見', () => {
    // 空白有兩種意思:刻意算在整棟上,或真的漏填。分不出來,所以兩個都寫。
    const lines = roomLines([r({ property_raw: null, month_amount: 5 })], '時兆');
    assert.deepEqual(lines, [{ room: ROOM_NONE, cls: '短租' }]);
  });
});
