'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import {
  parseRows, splitAssignees, staffLookup, type HkStaff, type HkProperty,
} from '@/lib/hkParse';
import { splitRecords } from '@/lib/hk-import-text';

/**
 * 匯入 TimeTree 排班。
 *
 * ============================================================
 * 【為什麼在行事曆這一頁，不在排班統計】（2026-08-14 使用者指定）
 *
 * 匯入改變的是**行事曆**：誰在哪一天做什麼。排班統計只是把那份資料
 * 加總起來看。把匯入放在統計頁，等於「按了一顆按鈕，另一頁變了」——
 * 而人不會回去看另一頁確認。
 *
 * 現在按下去、關掉面板，同一個畫面上的格子就從灰色變成各人的顏色。
 * 那個顏色的變化本身就是「匯入成功了」的證據。
 *
 *
 * ============================================================
 * 【匯入之後會自動套用指派】
 *
 * 匯入寫的是 `hk_work_item`（誰做），行事曆讀的是 `hk_task`（哪天哪間）。
 * 兩張表要靠 `hk_apply_timetree()` 接起來。
 *
 * 那一步**不讓人自己記得去做** —— 分開的話他會匯完發現行事曆沒變，
 * 以為匯入失敗，然後再匯一次。
 */

type Setting = { key: string; value: string | null };

export default function ImportPanel({
  onClose, onDone, onMsg,
}: {
  onClose: () => void;
  /** 匯入並套用完成。呼叫端要重載行事曆 */
  onDone: () => void;
  onMsg: (t: string, err?: boolean) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [staff, setStaff] = useState<HkStaff[]>([]);
  const [props, setProps] = useState<HkProperty[]>([]);
  const [includeGift, setIncludeGift] = useState(true);
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const [s, p, st] = await Promise.all([
        supabase.from('hk_staff').select('*').eq('active', true).order('sort'),
        supabase.from('hk_property').select('*').eq('active', true).order('sort'),
        supabase.from('hk_setting').select('key, value'),
      ]);
      setStaff((s.data ?? []) as HkStaff[]);
      setProps((p.data ?? []) as HkProperty[]);
      const map = Object.fromEntries(((st.data ?? []) as Setting[]).map((x) => [x.key, x.value]));
      setIncludeGift(map['include_gift'] !== 'false');
    })();
  }, [supabase]);

  const preview = useMemo(() => {
    if (!raw.trim() || !staff.length) return null;
    /*
     * 切法在 lib/hk-import-text.ts。
     *
     * 原本是 split('\n') —— 而實際貼進來的換行是掉光的，
     * 整個月變成「一筆」，負責人欄變成後面所有內容。
     * 預覽顯示「共 1 筆、未知人員 SHAO-YING HSIEH」,
     * 看起來像人員主檔的問題，其實解析從第一步就散了。
     */
    const rows = splitRecords(raw);
    const parsed = parseRows(rows, staff, props, { includeGift });
    const unknownNames = new Set<string>();
    for (const r of rows) {
      for (const n of splitAssignees(r.assignees)) {
        if (!staffLookup(staff).has(n)) unknownNames.add(n);
      }
    }
    /*
     * 跨月的資料要擋下來。
     *
     * 匯入端點的 period 是**全刪重建的單位** —— 兩個月混在同一批送出去，
     * 其中一個月會被當成另一個月的內容整批覆蓋，而畫面上的數字看起來完全正常。
     */
    const months = Array.from(new Set(parsed.map((p) => p.date.slice(0, 7))));
    return { rows, parsed, unknownNames: Array.from(unknownNames), months };
  }, [raw, staff, props, includeGift]);

  const doImport = useCallback(async () => {
    if (!preview) return;
    const { parsed, months } = preview;
    if (months.length > 1) {
      return onMsg(`這批資料跨了 ${months.join('、')} 兩個月,不能一起匯 —— `
        + '一次只能匯一個月（同月份是全刪重建）。請分開貼。', true);
    }
    const per = parsed[0]?.date.slice(0, 7).replace('-', '') ?? '';
    if (!per) return onMsg('看不出這批是哪個月的', true);
    if (!confirm(`匯入 ${parsed.length} 筆到 ${per}？\n\n`
      + '同月份的既有資料會先清空再重建，\n接著自動把「誰做」套到行事曆上。')) return;

    setBusy(true);
    try {
      /*
       * 全刪重建。解析規則會改，增量更新會讓新舊規則的結果混在同一個月裡。
       * 硬刪除不進回收桶 —— 這是「整期重匯前先清空」，一次幾百格；
       * 進回收桶的話，真正誤刪的那一格會被埋在幾百筆機制紀錄裡面。
       */
      await supabase.from('hk_work_item').delete().eq('period', per);
      await supabase.from('hk_event').delete().eq('period', per);

      const byName = staffLookup(staff);
      for (const e of parsed) {
        // 入住準備組完全不匯入
        const known = e.assigneeNames.map((n) => byName.get(n)).filter(Boolean) as HkStaff[];
        if (e.excluded === 'not_counted' && !known.some((s) => s.count_mode !== 'none')) continue;

        const { data: ev, error } = await supabase.from('hk_event').insert({
          period: per, event_date: e.date, title: e.title,
          assignees: e.assigneeNames, parsed_code: e.propertyCode,
          work_type: e.workType, excluded: e.excluded,
        }).select('id').single();
        if (error) { onMsg('匯入失敗：' + error.message, true); return; }

        // 休假寫進 hk_day，不產生工作項
        if (e.excluded === 'leave') {
          const s = staff.find((x) => x.code === e.leaveStaffCode);
          if (s) {
            const status = e.title.includes('颱風') ? '颱風假' : '休';
            await supabase.from('hk_day').upsert({
              period: per, work_date: e.date, staff_id: s.id, status,
            }, { onConflict: 'work_date,staff_id' });
          }
          continue;
        }
        if (e.excluded) continue;

        const rows = known.filter((s) => s.count_mode !== 'none').map((s) => ({
          event_id: ev.id, period: per, work_date: e.date,
          property_code: e.propertyCode, work_type: e.workType, staff_id: s.id,
        }));
        if (rows.length) await supabase.from('hk_work_item').insert(rows);
      }

      /*
       * 接起來：把「誰做」套到行事曆的工作上。
       *
       * 不讓人自己記得去做 —— 分開的話他會匯完發現行事曆沒變，
       * 以為匯入失敗，然後再匯一次。
       */
      const y = Number(per.slice(0, 4)), m = Number(per.slice(4, 6));
      const from = `${per.slice(0, 4)}-${per.slice(4, 6)}-01`;
      const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const { data: rep, error: applyErr } = await supabase.rpc('hk_apply_timetree', {
        p_from: from, p_to: to, p_dry: false,
      });
      if (applyErr) {
        // 匯入本身成功了，只是沒接上 —— 要講清楚，不然他會整批重匯
        onMsg(`排班已匯入，但套用到行事曆失敗：${applyErr.message}`
          + '（資料在，可到 SQL Editor 手動跑 hk_apply_timetree）', true);
      } else {
        const hit = (rep as { item: string; n: number }[] | null)
          ?.find((r) => r.item.includes('套上指派'))?.n ?? 0;
        onMsg(`匯入 ${parsed.length} 筆，其中 ${hit} 筆已指派到行事曆上`);
      }
      setRaw('');
      onClose();
      onDone();
    } finally { setBusy(false); }
  }, [preview, staff, supabase, onMsg, onClose, onDone]);

  return (
    <div className="fixed inset-0 bg-black/30 flex items-stretch md:items-start justify-center overflow-auto md:py-10 z-50"
      onClick={onClose}>
      <div className="bg-white w-full md:w-[860px] md:max-w-[95vw] md:rounded-xl shadow-xl min-h-full md:min-h-0"
        onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-mor-line px-6 py-4 font-bold flex items-center justify-between z-10">
          匯入 TimeTree 排班
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>
        <div className="p-6 space-y-3 text-sm">
          <div className="text-xs text-gray-500">
            格式 <code className="bg-gray-100 px-1">日期,事項,負責人</code>，多位負責人用
            <code className="bg-gray-100 px-1">+</code> 分隔。
            換行有沒有跟著貼進來都可以 —— 看到日期就切一筆。
            排程抓下來的 JSON 也可以直接整份貼。
            <b className="text-amber-700 ml-1">一次只能貼一個月</b>（同月份是全刪重建）。
          </div>
          <textarea value={raw} onChange={(e) => setRaw(e.target.value)}
            placeholder={'2026-08-01,退-A2-Martin Kossa,SHAO-YING HSIEH\n2026-08-01,B5-吳瑋茹-入住,月(Dianne)'}
            className="w-full h-48 rounded-lg border border-mor-line px-2 py-2 font-mono text-xs" />

          {preview && (
            <div className="rounded-lg border border-mor-line divide-y divide-mor-line/40 text-xs">
              <div className="px-3 py-2 flex flex-wrap gap-4">
                <span>共 <b>{preview.parsed.length}</b> 筆</span>
                <span className="text-mor-green">採計 {preview.parsed.filter((p) => !p.excluded).length}</span>
                <span className="text-amber-600">休假 {preview.parsed.filter((p) => p.excluded === 'leave').length}</span>
                <span className="text-gray-400">不計 {preview.parsed.filter((p) => p.excluded === 'not_counted').length}</span>
                <span className="text-red-600">未指派 {preview.parsed.filter((p) => p.excluded === 'no_assignee').length}</span>
              </div>
              {preview.months.length > 1 && (
                <div className="px-3 py-2 text-red-600">
                  這批跨了 {preview.months.join('、')} —— 不能一起匯。
                  <div className="text-gray-400 mt-0.5">
                    匯入是「整個月清空重建」，兩個月混在一起會有一個月被另一個月蓋掉，
                    而數字看起來完全正常。
                  </div>
                </div>
              )}
              {preview.parsed.some((p) => !p.excluded && p.unknownToken) && (
                <div className="px-3 py-2 text-red-600">
                  未識別房源：{Array.from(new Set(preview.parsed.filter((p) => !p.excluded && p.unknownToken).map((p) => p.unknownToken))).join('、')}
                  <div className="text-gray-400 mt-0.5">仍會匯入，但不會計入打掃次數。建議先到設定補建房源或別名。</div>
                </div>
              )}
              {preview.unknownNames.length > 0 && (
                <div className="px-3 py-2 text-red-600">
                  未知人員：{preview.unknownNames.join('、')}
                  <div className="text-gray-400 mt-0.5">不在人員主檔內，這些人的工作項會被略過。</div>
                </div>
              )}
              <div className="px-3 py-2 max-h-40 overflow-auto">
                {preview.parsed.slice(0, 12).map((p, i) => (
                  <div key={i} className="flex gap-2 py-0.5">
                    <span className="text-gray-400 w-20 shrink-0">{p.date.slice(5)}</span>
                    <span className="flex-1 min-w-0 truncate">{p.title}</span>
                    <span className={`w-24 shrink-0 text-right ${p.excluded ? 'text-gray-400' : 'text-mor-blue'}`}>
                      {p.excluded === 'leave' ? '休假' : p.excluded === 'no_assignee' ? '未指派'
                        : p.excluded ? '不計' : (p.propertyCode ?? '無房源')}
                    </span>
                  </div>
                ))}
                {preview.parsed.length > 12 && <div className="text-gray-400 pt-1">…另有 {preview.parsed.length - 12} 筆</div>}
              </div>
            </div>
          )}
        </div>
        <div className="border-t border-mor-line px-6 py-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm">取消</button>
          <button onClick={doImport} disabled={!preview || busy || (preview?.months.length ?? 0) > 1}
            className="rounded-lg bg-mor-slate text-white px-4 py-1.5 text-sm font-medium hover:bg-mor-slatedark disabled:opacity-40">
            {busy ? '匯入中…' : '確認匯入並套用'}</button>
        </div>
      </div>
    </div>
  );
}
