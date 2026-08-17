'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import {
  roomCell, rangeText, nightlyRate, isSplit, fmtMoney, nightsText, type RevRow,
} from '@/lib/revenue-row';

/**
 * 營收明細抽屜。點一列從右邊滑出。
 *
 * ============================================================
 * 【為什麼合併欄位一定要配一個抽屜】（2026-08-16 使用者指定）
 *
 * 九欄併成六欄之後，資訊沒有變少，只是**有些變成第二行的灰字**。
 * 但有兩個東西是真的看不到了:
 *
 *   · 兩段完全相同時第二行不印（沒跨月的訂單看不到訂單起訖）
 *   · 排序鍵少了三個
 *
 * 合併如果只是「藏起來」，那就是把可讀性換成了資訊量的減損。
 * 抽屜是那筆交換的另一半:**表格負責掃，抽屜負責看。**
 *
 * 而且抽屜裝得下表格裝不下的東西 —— 均價、負責人、入帳、押金、備註，
 * 那些現在只有下載 Excel 才看得到。
 *
 *
 * ============================================================
 * 【為什麼開啟時才查訂單】
 *
 * `revenue_recognitions` 沒有 `contract_id`、`paid`、`account`、`note`。
 * 那些在 `orders`。
 *
 * 列表一次撈 159 筆，每筆都補查一次訂單等於多 159 個查詢 ——
 * 而使用者一次只會打開一筆。開啟時才查,關掉就丟。
 *
 * 【查不到不是錯誤】
 * 一次性收入與部分舊資料的 `order_id` 可能是 null。
 * 那時抽屜照開，只是下半段不顯示 —— 上半段（認列本身）永遠有。
 */

type OrderExtra = {
  id: string;
  order_key: string | null;
  contract_id: string | null;
  amount: number | null;
  deposit: number | null;
  account: string | null;
  note: string | null;
  paid: boolean | null;
  paid_at: string | null;
  paid_amount: number | null;
  item_name: string | null;
};

const ROW = 'flex items-start gap-3 px-4 py-2 text-sm';
const LB = 'text-gray-500 w-[72px] shrink-0';

export default function RowDrawer({
  row, oid, sourceLabel, orderRangeText, onClose,
}: {
  row: RevRow | null;
  /** 訂單 id。一次性收入與舊資料可能沒有 */
  oid: string | null;
  sourceLabel: string;
  /** 長租傳契約期間進來 —— 月租單的 checkin~checkout 只是那個月，看不出屬於哪份契約 */
  orderRangeText?: string;
  onClose: () => void;
}) {
  const [extra, setExtra] = useState<OrderExtra | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  useEffect(() => {
    let dead = false;
    setExtra(null);
    if (!oid) return;
    setLoading(true);
    (async () => {
      const supabase = createClient();
      const { data } = await supabase.from('orders')
        .select('id, order_key, contract_id, amount, deposit, account, note, paid, paid_at, paid_amount, item_name')
        .eq('id', oid).maybeSingle();
      if (dead) return;
      setExtra((data as OrderExtra) ?? null);
      setLoading(false);
    })();
    return () => { dead = true; };
  }, [oid]);

  if (!row) return null;

  const room = roomCell(row);
  const rate = nightlyRate(row);
  const split = isSplit(row);

  return (
    <>
      {/*
        遮罩只在手機上蓋滿。桌機留著表格可見 ——
        抽屜開著還能直接點下一列切換，不用關掉再開。
      */}
      <div onClick={onClose}
        className="fixed inset-0 z-40 bg-black/40 md:bg-transparent md:pointer-events-none" />

      <aside role="dialog" aria-label="營收明細"
        className="fixed z-50 bg-white shadow-2xl flex flex-col
                   inset-x-0 bottom-0 max-h-[88vh] rounded-t-2xl
                   md:inset-y-0 md:left-auto md:right-0 md:w-[380px] md:max-w-[92vw]
                   md:max-h-none md:rounded-none md:border-l md:border-mor-line">

        <div className="shrink-0 flex items-start gap-2 px-4 py-3 border-b border-mor-line">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-xs text-gray-500">{sourceLabel}</span>
              {extra?.order_key && (
                <span className="text-xs text-gray-400 truncate">{extra.order_key}</span>
              )}
            </div>
            <div className="text-[15px] font-semibold truncate">
              {room.main}{row.guest_name ? ` · ${row.guest_name}` : ''}
            </div>
          </div>
          <button onClick={onClose} aria-label="關閉"
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg
                       text-gray-400 hover:text-gray-600 hover:bg-mor-sand/60 text-xl leading-none">✕</button>
        </div>

        <div className="flex-1 overflow-auto">
          {/* 兩個金額並排。表格上是上下兩行，這裡拉開 —— 抽屜有寬度 */}
          <div className="flex gap-2 px-4 py-3">
            <div className="flex-1 rounded-lg bg-mor-sand/40 px-3 py-2">
              <div className="text-xs text-gray-500">當期認列</div>
              <div className="text-lg font-semibold">{fmtMoney(row.month_amount)}</div>
            </div>
            <div className="flex-1 rounded-lg bg-mor-sand/40 px-3 py-2">
              <div className="text-xs text-gray-500">訂單總額</div>
              <div className="text-lg font-semibold">{fmtMoney(row.total_amount)}</div>
            </div>
          </div>

          {/*
            跨月的解釋。**只在真的跨月時出現。**
            每一筆都印的話這句話會變成背景noise，而它存在的理由正是
            「為什麼這兩個數字不一樣」—— 那是打開抽屜最常見的原因。
          */}
          {split && (
            <p className="mx-4 mb-3 rounded-lg bg-mor-bluelight/60 px-3 py-2 text-xs text-mor-slate leading-relaxed">
              這筆訂單跨月。整筆 {row.total_nights} 晚 {fmtMoney(row.total_amount)}，
              依晚數分攤後這個月認列 {row.month_nights} 晚。
            </p>
          )}

          <div className="border-t border-mor-line/60" />

          <div className={ROW}><span className={LB}>物業</span><span className="flex-1">{row.estate_name ?? '—'}</span></div>
          <div className={ROW}><span className={LB}>房源</span><span className="flex-1">{room.sub ? room.main : '—'}</span></div>
          <div className={ROW}><span className={LB}>客戶</span><span className="flex-1">{row.guest_name ?? '—'}</span></div>
          <div className={ROW}>
            <span className={LB}>{row.source === 'longterm' ? '契約期間' : '訂單起訖'}</span>
            <span className="flex-1">{orderRangeText || rangeText(row.checkin, row.checkout)}</span>
          </div>
          <div className={ROW}>
            <span className={LB}>認列起訖</span>
            <span className="flex-1">{rangeText(row.period_start || row.checkin, row.period_end || row.checkout)}</span>
          </div>
          <div className={ROW}><span className={LB}>認列天數</span><span className="flex-1">{nightsText(row)}</span></div>
          <div className={ROW}>
            <span className={LB}>每晚均價</span>
            {/*
              算不出來寫「—」不寫「$0」。
              $0 的意思是「每晚零元」，那跟「這筆沒有晚數」是兩件事。
            */}
            <span className="flex-1">{rate == null ? '—' : `${fmtMoney(rate)} / 晚`}</span>
          </div>
          {row.item_name && (
            <div className={ROW}><span className={LB}>項目</span><span className="flex-1">{row.item_name}</span></div>
          )}

          {oid && (
            <>
              <div className="h-2 bg-mor-sand/30 border-y border-mor-line/50 my-1" />
              {loading ? (
                <div className="px-4 py-4 text-sm text-gray-400">讀取訂單…</div>
              ) : !extra ? (
                <div className="px-4 py-4 text-sm text-gray-400">找不到對應的訂單（可能已刪除）</div>
              ) : (
                <>
                  <div className={ROW}>
                    <span className={LB}>收款</span>
                    <span className="flex-1">
                      {extra.paid
                        ? <span className="text-mor-green">已收款{extra.paid_at ? `・${extra.paid_at.slice(0, 10)}` : ''}</span>
                        : <span className="text-amber-700">未收款</span>}
                      {/* 部分收款要看得出來 —— 只印「未收款」的話，
                          已經收了八成的訂單跟一毛沒收的長得一樣 */}
                      {!!extra.paid_amount && !extra.paid && (
                        <span className="text-gray-500">（已收 {fmtMoney(extra.paid_amount)}）</span>
                      )}
                    </span>
                  </div>
                  <div className={ROW}><span className={LB}>帳戶</span><span className="flex-1">{extra.account || '—'}</span></div>
                  <div className={ROW}><span className={LB}>押金</span><span className="flex-1">{extra.deposit ? fmtMoney(extra.deposit) : '—'}</span></div>
                  {extra.note && (
                    <div className={ROW}>
                      <span className={LB}>備註</span>
                      <span className="flex-1 whitespace-pre-wrap break-words">{extra.note}</span>
                    </div>
                  )}
                </>
              )}
            </>
          )}
          <div className="h-3" />
        </div>

        {/*
          【為什麼是連結不是「在這裡編輯」】
          在抽屜裡直接改訂單的話，改完這一頁的認列數字是舊的 ——
          而認列是由觸發器重算的，前端不知道它變了。
          跳過去改，回來重新載入，數字才是對的。

          【契約鈕只在有契約時出現】
          長租的月租單才有 contract_id。一律顯示但按了說「這筆沒有契約」，
          等於讓人白按一次 —— 而他要按之前並不知道。
        */}
        {extra && (
          <div className="shrink-0 flex gap-2 px-4 py-3 border-t border-mor-line">
            <Link href={`/shortterm?order=${extra.id}`}
              className="flex-1 rounded-lg border border-mor-line px-3 py-2 text-sm text-center
                         hover:bg-mor-sand/60">看訂單</Link>
            {extra.contract_id && (
              <Link href={`/contracts?contract=${extra.contract_id}`}
                className="flex-1 rounded-lg border border-mor-line px-3 py-2 text-sm text-center
                           hover:bg-mor-sand/60">看契約</Link>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
