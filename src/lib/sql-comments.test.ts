import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkBlockComments, riskyCommentOpeners, danglingCteComma } from './sql-comments.ts';

describe('checkBlockComments', () => {
  test('平衡的回 null', () => {
    assert.equal(checkBlockComments('/* 一般註解 */ select 1;'), null);
    assert.equal(checkBlockComments('-- 單行\nselect 1;'), null);
    assert.equal(checkBlockComments(''), null);
  });

  test('★★ 巢狀 —— Postgres 支援，所以內層的 */ 只關內層', () => {
    // 這是真的合法 SQL,要判定為平衡
    assert.equal(checkBlockComments('/* 外 /* 內 */ 還在註解 */'), null);
  });

  test('★★ 這就是 171 炸掉的那一行', () => {
    // pr 後面的斜線 ＋ Markdown 粗體的星號 = 多開了一層
    const sql = '/*\n *   **只有 pr/** —— 其他不在裡面\n */\nselect 1;';
    const r = checkBlockComments(sql);
    assert.ok(r, '應該要抓到');
    assert.equal(r.depth, 1, '多開了一層');
    assert.deepEqual(r.openLines, [1], '沒關起來的是第 1 行開的那層');
  });

  test('多關的也要抓 —— 那會讓後面的 SQL 被當成註解外的東西', () => {
    const r = checkBlockComments('select 1; */');
    assert.ok(r);
    assert.equal(r.depth, -1);
  });
});

describe('riskyCommentOpeners', () => {
  test('行首的 /* 是刻意的,不算', () => {
    assert.deepEqual(riskyCommentOpeners('/* 正常註解'), []);
    assert.deepEqual(riskyCommentOpeners('    /* 縮排的也正常'), []);
  });

  test('★ 句子中間的 /* 幾乎都是意外', () => {
    assert.equal(riskyCommentOpeners(' *   **只有 pr/** —— 其他').length, 1);
    assert.equal(riskyCommentOpeners(' * 一樣**只放行 of/ 與 op/**，不是…').length, 1);
  });

  test('沒有星號就沒事', () => {
    assert.deepEqual(riskyCommentOpeners(' * 只有 pr/ 這一個前綴'), []);
  });
});

/*
 * ★★ 掃真正的 migration 目錄。
 *
 *   這一題才是重點 —— 上面那些是單元測試，這一題是**守門的**。
 *   158 就是因為沒有人擋，帶著一個壞掉的註解躺了三天，
 *   而畫面上只是「管家看不到自己剛傳的照片」。
 */
describe('真實的 migration 檔', () => {
  /*
   * ★ 連 archive 也掃。
   *   歸檔的不會再跑，但**會被複製**:寫新 migration 時照著舊的改，
   *   而註解裡那個壞掉的星號會一起被帶過來 —— 171 就是照 158 改的。
   */
  const dirs = [
    'supabase/migrations',
    'archive/migrations-100-145',
    'archive/migrations-30-99',
    'archive/migrations-pre-30',
  ];

  test('★★ 每一份的區塊註解都要平衡', () => {
    const bad: string[] = [];
    let scanned = 0;
    for (const d of dirs) {
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((n) => n.endsWith('.sql'))) {
        scanned++;
        const r = checkBlockComments(readFileSync(join(d, f), 'utf8'));
        if (r) {
          bad.push(`${f}：${r.depth > 0 ? `有 ${r.depth} 層沒關` : `多關了 ${-r.depth} 次`}`
            + `（開在第 ${r.openLines.join('、')} 行）`);
        }
      }
    }

    /*
     * ★★ 先確認**真的掃到東西**。
     *
     *   少了這一行的話，哪天測試從別的資料夾被叫起來、
     *   或 migration 搬了家，existsSync 會讓迴圈一份都不跑，
     *   而這一題會**綠燈通過** —— 一個什麼都沒檢查的守門員。
     *
     *   假的綠燈比紅燈危險:紅燈會有人去看，綠燈沒有。
     */
    assert.ok(scanned > 60,
      `只掃到 ${scanned} 份 —— 目錄是不是搬了？守門的東西不能靜靜跳過`);

    assert.deepEqual(bad, [],
      '這幾份貼進 SQL Editor 會整份不執行（unterminated /* comment）：\n' + bad.join('\n'));
  });
});

describe('danglingCteComma', () => {
  test('★★ migration_173 第二次炸掉的那個形狀', () => {
    const sql = `with a as (select 1),
b as (select 2),
insert into t select 1;`;
    assert.equal(danglingCteComma(sql).length, 1);
  });

  test('正常的 CTE 不報', () => {
    assert.deepEqual(danglingCteComma('with a as (select 1) insert into t select 1;'), []);
    assert.deepEqual(danglingCteComma('with a as (select 1), b as (select 2) select 1;'), []);
  });

  test('中間隔著註解也要抓得到 —— 那正是它難發現的原因', () => {
    const sql = `with a as (select 1),
/*
 * 十幾行說明
 */
insert into t select 1;`;
    assert.equal(danglingCteComma(sql).length, 1);
  });

  test('values 的括號逗號不報', () => {
    assert.deepEqual(danglingCteComma('insert into t values (1,2),\n(3,4);'), []);
  });
});

/*
 * ★★ 守門:活躍的 migration 不能有這個形狀。
 *
 *   **只掃 supabase/migrations，不掃 archive**:
 *
 *   · archive 是歸檔的，不會再貼進 SQL Editor —— 抓到也沒有動作可做
 *   · 而且這是**啟發式**檢查，會誤報 `create table` 裡
 *     「欄位定義 ＋ 逗號 ＋ 註解 ＋ 下一個欄位」的形狀。
 *     archive 裡就有三處那種誤報（113、121、140）。
 *
 *   一個會誤報的守門員最後會被加白名單然後被忽略 ——
 *   那正是「標記大量出現在正常資料上，真正該看的就被淹掉」。
 *   所以寧可只守活躍的那 26 份。
 */
describe('活躍的 migration', () => {
  test('★★ CTE 清單不能有多餘的逗號', () => {
    const dir = 'supabase/migrations';
    if (!existsSync(dir)) return;
    const bad: string[] = [];
    let scanned = 0;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
      scanned++;
      const lines = danglingCteComma(readFileSync(join(dir, f), 'utf8'));
      if (lines.length) bad.push(`${f}:${lines.join('、')}`);
    }
    assert.ok(scanned > 10, `只掃到 ${scanned} 份 —— 目錄是不是搬了？`);
    assert.deepEqual(bad, [],
      'CTE 後面多了逗號但下一個是 DML，貼進 SQL Editor 會 syntax error。\n'
      + '（這是啟發式檢查，create table 的欄位定義可能誤報 —— '
      + '確認不是的話再調整這裡。）\n' + bad.join('\n'));
  });
});
