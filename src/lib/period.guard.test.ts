/**
 * 守衛：`YYYY-MM-DD → YYYYMM` 這條規則**只准有一份**（`period.ts` 的 `ymOf`）。
 *
 * ============================================================
 * 【★★★ 為什麼要用測試掃原始碼】
 *
 * 2026-09-22 之前這條規則有 6 份 helper 加 7 處手寫。每一份都對，
 * 直到契約頁加費那一列自己寫了一個 `.slice(0, 7)` —— 七碼帶橫線，
 * `invoices_ym_chk` 直接擋下來，加費的發票從上線起一次都沒存進去過。
 *
 * tsc 抓不到這種事（兩邊都是 string），單元測試也抓不到
 * （每一份自己的測試都會過）。**只有掃原始碼才擋得住第 8 份。**
 *
 * ★ 這支跑第二次、第十次答案一樣（CLAUDE.md：會變的檢查就是寫錯的檢查）。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ymOf } from './period.ts';

const ROOT = join(import.meta.dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n) && !/\.test\.ts$/.test(n)) out.push(p);
  }
  return out;
}

/** 拿掉註解 —— 註解裡引用舊寫法當例子是允許的（`invoice.ts` 檔頭就有） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * ★★ 路徑一律換成正斜線再比。Windows 給的是 `lib\\period.ts`，
 *   用正斜線去 endsWith 排除的話在 David 的機器上會把 period.ts 自己掃進去
 *   —— 2026-09-22 推上去第一次跑就紅了兩條（我在 Linux 上測的）。
 */
const rel = (f: string) => relative(ROOT, f).replace(/\\/g, '/');
const isSelf = (f: string) => rel(f) === 'lib/period.ts';
const files = walk(join(ROOT));

describe('★★★ 六碼月份的轉換只准有一份', () => {
  test('src/ 裡沒有手寫的 slice(0,4) + slice(5,7)', () => {
    const re = /\.slice\(0, ?4\) ?\+ ?[A-Za-z_.$]+\.slice\(5, ?7\)/;
    const hits = files
      .filter((f) => !isSelf(f))
      .filter((f) => re.test(stripComments(readFileSync(f, 'utf8'))))
      .map(rel);
    assert.deepEqual(hits, [], `這幾個檔案自己手寫了六碼轉換，改走 ymOf()：\n  ${hits.join('\n  ')}`);
  });

  test('src/ 裡沒有第二個 ymOf 的定義', () => {
    const re = /(?:function|const|let)\s+ymOf\b/;
    const hits = files
      .filter((f) => !isSelf(f))
      .filter((f) => re.test(stripComments(readFileSync(f, 'utf8'))))
      .map(rel);
    assert.deepEqual(hits, [], `這幾個檔案自己定義了 ymOf：\n  ${hits.join('\n  ')}`);
  });

  test('★ 排除 period.ts 的條件在 Windows 反斜線路徑上也成立', () => {
    /* 只把 ROOT 底下那一段換成反斜線（整條換的話在 Linux 上會變成相對路徑） */
    assert.equal(rel(`${ROOT}/lib\\period.ts`), 'lib/period.ts');
    assert.equal(isSelf(`${ROOT}/lib\\period.ts`), true);
    assert.equal(rel(`${ROOT}/lib/period.ts`), 'lib/period.ts');
  });

  test('母體不是空的（掃到的檔案數要合理，不然上面兩條是空集合自動綠）', () => {
    assert.ok(files.length > 100, `只掃到 ${files.length} 個檔案 —— 路徑不對`);
  });
});

/*
 * ══════════════════════════════════════════════════════════
 * 【等價：收掉的那 6 份 helper，在合法輸入上跟新的一模一樣】
 *
 * 舊實作**逐字**抄在這裡（不是 import —— 它們已經不存在了）。
 * 這一段證明的是「換成 ymOf() 之後，原本會得到的答案一個都沒變」。
 * ══════════════════════════════════════════════════════════
 */
const OLD = {
  /** period.ts 舊版（沒有防呆） */
  period: (d: string) => d.slice(0, 4) + d.slice(5, 7),
  /** period-lock.ts 舊版 */
  periodLock: (d: string | null | undefined) => {
    const s = (d ?? '').trim();
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 4) + s.slice(5, 7) : '';
  },
  /** ContractFees.tsx 舊版 */
  contractFees: (d: string | null | undefined) => (d ? `${d.slice(0, 4)}${d.slice(5, 7)}` : ''),
  /** stats-tab.tsx 舊版（吃 Date） */
  statsTab: (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`,
  /** 契約頁六處手寫 */
  inline: (d: string) => d.slice(0, 4) + d.slice(5, 7),
};

/** 合法輸入的母體：資料庫日期欄會長的每一種樣子 */
const VALID = [
  '2026-01-01', '2026-08-31', '2026-12-31', '2027-02-28', '2024-02-29',
  '2026-08-31T00:00:00', '2026-08-31T15:30:00.000Z', '2026-08-31 09:00:00',
  '1999-12-31', '2100-01-01',
];

describe('★★★ 等價：合法輸入上，新的 ymOf 跟收掉的每一份答案一樣', () => {
  for (const d of VALID) {
    test(`${d}`, () => {
      const now = ymOf(d);
      assert.equal(now, OLD.period(d), 'period.ts 舊版');
      assert.equal(now, OLD.periodLock(d), 'period-lock.ts 舊版');
      assert.equal(now, OLD.contractFees(d), 'ContractFees 舊版');
      assert.equal(now, OLD.inline(d), '契約頁手寫');
      assert.match(now, /^\d{6}$/);
    });
  }

  test('Date 物件：跟 stats-tab 舊版一樣（本地時區）', () => {
    for (const d of [new Date(2026, 7, 31), new Date(2026, 0, 1), new Date(2026, 11, 31, 23, 59)]) {
      assert.equal(ymOf(d), OLD.statsTab(d));
    }
  });

  /*
   * ★★ 這一條釘住「為什麼 Date 要走本地時區」：
   *   台灣 8/1 凌晨 3 點，toISOString() 是 7/31 —— 用 UTC 會算成 7 月。
   */
  test('★ Date 用本地時區，不是 UTC', () => {
    const d = new Date(2026, 7, 1, 3, 0, 0);            // 本地 8/1 03:00
    assert.equal(ymOf(d), '202608');
    assert.equal(OLD.statsTab(d), '202608');
  });
});

/*
 * ══════════════════════════════════════════════════════════
 * 【差異：只在**壞輸入**上不同，而且每一條都是往安全的方向】
 * ══════════════════════════════════════════════════════════
 */
describe('★★ 壞輸入：舊版會丟錯或回垃圾，新的一律回空字串', () => {
  test('null / undefined：period.ts 舊版會 TypeError，新的回空', () => {
    assert.throws(() => OLD.period(null as never));
    assert.equal(ymOf(null), '');
    assert.equal(ymOf(undefined), '');
  });

  test('七碼帶橫線 "2026-08"：舊版會回 "202608"（碰巧對），新的回空 —— 那不是日期', () => {
    /*
     * ★ 這是唯一一條「舊版答對、新的答空」。全站沒有任何呼叫端餵七碼進來
     *   （掃過：全部是 checkin / checkout / spent_on / start_date / Date）。
     *   讓它回空是為了不再讓「碰巧對」活下去 —— 下一個人會以為它本來就吃七碼。
     */
    assert.equal(OLD.period('2026-08'), '202608');
    assert.equal(ymOf('2026-08'), '');
  });

  test('斜線日期 "2026/08/31"：舊版回 "202608"（碰巧），新的回空', () => {
    assert.equal(OLD.period('2026/08/31'), '202608');
    assert.equal(ymOf('2026/08/31'), '');
  });

  test('垃圾：舊版回垃圾，新的回空', () => {
    assert.equal(OLD.period('hello'), 'hell');
    assert.equal(ymOf('hello'), '');
    assert.equal(ymOf(''), '');
    assert.equal(ymOf('   '), '');
  });

  test('Invalid Date 回空，不是 "NaNNaN"', () => {
    assert.equal(OLD.statsTab(new Date('x')), 'NaNNaN');
    assert.equal(ymOf(new Date('x')), '');
  });
});
