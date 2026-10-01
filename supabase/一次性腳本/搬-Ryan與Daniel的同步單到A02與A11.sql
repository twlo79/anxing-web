/* ══════════════════════════════════════════════════════════════════════
 * 同步進來的 Ryan／Daniel 那兩張搬到對的房源（A02、A11）                                       2026-10-01
 *
 * ★ 兩張重複的補登**先在畫面上刪**（短租訂單頁 → 那筆 → 底下紅字「刪除」→ 進回收桶）。
 *   SQL Editor 這條線沒有回收桶的權限（soft_delete 回「你的帳號沒有刪除訂單的權限」），
 *   畫面上刪才會進回收桶、才可以復原 —— 這支不硬刪。自檢第 1 列會確認你刪了沒。
 *
 * 【為什麼】查出來「Airbnb 沒抓到」其實都抓到了，只是建錯房；今天補的兩張變成重複：
 *   Ryan   11/9～12/8   HMZ3ASNTSF 建在 A06  ↔  PV_2026-11-09_A02_airbnb-missed_manual（補登，A02）
 *   Daniel 10/17～11/16 HMA9M95B95 建在 B05  ↔  PV_2026-10-17_A11_airbnb-missed_manual（補登，A11）
 *   David：Ryan 是 A02、Daniel 是 A11（Airbnb 後台看的）。
 *
 * 【做什麼】HMZ3ASNTSF → A02、HMA9M95B95 → A11：只改房源與物業三欄，金額、日期、確認碼都不動；
 *   營收認列由觸發器跟著重算。房源已經對了就不動，跑第二次沒事。
 *
 * ★ 之後對帳頁會每天標這兩筆「房源跟對照不一樣」（對照表裡 8335 → A13、9489 → B05 舊編號），
 *   那正是提醒你去確認那兩個編號到底是哪間房 —— 確認完改對照，那一列就消失。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

do $$
declare
  r record; v_pid uuid; v_eid uuid;
begin
  -- 同步那兩張搬到對的房源
  for r in select * from (values ('HMZ3ASNTSF', 'A02'), ('HMA9M95B95', 'A11')) as t(code, room) loop
    select id, estate_id into v_pid, v_eid from public.properties where name = r.room and active;
    if v_pid is null then raise exception '找不到在職房源「%」—— 整支停下來', r.room; end if;
    update public.orders
       set property_id = v_pid, estate_id = v_eid, property_raw = r.room
     where order_key = r.code and property_id is distinct from v_pid;
  end loop;
end $$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了） ═══════════
select 1 as 序, '兩張補登在畫面上刪掉了嗎（要 0；還在就先去刪）' as 檢查,
       (select count(*)::text from public.orders
         where order_key in ('PV_2026-11-09_A02_airbnb-missed_manual', 'PV_2026-10-17_A11_airbnb-missed_manual')) as 結果,
       case when (select count(*) from public.orders
                   where order_key in ('PV_2026-11-09_A02_airbnb-missed_manual', 'PV_2026-10-17_A11_airbnb-missed_manual')) = 0
            then '✅' else '❌ 還在 —— 到短租訂單頁刪，進回收桶' end as 判定
union all
select 2, 'HMZ3ASNTSF（Ryan）建在',
       (select coalesce(p.name, '?') || '・' || o.checkin || '～' || o.checkout || '・$' || o.amount from public.orders o left join public.properties p on p.id = o.property_id where o.order_key = 'HMZ3ASNTSF'),
       case when (select p.name from public.orders o join public.properties p on p.id = o.property_id where o.order_key = 'HMZ3ASNTSF') = 'A02' then '✅' else '❌' end
union all
select 3, 'HMA9M95B95（Daniel）建在',
       (select coalesce(p.name, '?') || '・' || o.checkin || '～' || o.checkout || '・$' || o.amount from public.orders o left join public.properties p on p.id = o.property_id where o.order_key = 'HMA9M95B95'),
       case when (select p.name from public.orders o join public.properties p on p.id = o.property_id where o.order_key = 'HMA9M95B95') = 'A11' then '✅' else '❌' end
union all
select 4, '這兩段期間 A02／A11 各只有一張 Airbnb 單',
       (select string_agg(p.name || ' ' || count, '；') from (
          select p.name, count(*)::text as count from public.orders o join public.properties p on p.id = o.property_id
           where o.source = 'airbnb' and ((p.name = 'A02' and o.checkin = date '2026-11-09') or (p.name = 'A11' and o.checkin = date '2026-10-17'))
           group by p.name) x join public.properties p on p.name = x.name),
       case when (select count(*) from public.orders o join public.properties p on p.id = o.property_id
                   where o.source = 'airbnb' and ((p.name = 'A02' and o.checkin = date '2026-11-09') or (p.name = 'A11' and o.checkin = date '2026-10-17'))) = 2
            then '✅' else '❌' end
order by 1;
