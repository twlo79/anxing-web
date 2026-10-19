/* ══════════════════════════════════════════════════════════════════════
 * 去重第一批：確定重複的 5 張進回收桶（可復原）＋ 列出還要你判斷的 6 組                    2026-10-19
 *
 * 【這次刪哪 5 張】（都是 7/21 Excel 匯入的那一份；留下的是同步進來、有 Airbnb 確認碼的正本）
 *   804 亞曼尼 5 月四組 —— Excel 那張刪、HM 確認碼那張留：
 *     AB_2026-05-30_亞曼尼_69a01f  ↔ 留 HMPENMJXQZ
 *     AB_2026-05-27_亞曼尼_4db2c7  ↔ 留 HM2XE5EDXC   （Excel 寫 6,260、同步寫 7,760 —— 以同步為準）
 *     AB_2026-05-23_亞曼尼_04dc94  ↔ 留 HMWR2CKETC   （Excel 4,707、同步 5,707）
 *     AB_2026-05-15_亞曼尼_c2fc2c  ↔ 留 HM39M4JQ93   （Excel 3,850、同步 4,850）
 *   BjöRn 2024/12/31 —— 沒有房源（NA）那張刪、M房那張留：
 *     AB_2024-12-31_NA_1e0adb      ↔ 留 AB_2024-12-31_M房_493f93
 *
 * 【不刪】14B1／14B3 陳月明：兩間都收了錢、各有押金 —— 是同一個人租兩間，不是重複。
 *
 * 【怎麼刪】走 soft_delete()，跟畫面上按「刪除」一模一樣：進回收桶、可以復原、營收認列跟著拿掉。
 *   ★ 每一張刪之前都確認：單號在、客人／房源對得上、要留的那張也在、兩張都沒有收款與押金。不符就跳過那一張，在自檢表講原因。
 *   ★ 那個月已經關帳的話，刪除會被擋 —— 那一張會跳過、在自檢表寫「關帳擋住」，其他的照刪。到時候先開鎖再跑一次。
 *   ★ 跑第二次：已經刪過的會顯示「已不在」，不會重複動。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

create temp table if not exists _dedup1 (k text primary key, v text) on commit preserve rows;
truncate _dedup1;

do $do$
declare
  t record; d public.orders; k public.orders; res jsonb; msg text;
begin
  for t in select * from (values
      ('AB_2026-05-30_亞曼尼_69a01f', 'HMPENMJXQZ',               'ho yin'),
      ('AB_2026-05-27_亞曼尼_4db2c7', 'HM2XE5EDXC',               '재일'),
      ('AB_2026-05-23_亞曼尼_04dc94', 'HMWR2CKETC',               'youngpill'),
      ('AB_2026-05-15_亞曼尼_c2fc2c', 'HM39M4JQ93',               '재우'),
      ('AB_2024-12-31_NA_1e0adb',     'AB_2024-12-31_M房_493f93', 'bj')
    ) as v(del_key, keep_key, name_head)
  loop
    select * into d from public.orders where order_key = t.del_key;
    if not found then insert into _dedup1 values (t.del_key, '已不在（刪過了）'); continue; end if;
    select * into k from public.orders where order_key = t.keep_key;
    if not found then insert into _dedup1 values (t.del_key, '⚠ 跳過：要留的 ' || t.keep_key || ' 不在'); continue; end if;
    if lower(coalesce(d.guest_name, '')) not like t.name_head || '%' or lower(coalesce(k.guest_name, '')) not like t.name_head || '%' then
      insert into _dedup1 values (t.del_key, '⚠ 跳過：客人名字對不上（' || coalesce(d.guest_name, '?') || ' ／ ' || coalesce(k.guest_name, '?') || '）'); continue;
    end if;
    if d.checkin <> k.checkin then
      insert into _dedup1 values (t.del_key, '⚠ 跳過：入住日不一樣（' || d.checkin || ' ／ ' || k.checkin || '）'); continue;
    end if;
    if coalesce(d.paid_amount, 0) <> 0 or exists (select 1 from public.order_payments where order_id = d.id)
       or exists (select 1 from public.deposits where order_id = d.id) then
      insert into _dedup1 values (t.del_key, '⚠ 跳過：要刪的這張有收款或押金'); continue;
    end if;

    begin
      res := public.soft_delete('orders', d.id, '重複訂單（Excel 匯入那份），正本是 ' || t.keep_key || '；2026-10-19 去重');
      if coalesce((res->>'ok')::boolean, false) then
        insert into _dedup1 values (t.del_key, '✅ 進回收桶（留 ' || t.keep_key || '・$' || to_char(k.amount, 'FM999,999,990') || '）');
      else
        insert into _dedup1 values (t.del_key, '⚠ 沒刪：' || coalesce(res->>'message', '?'));
      end if;
    exception when others then
      get stacked diagnostics msg = message_text;
      insert into _dedup1 values (t.del_key, '⚠ 沒刪（' || case when msg ~ '關帳|lock' then '關帳擋住' else '錯誤' end || '）：' || msg);
    end;
  end loop;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
-- 上半：這次刪的 5 張；下半：還要你判斷的 6 組，每一張的確切起訖與金額
select 1 as 序, '這次刪' as 段, k as 單號, v as 結果
  from _dedup1
union all
select 2, '要你判斷：' || g.grp,
       o.order_key,
       coalesce(p.name, o.property_raw, '?') || '・' || coalesce(o.guest_name, '?') || '・' || o.checkin || ' ～ ' || o.checkout
         || '（' || (o.checkout - o.checkin) || ' 晚）・$' || to_char(o.amount, 'FM999,999,990')
         || '・' || coalesce(o.source, '?') || coalesce('・' || nullif(trim(o.note), ''), '')
  from (values
      ('⑤ A01 Andrew', 'AB_2025-11-06_A1_c2a5aa'), ('⑤ A01 Andrew', 'AB_2025-11-07_A1_cabce3'),
      ('⑥ A15 Mel',    'AB_2025-08-30_A15_99eec9'), ('⑥ A15 Mel', 'AB_2025-08-30_A15_1ad19a'),
      ('⑦ B03 Ankur',  'PV_2025-03-31_B3_cb71d0'), ('⑦ B03 Ankur', 'AB_2025-03-31_B3_c377c5'),
      ('⑧⑨ A07 Pss',   'PV_2024-10-04_A7_c88c04'), ('⑧⑨ A07 Pss', 'PV_2024-12-03_A7_b880e6'), ('⑧⑨ A07 Pss', 'PV_2025-01-03_A7_1bfdc7'),
      ('⑩ A06 Linda',  'PV_2024-09-15_A6_e662ae'), ('⑩ A06 Linda', 'PV_2024-12-15_A6_d12dc5')
    ) as g(grp, key)
  join public.orders o on o.order_key = g.key
  left join public.properties p on p.id = o.property_id
order by 1, 2, 3;
