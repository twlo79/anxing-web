/* ══════════════════════════════════════════════════════════════════════
 * 房務主檔還沒對應到 ERP 房源的：同名的自動接上，接不上的列出來                 2026-09-30
 *
 * 【為什麼】房務設定頁上 19B2、台2、正隆2樓 顯示「— 還沒對應 —」。
 *   沒對應的房源算不出打掃點數與清潔費（排班統計會標「⚠ 未計」）。
 *
 * 【做什麼】
 *   · hk_property 裡 property_id 是空的、而 ERP properties 裡**剛好只有一筆**同名（或別名相同）
 *     且在職的 → 接上。兩筆以上或一筆都沒有 → 不猜，列在自檢第 2 列。
 *   · 正隆2樓／開封公區要先跑「加-ERP公區房源」那支（那支會建 ERP 房源），這支才接得到。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

create temp table _linked (code text, pname text);

with cand as (
  select h.id as hid, h.code,
         (select min(p.id::text)::uuid from public.properties p
           where p.active and (p.name = h.code or h.code = any(coalesce(p.name_aliases, '{}')) or p.name = any(h.aliases))
          having count(*) = 1) as pid
    from public.hk_property h
   where h.active and h.property_id is null
),
upd as (
  update public.hk_property h set property_id = c.pid
    from cand c
   where h.id = c.hid and c.pid is not null
     and not exists (select 1 from public.hk_property x where x.property_id = c.pid)   -- 那筆 ERP 房源沒被別人接走
  returning h.code, (select name from public.properties where id = c.pid) as pname
)
insert into _linked select * from upd;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了） ═══════════
select 1 as 序, '這次接上的' as 檢查,
       coalesce((select string_agg(code || '→' || pname, '、') from _linked), '沒有') as 結果,
       case when exists (select 1 from _linked) then '✅' else 'ℹ 沒有同名可接的' end as 判定
union all
select 2, '還是沒對應的（在職）',
       coalesce((select string_agg(h.code || '（ERP 同名 ' || (select count(*) from public.properties p where p.active and p.name = h.code) || ' 筆）', '、' order by h.sort)
                   from public.hk_property h where h.active and h.property_id is null), '沒有'),
       case when exists (select 1 from public.hk_property where active and property_id is null)
            then '⚠ 0 筆＝ERP 沒這個房源（到房源設定加，或這一列停用）；2 筆以上＝要人選' else '✅' end
order by 1;
