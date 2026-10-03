/* 查（只讀）：佈告欄排了活動，為什麼「通知」裡沒有、手機也沒叮                       2026-10-03
 *
 * 管線是：board_events 新增 → 觸發器 trg_board_event_push（migration_278）
 *        → pg_net 打 /api/push/board-event → 寫 notifications ＋ 推播
 * 這支一段一段看，哪一段斷了就看得出來。一個字都不改。
 * ★ 金鑰只印長度，不印值。
 */
with ev as (
  select e.*, coalesce(p.name, '?') as who
    from public.board_events e left join public.profiles p on p.id = e.created_by
   order by e.created_at desc limit 6
)
select 1 as 序, '① 觸發器在不在' as 檢查,
       coalesce((select tgname || case when tgenabled = 'D' then '（停用中）' else '' end
                   from pg_trigger where tgrelid = 'public.board_events'::regclass and tgname = 'trg_board_event_push'), '（沒有）') as 結果
union all
select 2, '② 推播金鑰 push_key',
       case when to_regclass('public.app_secrets') is null then '（沒有 app_secrets 這張表）'
            else coalesce((select '有，長度 ' || length(value) from public.app_secrets where name = 'push_key'), '（沒設）') end
union all
select 3, '③ 推播網址 push_url',
       case when to_regclass('public.app_secrets') is null then '（沒有表）'
            else coalesce((select value from public.app_secrets where name = 'push_url'), '（沒設）') end
union all
select 4, '④ pg_net 裝了沒',
       coalesce((select 'pg_net ' || extversion from pg_extension where extname = 'pg_net'), '（沒裝）')
union all
select 5, '⑤ 最近的活動 → 各存了幾則「活動通知」',
       (select string_agg(to_char(ev.created_at at time zone 'Asia/Taipei', 'MM-DD HH24:MI') || ' ' || ev.who || ' 排「' || ev.title || '」→ '
                 || (select count(*) from public.notifications n
                      where n.kind = 'board' and n.body like '%' || ev.title || '%'
                        and n.created_at between ev.created_at and ev.created_at + interval '10 minutes') || ' 則',
                 '；' order by ev.created_at desc) from ev)
union all
select 6, '⑥ 活動通知一共存過幾則／最近一則',
       (select count(*) || ' 則・最近 ' || coalesce(to_char(max(created_at) at time zone 'Asia/Taipei', 'MM-DD HH24:MI'), '—')
          from public.notifications where kind = 'board')
union all
select 7, '⑦ pg_net 最近 8 次回應（狀態碼・內容開頭）',
       case when to_regclass('net._http_response') is null then '（沒有 net._http_response）'
            else (xpath('//s/text()', query_to_xml(
                   $q$select string_agg(to_char(created at time zone 'Asia/Taipei', 'MM-DD HH24:MI') || ' ' ||
                                        coalesce(status_code::text, 'ERR') || ' ' ||
                                        left(coalesce(error_msg, content, ''), 80), ' ｜ ' order by created desc) as s
                       from (select * from net._http_response order by created desc limit 8) r$q$,
                   false, true, '')))[1]::text end
union all
select 8, '⑧ 在職的人／把活動通知關掉的人',
       (select count(*) from public.profiles where active) || ' 人在職・關掉活動通知 '
         || coalesce((select count(*) from public.notification_prefs where board = false), 0) || ' 人'
order by 1;
