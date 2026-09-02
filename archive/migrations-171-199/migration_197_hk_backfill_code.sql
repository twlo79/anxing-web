/*
 * migration_197 —— 把事件已經對到的房源補回排班表
 * ============================================================
 * 2026-09-01 使用者：「沒登記進去」（8/23、8/28 的格子是空的）。
 *
 * ============================================================
 * 【怎麼壞的】
 *
 * 「重新解析」只寫了 `hk_event.parsed_code`，沒有寫
 * `hk_work_item.property_code`。兩張表各存一次「這筆是哪一間」:
 *
 *   hk_event.parsed_code        事件對到哪個房源（例外清單看它）
 *   hk_work_item.property_code  排班表那一格顯示什麼、點數算哪一間
 *
 * 只寫前者的結果:
 *
 *   · 事件離開例外清單          ✔ 看起來處理好了
 *   · 間數照算                  ✔ 4 間
 *   · 排班表那一格是空的        ✘「庭玉 清潔」而不是「庭玉 JPR2F」
 *   · 打掃點數算不出來          ✘ 卡片上那個「⚠ N 筆未計」
 *
 * ★★★ 這是 CLAUDE.md 坑表上「一份資料存在兩個地方」的第二次 ——
 *   上一次是 `deposits.amount` 與 `deposits.lines`（migration_195）。
 *   程式端已經修成兩張一起寫，這一支補既有的資料。
 *
 * ============================================================
 * 【只補「空的」，不覆蓋】
 *
 * `w.property_code is null` 是唯一的條件 —— 人手動填過的格子一律不動。
 * 人填的優先於推導的:使用者看著行事曆填進去的那一間，
 * 比解析器從標題猜出來的更可信。
 *
 * ★ 不限期間。這是「用連結補一個空欄位」，對哪一個月都是同一件對的事。
 */

update public.hk_work_item w
   set property_code = e.parsed_code
  from public.hk_event e
 where w.event_id = e.id
   and w.property_code is null
   and e.parsed_code is not null;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('197_hk_backfill_code');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢。
-- ★ 基準值不依賴這支改的東西:第 1 列數的是「還對不起來的筆數」，
--   正確答案永遠是 0，跟這支補了幾格無關（migration_187／191 踩過）。
-- ★ 檢查要涵蓋既有資料的所有合法形狀:事件本身沒有 parsed_code 的
--   （協助行政、洗烘折毛巾、聚餐）**本來就該是空的**，不算不一致
--   （194 那次沒做到，6 筆正常資料被誤報）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ ① 還有沒有「事件對到了、格子卻空著」',
         (select case when count(*) = 0 then '✅ 0 筆'
                      else '⚠ 還有 ' || count(*) || ' 筆' end
            from public.hk_work_item w
            join public.hk_event e on e.id = w.event_id
           where w.property_code is null and e.parsed_code is not null),
         '★ 這是這支要消滅的東西。事件本身沒有 parsed_code 的不算 —— '
           || '協助行政、洗烘折毛巾、聚餐那些本來就沒有房源'

  union all
  select 2, '② 202608 補了哪幾格',
         coalesce((select string_agg(w.work_date || '　' || w.property_code
                                     || '　' || coalesce(s.name, '?'), E'\n'
                                     order by w.work_date)
                     from public.hk_work_item w
                     join public.hk_event e on e.id = w.event_id
                     left join public.hk_staff s on s.id = w.staff_id
                    where w.period = '202608'
                      and w.property_code = e.parsed_code
                      and w.source = 'timetree'
                      and w.work_date in ('2026-08-23', '2026-08-28')),
                  '（那兩天沒有對得起來的格子 —— 要人工看）'),
         '★ 要看到 08-23 JPR2F 與 08-28 台4'

  union all
  select 3, '★★ ③ 手動填的沒有被覆蓋',
         (select count(*)::text || ' 筆手動項目，其中 '
                 || count(*) filter (where property_code is not null)::text || ' 筆有房源'
            from public.hk_work_item where source = 'manual'),
         '★ 這支的 where 只有 `property_code is null`，手動填過的一格都不該動'

  union all
  select 4, '④ 工作項目總數沒變',
         (select count(*)::text || ' 筆（202608：'
                 || (select count(*) from public.hk_work_item where period = '202608')::text || '）'
            from public.hk_work_item),
         '★ 這支只填空欄位，不新增也不刪除'

  union all
  select 5, '⑤ 202608 還有幾格是空的',
         (select count(*)::text || ' 格'
            from public.hk_work_item where period = '202608' and property_code is null),
         '★ 剩下的應該都是「事件本身也沒對到房源」的 —— 那些要走例外清單的「補」'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
