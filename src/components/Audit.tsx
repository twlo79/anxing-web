'use client';
import { ISSUE_CLS, type AuditIssue, type AuditResult } from '@/lib/audit-orders';
import ToggleInfo from '@/components/ToggleInfo';

/**
 * 防呆模式的畫面零件。訂單頁與營收頁共用 —— 同一種問題在兩頁要長得一樣，
 * 不然使用者得學兩套。
 */

/**
 * 開關。按下去才檢查，按回去標記全部消失。
 *
 * 【為什麼是開關而不是按鈕】
 * 按鈕表示「做一件事」，開關表示「處於某個狀態」——
 * 而防呆是後者：打開之後整個列表的意義都變了（多出標記、可以只看有問題的）。
 * 用按鈕的話，使用者按完不知道自己現在在不在那個狀態裡。
 *
 * 【為什麼是紅色】
 * 這是全站唯一一個「進入檢查模式」的入口，跟旁邊的下載、新增不同類 ——
 * 那些是日常操作，這個是「我現在要挑毛病」。顏色是那個區別最快的訊號。
 */
/**
 * 它實際上檢查哪七項。
 *
 * ★★ 這份清單是**從 `audit-orders.ts` 真的會 `add()` 的那幾種抄下來的**，
 *    不是憑印象寫的宣傳詞。少寫一項比寫錯一項好 ——
 *    寫了而實際上沒在檢查的，會讓人以為那件事有人在看。
 *
 * ★ 相似姓名不在裡面：它是上方摘要，不逐筆標記（見 audit-orders.ts 的 NameGroup）。
 */
const AUDIT_ITEMS: { k: AuditIssue; t: string }[] = [
  { k: '空間重疊', t: '整棟被訂走的期間，樓層還有訂單 —— 客人到現場才會發現' },
  { k: '重複訂單', t: '同一間房、同一段日期進了兩筆 —— 營收會多算' },
  { k: '房源過載', t: '同一天同一間房超過一組客人' },
  { k: '日期不合理', t: '迄日早於起日、0 晚、年份可能打錯' },
  { k: '資料缺失', t: '沒填房客或金額，或房源不在現有清單裡' },
  { k: '房價過低', t: '單價明顯低於同房型 —— 可能是漏打一位數' },
  { k: '房源名稱', t: '只差空白或大小寫，其實對得到' },
];

export function AuditButton({ on, onToggle, busy }: {
  on: boolean; onToggle: () => void; busy?: boolean;
}) {
  /*
   * ★★★ 外觀與行為搬到共用的 `<ToggleInfo>`（2026-08-29）——
   *   支出頁的「★ 重要支出」要長得一模一樣（使用者:「參考防呆」），
   *   而複製一份就是第二種寫法:改了一邊、另一邊會安靜地留在舊樣子。
   *
   * ★ 這裡只剩「防呆特有的說明內容」。
   *
   * ★★ 說明做成一顆 ⓘ，不是 `title` 提示:
   *     ① **手機沒有 hover** —— 在手機上那句話等於不存在
   *     ② `title` 只說得下「會檢查」，說不下**檢查什麼**，
   *        而看到一排紅標籤的人真正要知道的是後者
   */
  return (
    <ToggleInfo label="👀 防呆" on={on} onToggle={onToggle} tone="red"
      busy={busy} busyText="檢查中…" infoLabel="防呆會檢查什麼">
      <span className="block text-xs text-gray-500 mb-2">
        打開之後會重掃這一批資料，替有問題的訂單加上標籤，
        並且可以只看有問題的那些。<b>不會改到任何資料。</b>
      </span>
      <span className="block space-y-1.5">
        {AUDIT_ITEMS.map((x) => (
          <span key={x.k} className="flex gap-2 items-start">
            <span className={`inline-block shrink-0 rounded border px-1.5 py-0.5
                              text-[11px] font-medium whitespace-nowrap ${ISSUE_CLS[x.k]}`}>
              {x.k}
            </span>
            <span className="text-[11px] text-gray-500 leading-relaxed">{x.t}</span>
          </span>
        ))}
      </span>
      {/*
        ★ 顏色的意思也要說 —— 畫面上有紅、橘、琥珀、藍四種標籤,
          看的人會自己猜，而猜錯的方向通常是「藍色的不用理」。
      */}
      <span className="block mt-2 pt-2 border-t border-mor-line text-[11px] text-gray-400">
        紅＝客人會撞在一起或錢算錯，琥珀＝資料要補，藍＝提示，改不改都行。
      </span>
    </ToggleInfo>
  );
}

export function AuditBadges({ entry }: {
  entry?: { issues: AuditIssue[]; notes: string[] };
}) {
  if (!entry?.issues.length) return null;
  return (
    // title 帶完整說明 —— 標籤只放得下四個字，
    // 「為什麼它有問題」才是使用者真正要看的東西
    <span className="inline-flex flex-wrap gap-1 align-middle" title={entry.notes.join('\n')}>
      {entry.issues.map((i) => (
        <span key={i}
          className={`inline-block rounded border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${ISSUE_CLS[i]}`}>
          {i}
        </span>
      ))}
    </span>
  );
}

/*
 * 排序 = 嚴重程度。前面幾個是「錢算錯了」，最後一個是「資料不整齊」。
 *
 * ★ 房源名稱放最後（2026-08-24）—— 只差空白或大小寫，改一下就好。
 *   放前面的話會把真正該處理的重疊與重複往下推。
 *
 * ★ **相似姓名不在這個清單裡** —— 它不是逐筆標記，是下面的摘要區塊。
 *   實際資料是 900 筆會被標而九成是不同的人（見 audit-orders.ts 的 NameGroup）。
 */
const ORDER: AuditIssue[] = [
  '空間重疊', '重複訂單', '房源過載', '日期不合理', '資料缺失', '房價過低',
  '房源名稱',
];

/**
 * 上方摘要。
 *
 * 【為什麼要有這一塊】
 * 只標在列上的話，使用者得自己翻完幾百列才知道「到底有沒有問題」。
 * 而多數時候答案是「沒有」—— 那句話應該一秒就看得到，
 * 否則他會為了確認沒事而把整份清單看一遍。
 */
export function AuditSummary({ result, onlyBad, onToggleOnly }: {
  result: AuditResult;
  onlyBad?: boolean;
  onToggleOnly?: () => void;
}) {
  const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
  /*
   * ★ 相似姓名要一起算進「有沒有問題」。
   *   只看 counts 的話，其他都乾淨但有 187 組相似姓名時，
   *   畫面會說「沒有發現問題」而下面那一區塊根本不會被渲染 ——
   *   通知等於消失。
   */
  const badNames = result.nameGroups.filter((g) => g.inconsistent).length;
  if (!total && !badNames) {
    return (
      <div className="rounded-xl border border-mor-green/30 bg-mor-greenlight px-4 py-2.5 mb-3 text-sm text-mor-green">
        檢查了 {result.scanned.toLocaleString('en-US')} 筆，沒有發現問題。
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3 mb-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-amber-900">
          檢查了 {result.scanned.toLocaleString('en-US')} 筆，
          {/* 只有相似姓名時不要說「有問題的地方」—— 那不是問題，是待確認 */}
          {total ? '有問題的地方：' : '沒有發現錯誤，但有幾組姓名要確認：'}
        </span>
        {ORDER.filter((i) => result.counts[i] > 0).map((i) => (
          <span key={i} className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${ISSUE_CLS[i]}`}>
            {i} {result.counts[i]}
          </span>
        ))}
        {onToggleOnly && (
          <button onClick={onToggleOnly}
            className="ml-auto text-xs text-mor-slate underline hover:text-mor-slatedark">
            {onlyBad ? '顯示全部' : '只看有問題的'}
          </button>
        )}
      </div>

      {/*
        房源過載單獨列出來 —— 它是唯一「看單一列看不出來」的問題：
        每一筆訂單自己都很正常，是加起來才超過那個月的天數。
      */}
      {result.overloads.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-amber-900">
          {result.overloads.slice(0, 8).map((v) => (
            <li key={v.property + v.scope}>
              <b>{v.property}</b> 在 {v.scope} 被訂了 <b>{v.used} 晚</b>，
              但只有 {v.limit} 天 —— 多出 {v.used - v.limit} 晚（{v.orderIds.length} 筆訂單）
            </li>
          ))}
          {result.overloads.length > 8 && (
            <li className="text-amber-700">…還有 {result.overloads.length - 8} 間</li>
          )}
        </ul>
      )}
      {/*
        ★★ 相似姓名（2026-08-24 使用者:「相似名字在多間出現訂單也要通知」）。

        ★ 用 <details> 收起來，預設不展開。
          實際資料有 187 組 —— 攤開來會把上面那些真正該處理的東西推到看不見。
          「通知」的意思是「要看的時候找得到」，不是「一直擋在眼前」。

        ★ 只顯示**寫法不一致**的那幾組。寫法完全一樣的（40 組）
          純粹是同名的不同人，列出來沒有任何可以做的事。
      */}
      {(() => {
        const bad = result.nameGroups.filter((g) => g.inconsistent);
        if (!bad.length) return null;
        return (
          <details className="mt-2">
            <summary className="text-xs text-amber-900 cursor-pointer select-none">
              相似的房客姓名 <b>{bad.length}</b> 組
              <span className="text-amber-700">
                　—— 同一個名字的不同寫法出現在多間房。可能是同一個人，也可能只是同名
              </span>
            </summary>
            <ul className="mt-1.5 max-h-80 overflow-y-auto overscroll-contain space-y-0.5 text-sm text-amber-900">
              {bad.slice(0, 50).map((g) => (
                <li key={g.names.join('|')}>
                  <b>{g.names.join('、')}</b>
                  <span className="text-amber-700">
                    　{g.rooms.length} 間房 ／ {g.orderCount} 筆訂單
                  </span>
                </li>
              ))}
              {bad.length > 50 && (
                <li className="text-amber-700">…還有 {bad.length - 50} 組</li>
              )}
            </ul>
          </details>
        );
      })()}

      <div className="mt-2 text-xs text-amber-700">
        這些只是提醒,資料沒有被更動。滑到標籤上可以看原因。
      </div>
    </div>
  );
}
