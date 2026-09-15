/*
 * migration_255_room_calendar_hide.sql　2026-09-15
 * 房源：多一個「排不排進排房表」的開關
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝失敗了，把錯誤訊息整段貼回來。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼不是用現成的 `properties.active`】
 *
 * 使用者 2026-09-15：「有的房源不用顯示，會報支出所以在。」
 *
 *   2B10（正隆）　沒有在出租，但支出記在它頭上 —— 房源必須留著
 *
 * `active = false` 做得到「排房表看不到」，但它同時把那間房
 * 從房務、清潔、採購的清單裡拿掉，而**支出還要繼續記到它頭上**。
 * 停用是「這間房不做了」；使用者要的是「這間房不排」。兩件事。
 *
 * ★★ 所以這一欄管的範圍很窄，窄到可以一句話講完:
 *   **房源狀態那張日曆畫不畫它。** 其他一律不受影響 ——
 *   支出、報表、房務、清潔、採購、關帳，一格都不動。
 *
 * ★ 預設 true（使用者指定：「預設啟用的物業都勾，我不要的把勾取消就好」）。
 *   預設 false 的話，新建的房源會安靜地不出現在排房表上，
 *   而沒有人會想到要去開它 —— 那種漏會在排房的時候才發現。
 *
 * ══════════════════════════════════════════════════════════
 * 【整個物業不排房怎麼辦】
 *
 * 不靠這一欄。物業那一頁本來就有「停用」，而房源狀態那一頁
 * 已經改成吃 `estates.active`（同一批 code）。
 * 復興那種整棟只記帳的，關物業就好，不用在房源表上點 74 次。
 * ══════════════════════════════════════════════════════════
 */

begin;

alter table public.properties
  add column if not exists show_in_room_calendar boolean not null default true;

comment on column public.properties.show_in_room_calendar is
  '房源狀態那張日曆畫不畫這間房。false = 只有那一頁看不到，'
  '支出／報表／房務／清潔／採購／關帳完全不受影響。'
  '（要整間房停掉是 active，不是這一欄。）migration_255，使用者 2026-09-15 指定。';

commit;


/* ── 自檢 ───────────────────────────────────────────────── */

create temp table _m255_test (ord int, name text, detail text, verdict text);

do $do$
declare
  v_id   uuid;
  v_name text;
  v_back boolean;
  v_ok   boolean := false;
begin
  /*
   * ★★ 真的改一次再改回去 —— 只看「欄位在不在」證明不了寫得進去。
   *   RLS 擋下來的時候回傳的是**成功加零列**，不是錯誤（README 坑 C），
   *   所以要回頭讀值來比對，而不是看有沒有丟例外。
   */
  select id, name into v_id, v_name from public.properties order by name limit 1;

  if v_id is not null then
    update public.properties set show_in_room_calendar = false where id = v_id;
    select show_in_room_calendar into v_back from public.properties where id = v_id;
    v_ok := (v_back is false);
    update public.properties set show_in_room_calendar = true where id = v_id;
  end if;

  insert into _m255_test values
    (3, '③ 開關真的寫得進去（改完已改回勾選）',
     coalesce(v_name, '（一間房源都沒有）') || '：'
       || case when v_ok then '取消得掉' else '★ 改不動 —— RLS 或權限' end,
     case when v_ok then '✅ 按得動' else '❌' end);
end $do$;


select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 欄位建好了',
         coalesce((select data_type || '，預設 ' || coalesce(column_default, '（無）')
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'properties'
                      and column_name = 'show_in_room_calendar'), '★ 沒有這一欄'),
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'properties'
                              and column_name = 'show_in_room_calendar')
              then '✅ 有' else '❌' end

  union all
  /*
   * ★★★ 這一條是「有沒有人被這支關掉」。
   *   使用者要的是「全部先勾好，我自己取消」——
   *   所以跑完應該**一間都沒被取消**。哪幾間不排，是他去畫面上點的。
   */
  select 2, '② 沒有任何房源被這支取消勾選',
         (select count(*)::text || ' 間房源，其中 '
                 || count(*) filter (where show_in_room_calendar) || ' 間會排進排房表'
            from public.properties),
         case when not exists (select 1 from public.properties where not show_in_room_calendar)
              then '✅ 全部維持勾選' else '❌ 有房源被取消了' end

  union all
  select t.ord, t.name, t.detail, t.verdict from _m255_test t

  union all
  /*
   * ★ 停用的房源本來就不畫（前端 `.eq('active', true)`）。
   *   這裡印出來只是讓人知道「排房表上會有幾間」不等於房源總數。
   */
  select 4, '④ 排房表實際會畫幾間',
         (select count(*)::text || ' 間　（停用 '
                 || (select count(*) from public.properties where not active) || ' 間不算）'
            from public.properties p
            join public.estates e on e.id = p.estate_id
           where p.active and e.active and p.show_in_room_calendar),
         '—'

  union all
  select 5, '⑤ 收尾', '自檢用 temp table，關掉分頁自己消失，不用清', '✅ 不留東西'

) as v(ord, "檢查", "結果", "判定")
order by v.ord;
