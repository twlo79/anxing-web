-- migration_74：會計科目新增「零用金」
--
-- 用途：小額（未滿 3,000）的現金支出。那個門檻剛好就是請款單的免核門檻，
-- 所以這類單送出即通過，不用等兩票。
--
-- 請款單與支出頁都是從 account_codes 動態載入下拉，
-- 所以這一列插進去，兩邊會同時出現，前端不用改。
--
-- 【排在「其他」前面】
-- 「其他」的 sort 是所有科目裡最大的，它應該永遠在最後一個 ——
-- 新科目插在它後面的話，下拉最底下會變成「其他、零用金」，
-- 看起來像零用金是「其他」的細項。
--
-- 【提醒：這是費用類別，不是付款方式】
-- 之後如果發現「零用金」的支出佔比很大而看不出錢實際花在哪，
-- 那就是這個科目被當成付款方式在用了。
-- 正確做法是科目填實際買的東西（辦公用品／備品消耗品／交際費…），
-- 「用零用金付的」寫在備註或另外開一個付款方式。
-- 現階段照你要的先加科目,之後真的變成問題再拆。

insert into public.account_codes (code, name, sort, active) values
  ('petty_cash', '零用金', (select sort from public.account_codes where code = 'other') - 5, true)
on conflict (code) do update
  set name = excluded.name, active = true;


-- ============================================================
-- 驗證
-- ============================================================
select code, name, sort, active
from public.account_codes
order by sort;
-- 預期：零用金 出現在倒數第二，最後一個仍是「其他」

-- 確認排序沒有跟別人撞在一起（撞的話下拉順序會不穩定）
select sort, count(*) as 同分數的科目數, string_agg(name, '、') as 科目
from public.account_codes
group by sort having count(*) > 1;
-- 預期：0 筆


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('74_petty_cash_code'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
