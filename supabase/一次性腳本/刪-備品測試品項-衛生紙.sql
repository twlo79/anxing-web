/* ══════════════════════════════════════════════════════════════════════
 * 刪掉 2026-09-23 驗收 migration_293（備品盤點 RPC）時建的測試品項
 *
 * 【要刪什麼】正隆 的「衛生紙 / 大包裝」一個品項，連同它的：
 *   · supply_txn   初始 1、補貨 +3、盤點調整 −4
 *   · supply_count 那一筆月底盤點
 *   兩張子表的外鍵都是 `on delete cascade`，所以**只要刪品項，它們自己會跟著走**。
 *
 * 【★★★ 為什麼要用 SQL 而不是在畫面上刪】
 *   備品那一頁**沒有刪除也沒有停用的按鈕** —— 只能新增。
 *   `supply_item` 有 `active` 欄位，但畫面上沒有任何地方把它設成 false。
 *   （之後要不要補一顆「停用」再說，那是 UI 改動要先過審。）
 *
 * 【★★ 守衛：不是剛好 1 筆就整支停下來】
 *   條件寫死三個欄位（物業=正隆、名稱=衛生紙、規格=大包裝），不用 `like`，
 *   避免掃到以後真的進貨的衛生紙。撈到 0 筆或 2 筆就 `raise exception`，
 *   SQL Editor 把整份腳本包在一個交易裡 —— 什麼都不會被刪掉。
 *
 * 【★★★ 自檢問的是「這一次刪了什麼」，不是「現在還有沒有」】
 *   第一版寫成「還找得到衛生紙嗎」—— 守衛擋下來（一筆都沒刪）時
 *   那個問題的答案**同樣是「找不到」**，於是整張表回綠，看起來像做完了。
 *   現在自檢讀的是刪除當下寫進暫存表的筆數：沒刪成功的話，
 *   那張暫存表根本不存在，最後一段會直接報錯 —— **綠表格不可能憑空出現**。
 * ══════════════════════════════════════════════════════════ */

begin;

-- 這一次實際刪了什麼，記在這裡給下面的自檢讀。
-- 交易回滾的話它不會存在 → 自檢那段會報 "relation _del_result does not exist"，
-- 那就是「什麼都沒刪」最清楚的訊號。
create temp table _del_result (item_id uuid, n_txn int, n_adj int, n_cnt int, n_item int);

do $$
declare
  n     int;
  v_id  uuid;
  n_txn int;
  n_adj int;
  n_cnt int;
  n_del int;
begin
  -- ★ 先數，再取 id。不要用 `min(i.id)` —— uuid 沒有 min()，
  --   那樣寫會在守衛跑到之前就爆掉（本機試跑抓到的）。
  select count(*)
    into n
    from public.supply_item i
    join public.estates e on e.id = i.estate_id
   where e.name = '正隆'
     and i.name = '衛生紙'
     and coalesce(i.spec, '') = '大包裝';

  if n <> 1 then
    raise exception '預期剛好 1 筆測試品項（正隆/衛生紙/大包裝），實際 % 筆 —— 整支停下來，一列都沒刪', n;
  end if;

  select i.id
    into v_id
    from public.supply_item i
    join public.estates e on e.id = i.estate_id
   where e.name = '正隆'
     and i.name = '衛生紙'
     and coalesce(i.spec, '') = '大包裝';

  select count(*) into n_txn from public.supply_txn   where item_id = v_id;
  -- 盤點產生的調整流水單獨數一次 —— 那一筆才是這次驗收真正要確認有進去的東西
  select count(*) into n_adj from public.supply_txn   where item_id = v_id and kind = 'adjust';
  select count(*) into n_cnt from public.supply_count where item_id = v_id;

  delete from public.supply_item where id = v_id;
  get diagnostics n_del = row_count;
  if n_del <> 1 then
    raise exception '刪除影響 % 列（預期 1）—— 整支退回', n_del;
  end if;

  insert into _del_result values (v_id, n_txn, n_adj, n_cnt, n_del);
end $$;

commit;

-- ═══ 自檢 ═══════════════════════════════════════════════════════════
-- 看不到這張表 ＝ 整支回滾了，**一列都沒刪**（訊息會說是撈到幾筆）。
select 1 as "序", '這一次刪掉的品項數（要 1）' as "檢查",
       (select n_item::text from _del_result) as "結果",
       case when (select n_item from _del_result) = 1 then '✅' else '❌' end as "判定"
union all
-- ★ 不寫死筆數 —— 寫死的話「取用按了幾次」不一樣就會誤報。
--   真正要確認的是「盤點那筆調整流水確實存在過」，那是 migration_293 的驗收點。
select 2, '跟著 cascade 掉的流水筆數（其中盤點調整 ' ||
          (select n_adj::text from _del_result) || ' 筆）',
       (select n_txn::text from _del_result),
       case when (select n_adj from _del_result) >= 1 then '✅ 盤點調整那筆確實有寫進去過（293 驗收點）'
            when (select n_txn from _del_result) = 0 then '⚠ 一筆流水都沒有，確認是不是刪錯品項'
            else '⚠ 沒有盤點調整流水 —— 盤點那一步可能沒成功' end
union all
select 3, '跟著 cascade 掉的盤點筆數',
       (select n_cnt::text from _del_result),
       case when (select n_cnt from _del_result) = 1 then '✅ 那筆月底盤點也走了'
            else '⚠ 跟預期的 1 筆不同' end
union all
select 4, '那個品項現在還在不在（要 0）',
       (select count(*)::text from public.supply_item i
         where i.id = (select item_id from _del_result)),
       case when (select count(*) from public.supply_item i
                   where i.id = (select item_id from _del_result)) = 0 then '✅' else '❌ 還在' end
union all
select 5, '沒有孤兒流水／盤點（指向不存在的品項，要 0）',
       ((select count(*) from public.supply_txn t
          where not exists (select 1 from public.supply_item i where i.id = t.item_id))
        + (select count(*) from public.supply_count c
          where not exists (select 1 from public.supply_item i where i.id = c.item_id)))::text,
       case when ((select count(*) from public.supply_txn t
                    where not exists (select 1 from public.supply_item i where i.id = t.item_id))
                + (select count(*) from public.supply_count c
                    where not exists (select 1 from public.supply_item i where i.id = c.item_id))) = 0
            then '✅ cascade 乾淨' else '❌ 有殘留' end
union all
-- ★ 母體要判定，不能只當參考
select 6, '母體：全站還剩幾個備品品項',
       (select count(*)::text from public.supply_item),
       case when (select count(*) from public.supply_item) = 0
            then '⚠ 一個都不剩 —— 本來就只有這一個測試品項的話是對的，否則停下來看'
            else '✅ 其他品項沒被動到' end
order by 1;
