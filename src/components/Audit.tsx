'use client';
import { ISSUE_CLS, type AuditIssue, type AuditResult } from '@/lib/audit-orders';

/**
 * 防呆模式的畫面零件。訂單頁與營收頁共用 —— 同一種問題在兩頁要長得一樣，
 * 不然使用者得學兩套。
 */

/** 開關。按下去才檢查，按回去標記全部消失。 */
export function AuditButton({ on, onToggle, busy }: {
  on: boolean; onToggle: () => void; busy?: boolean;
}) {
  return (
    <button type="button" onClick={onToggle} disabled={busy}
      aria-pressed={on}
      title="檢查資料有沒有重複、重疊、缺漏、房價異常"
      className={`rounded-lg px-3 py-1.5 font-medium whitespace-nowrap transition-colors ${
        on ? 'bg-mor-slate text-white hover:bg-mor-slatedark'
           : 'border border-mor-line bg-white hover:bg-mor-sand/60'
      } disabled:opacity-50`}>
      {busy ? '檢查中…' : on ? '👀 防呆（開）' : '👀 防呆'}
    </button>
  );
}

/** 一列訂單上的問題標籤。 */
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

const ORDER: AuditIssue[] = ['重複訂單', '房源過載', '日期不合理', '資料缺失', '房價過低'];

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
  if (!total) {
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
          檢查了 {result.scanned.toLocaleString('en-US')} 筆，有問題的地方：
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
      <div className="mt-2 text-xs text-amber-700">
        這些只是提醒,資料沒有被更動。滑到標籤上可以看原因。
      </div>
    </div>
  );
}
