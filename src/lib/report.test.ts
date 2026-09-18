import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPORT_KINDS, parseKind, roc, spanOf, periodText,
  monthToStart, startToMonth, START_MONTHS_401,
  options401, default401, defaultMonthly, defaultStartFor,
  validateReport, suggestTitle, reportTitle, sortReports, yearOf,
  matchReport, reportFileKind, extOf, FILE_BADGE, fileLine,
  reportFileName, type Report,
} from './report.ts';

const R = (o: Partial<Report> = {}): Report => ({
  kind: '401', period_start: '2026-07-01', title: '115年 7-8月',
  uploaded_on: '2026-09-15', file_name: '401.pdf', ...o,
});

/* ── 種類 ─────────────────────────────────────────── */

describe('parseKind', () => {
  test('三種都認得', () => {
    for (const k of REPORT_KINDS) assert.equal(parseKind(k), k);
  });
  test('★ 不認得的當成「其他」—— 不要讓一列因為種類怪就整個不見', () => {
    assert.equal(parseKind('營所稅'), '其他');
    assert.equal(parseKind(null), '其他');
    assert.equal(parseKind(''), '其他');
  });
});

/* ── 期別 ─────────────────────────────────────────── */

describe('periodText —— 401 是兩月一期', () => {
  test('401 寫成 7-8 月', () => assert.equal(periodText('401', '2026-07-01'), '115年 7-8月'));
  test('月報寫成 8 月', () => assert.equal(periodText('月報', '2026-08-01'), '115年 8月'));
  test('★ 民國換算只有這一個地方', () => {
    assert.equal(roc(2026), 115);
    assert.equal(periodText('401', '2025-11-01'), '114年 11-12月');
  });
  test('沒有期別回空字串（不是「—」）—— 怎麼表示「沒有」是畫面的事', () => {
    assert.equal(periodText('其他', null), '');
    assert.equal(periodText('401', ''), '');
  });
  test('spanOf：401 是 2，其餘是 1', () => {
    assert.equal(spanOf('401'), 2);
    assert.equal(spanOf('月報'), 1);
    assert.equal(spanOf('其他'), 1);
  });
});

describe('monthToStart / startToMonth', () => {
  test('來回一趟不會變', () => {
    assert.equal(monthToStart('2026-08'), '2026-08-01');
    assert.equal(startToMonth('2026-08-01'), '2026-08');
  });
  test('格式不對回 null／空字串，不要編一個出來', () => {
    assert.equal(monthToStart(''), null);
    assert.equal(monthToStart('2026'), null);
    assert.equal(startToMonth(null), '');
  });
});

describe('★★★ options401 —— 不需要「新增年度」', () => {
  const opts = options401(new Date(2026, 8, 18));   // 2026-09-18

  test('★★★ 跨四年、每年六期 ＝ 24 個', () => {
    assert.equal(opts.length, 24);
  });

  test('★★★ 明年的也選得到 —— 不然每年一月會有一天報不了', () => {
    assert.ok(opts.some((o) => o.start.startsWith('2027-')));
  });

  test('★ 新的排最前面', () => {
    assert.equal(opts[0].label, '116年 11-12月');
    assert.equal(opts[opts.length - 1].label, '113年 1-2月');
  });

  test('★★ 起月只有單數月 —— 選不到「6-7 月」這種不存在的期別', () => {
    for (const o of opts) {
      const m = Number(o.start.slice(5, 7));
      assert.ok((START_MONTHS_401 as readonly number[]).includes(m), o.label);
    }
  });

  test('★ 每一個選項都通得過 validateReport —— 下拉不該給出存不進去的值', () => {
    for (const o of opts) {
      assert.equal(validateReport(R({ period_start: o.start, uploaded_on: null })), null, o.label);
    }
  });

  test('★ 沒有重複的期別', () => {
    assert.equal(new Set(opts.map((o) => o.start)).size, opts.length);
  });
});

describe('★★ default401 —— 預設是「剛結束的那一期」', () => {
  test('9 月打開 → 7-8 月（不是 9-10 月）', () => {
    assert.equal(default401(new Date(2026, 8, 18)), '2026-07-01');
  });
  test('★★ 1 月與 2 月要退到前一年的 11-12 月，不是月份變成 −1', () => {
    assert.equal(default401(new Date(2026, 0, 5)), '2025-11-01');
    assert.equal(default401(new Date(2026, 1, 28)), '2025-11-01');
  });
  test('每一個月都落在合法的起月上', () => {
    for (let m = 0; m < 12; m++) {
      const s = default401(new Date(2026, m, 15));
      const mm = Number(s.slice(5, 7));
      assert.ok((START_MONTHS_401 as readonly number[]).includes(mm), `${m + 1} 月 → ${s}`);
    }
  });
  test('★ 預設值一定在下拉的選項裡 —— 不在的話那一格會顯示成空白', () => {
    const d = new Date(2026, 8, 18);
    assert.ok(options401(d).some((o) => o.start === default401(d)));
  });
});

describe('defaultMonthly / defaultStartFor', () => {
  test('月報預設上一個月', () => {
    assert.equal(defaultMonthly(new Date(2026, 8, 18)), '2026-08-01');
  });
  test('★ 一月要退到前一年的十二月', () => {
    assert.equal(defaultMonthly(new Date(2026, 0, 3)), '2025-12-01');
  });
  test('換種類時期別跳到對應的預設', () => {
    const d = new Date(2026, 8, 18);
    assert.equal(defaultStartFor('401', d), '2026-07-01');
    assert.equal(defaultStartFor('月報', d), '2026-08-01');
    assert.equal(defaultStartFor('其他', d), null);
  });
});

/* ── 檢查 ─────────────────────────────────────────── */

describe('★★★ validateReport', () => {
  test('正常的回 null', () => assert.equal(validateReport(R()), null));

  test('★★★ 標題必填 —— 它是清單的大字，也是下載下來的檔名', () => {
    assert.equal(validateReport(R({ title: '' })), '要填標題');
    assert.equal(validateReport(R({ title: '   ' })), '要填標題');
  });

  test('★ 標題必填對「其他」也一樣', () => {
    assert.equal(validateReport(R({ kind: '其他', period_start: null, title: '' })), '要填標題');
    assert.equal(validateReport(R({ kind: '其他', period_start: null, title: '114 年度財簽報告', uploaded_on: null })), null);
  });

  test('月報與 401 要有期別；其他不用', () => {
    assert.equal(validateReport(R({ period_start: null })), '要選期別');
    assert.equal(validateReport(R({ kind: '月報', period_start: null })), '要選期別');
    assert.equal(validateReport(R({ kind: '其他', period_start: null, uploaded_on: null })), null);
  });

  test('★★ 401 的起月只能是單數月', () => {
    const err = validateReport(R({ period_start: '2026-06-01' }));
    assert.ok(err?.includes('兩月一期'), err ?? '');
  });

  test('★ 月報選 6 月是合法的 —— 單數月那條只管 401', () => {
    assert.equal(validateReport(R({ kind: '月報', period_start: '2026-06-01', uploaded_on: '2026-07-05' })), null);
  });

  test('期別一定是那一期的第一天', () => {
    assert.ok(validateReport(R({ period_start: '2026-07-15' }))?.includes('第一天'));
  });

  /*
   * ★★★ 2026-09-18:「申報日不早於期別」那一條**拿掉了**。
   *   401 的下拉列到明年 —— 先把 116 年 11-12 月建起來的話，
   *   上傳日（今天）比期別早，舊規則會把它擋掉。
   *   上傳日跟期別本來就沒有先後關係。
   */
  test('★★★ 上傳日早於期別是合法的 —— 明年那一期今天先建得起來', () => {
    assert.equal(validateReport(R({ uploaded_on: '2026-06-30' })), null);
    assert.equal(validateReport(
      R({ period_start: '2027-11-01', title: '116年 11-12月', uploaded_on: '2026-09-18' })), null);
  });

  test('★★ 一次只回一個錯 —— 人只看第一行', () => {
    const err = validateReport(R({ title: '', period_start: null }));
    assert.equal(err, '要填標題');
    assert.ok(!err!.includes('\n'));
  });
});

/* ── 標題與清單 ───────────────────────────────────── */

describe('suggestTitle —— 建議，不自動', () => {
  test('選好種類與期別會建議一個', () => {
    assert.equal(suggestTitle('401', '2026-07-01'), '115年 7-8月');
    assert.equal(suggestTitle('月報', '2026-08-01'), '115年 8月');
  });
  test('★ 不重複寫種類 —— 那顆籤就畫在標題前面', () => {
    assert.ok(!suggestTitle('401', '2026-07-01').includes('401'));
  });
  test('★★ 其他建議不出來就回空字串，讓人自己打', () => {
    assert.equal(suggestTitle('其他', null), '');
  });
});

describe('sortReports —— 用 period_start 排，不是那串中文', () => {
  test('★★ 期別新的在前', () => {
    const rows = [
      R({ id: 'a', period_start: '2026-01-01', title: '115年 1-2月' }),
      R({ id: 'b', period_start: '2026-09-01', title: '115年 9-10月' }),
      R({ id: 'c', period_start: '2026-05-01', title: '115年 5-6月' }),
    ];
    assert.deepEqual(sortReports(rows).map((r) => r.id), ['b', 'c', 'a']);
  });

  test('★★★ 拿中文排的話 9-10 月會掉到 1-2 月後面 —— 這個測試釘住不許那樣寫', () => {
    const byText = ['115年 1-2月', '115年 9-10月'].sort();
    assert.equal(byText[0], '115年 1-2月');       // 字典序:1 在 9 前面
    const rows = [
      R({ id: 'jan', period_start: '2026-01-01', title: '115年 1-2月' }),
      R({ id: 'sep', period_start: '2026-09-01', title: '115年 9-10月' }),
    ];
    assert.equal(sortReports(rows)[0].id, 'sep'); // 真實順序:9-10 月比較新
  });

  test('★ 沒有期別的（其他）用申報日排', () => {
    const rows = [
      R({ id: 'x', kind: '其他', period_start: null, uploaded_on: '2026-06-30', title: '財簽' }),
      R({ id: 'y', period_start: '2026-07-01' }),
    ];
    assert.equal(sortReports(rows)[0].id, 'y');
  });

  test('★ 不動到原本那個陣列', () => {
    const rows = [R({ id: 'a', period_start: '2026-01-01' }), R({ id: 'b', period_start: '2026-09-01' })];
    sortReports(rows);
    assert.equal(rows[0].id, 'a');
  });

  test('空陣列不會爆', () => assert.deepEqual(sortReports([]), []));
});

describe('yearOf / reportTitle', () => {
  test('有期別看期別，沒有看申報日', () => {
    assert.equal(yearOf(R()), '2026');
    assert.equal(yearOf(R({ kind: '其他', period_start: null, uploaded_on: '2025-06-30' })), '2025');
  });
  test('標題就是標題，不要在這裡編一個出來', () => {
    assert.equal(reportTitle(R({ title: '115年 7-8月 (更正)' })), '115年 7-8月 (更正)');
  });
});

describe('★ matchReport —— 打「7-8」要找得到', () => {
  test('★★ 比的是算出來的期別，不是資料庫裡的 2026-07-01', () => {
    assert.equal(matchReport(R({ title: 'x' }), '7-8'), true);
  });
  test('標題、種類、備註、檔名都比得到', () => {
    const r = R({ title: '補申報那一份', note: '含留抵 1,204', file_name: '401_amend.pdf' });
    assert.equal(matchReport(r, '補申報'), true);
    assert.equal(matchReport(r, '401'), true);
    assert.equal(matchReport(r, '留抵'), true);
    assert.equal(matchReport(r, 'amend'), true);
  });
  test('空關鍵字全部通過', () => assert.equal(matchReport(R(), ''), true));
  test('沒中的回 false', () => assert.equal(matchReport(R({ title: 'a', note: null, file_name: null }), 'zzz'), false));
});

/* ── 檔案 ─────────────────────────────────────────── */

describe('reportFileKind / extOf', () => {
  test('三種格式分得出來', () => {
    assert.equal(reportFileKind('a.pdf'), 'pdf');
    assert.equal(reportFileKind('a.XLSX'), 'excel');
    assert.equal(reportFileKind('a.xls'), 'excel');
    assert.equal(reportFileKind('a.docx'), 'word');
    assert.equal(reportFileKind('a.doc'), 'word');
  });
  test('不收的回 other', () => {
    assert.equal(reportFileKind('a.jpg'), 'other');
    assert.equal(reportFileKind('沒有副檔名'), 'other');
    assert.equal(reportFileKind(null), 'other');
  });
  test('★ 副檔名一律轉小寫 —— 大寫的 .PDF 也是 PDF', () => {
    assert.equal(extOf('報表.PDF'), '.pdf');
  });
  test('每一種都有圖示上的字', () => {
    for (const k of ['pdf', 'excel', 'word', 'other'] as const) {
      assert.ok(FILE_BADGE[k].length > 0);
    }
  });
});

describe('★★★ reportFileName —— 下載下來就叫標題', () => {
  test('標題 ＋ 原副檔名', () => {
    assert.equal(reportFileName(R({ title: '115年 7-8月 401', file_name: 'x.pdf' })), '115年 7-8月 401.pdf');
  });

  test('★★★ 中文不會壞 —— 這個字串是給 <a download> 用的，不是塞進 HTTP 表頭', () => {
    const n = reportFileName(R({ title: '115年 8月 月報', file_name: 'a.xlsx' }));
    assert.equal(n, '115年 8月 月報.xlsx');
    assert.ok(!/[À-ÿ]{2,}/.test(n));   // 亂碼的形狀
  });

  test('★ Windows 不准的字元換成 _，不然存不進資料夾', () => {
    assert.equal(reportFileName(R({ title: '7/8月:401?', file_name: 'a.pdf' })), '7_8月_401_.pdf');
  });

  test('★ 標題已經帶副檔名就不重複加', () => {
    assert.equal(reportFileName(R({ title: '報表.pdf', file_name: 'a.pdf' })), '報表.pdf');
  });

  test('★ 標題空的退回原始檔名 —— 不要產生一個叫「.pdf」的檔', () => {
    assert.equal(reportFileName(R({ title: '', file_name: '原本的.pdf' })), '原本的.pdf');
    assert.equal(reportFileName(R({ title: '', file_name: null })), '報表');
  });

  test('★ 原本沒有副檔名就不加', () => {
    assert.equal(reportFileName(R({ title: '財簽報告', file_name: '沒有副檔名' })), '財簽報告');
  });
});

/* ── 列上第三行（2026-09-18「給檔案明細 大小 上傳日期」）─────── */

describe('★★ fileLine —— 空的整段不見，不是印「—」', () => {
  test('四段都有', () => {
    assert.equal(
      fileLine({ who: '芊', fileName: '401.pdf', size: '160 KB', uploadedOn: '2026-09-10' }),
      '芊　·　401.pdf　·　160 KB　·　上傳 09/10');
  });

  test('★★ 沒有上傳者 → 整段不見（不是留一個孤零零的「—」）', () => {
    const s = fileLine({ who: '', fileName: '401.pdf', size: '160 KB', uploadedOn: '2026-09-10' });
    assert.equal(s, '401.pdf　·　160 KB　·　上傳 09/10');
    assert.ok(!s.includes('—'));
  });

  test('★ 沒有上傳日 → 那一段不見，其餘照舊', () => {
    assert.equal(fileLine({ who: '芊', fileName: 'a.xlsx', size: '62 KB' }),
                 '芊　·　a.xlsx　·　62 KB');
  });

  test('★ 每一段自己帶著名字 —— 「上傳」兩個字不能省，不然分不出是哪個日期', () => {
    assert.ok(fileLine({ uploadedOn: '2026-09-10' }).startsWith('上傳 '));
  });

  test('★ 一段都沒有回空字串 —— 畫面那邊整行不畫', () => {
    assert.equal(fileLine({}), '');
    assert.equal(fileLine({ who: '  ', fileName: null, size: '', uploadedOn: null }), '');
  });

  test('日期只印月/日 —— 年份在期別裡已經有了', () => {
    assert.equal(fileLine({ uploadedOn: '2026-09-10' }), '上傳 09/10');
  });
});
