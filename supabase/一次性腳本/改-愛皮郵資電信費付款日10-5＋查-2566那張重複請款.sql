/* 2026-10-07 David：「1. 改 10/5　2. 2566 刪除 重複建單」
 *
 * 【① 這支會改】愛皮「郵資、115/9月電信費」那張（$128、現金）的付款日 2026-10-20 → 2026-10-05
 *   連帶把它產生的支出日期一起改成 10/05（支出日是跟著付款日產生的，不改的話兩邊對不上）。
 *   ★ 只有剛好一張符合才改；0 張或 2 張以上整支停下來。已關帳月份會被擋。
 *
 * 【② 這支只查、不刪】$2,566 那張（115/8月勞保費、115/7月健保費）
 *   它已經「產生支出」—— 請款單頁的「撤銷」會擋下來（支出是錢真的花掉的紀錄，連動刪除兩邊會對不上）。
 *   而且它付款帳戶是「安幸現金」、帳本是愛皮 → 很可能還長了一筆「安幸代墊」。
 *   先把它掛了哪些東西列出來，你確認真的是重複之後，下一支才刪（進回收桶）。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 */
create temp table if not exists _r (k text, v text) on commit preserve rows;

begin;
delete from _r;

do $$
declare v_id uuid; v_n int; k int;
begin
  select count(*), min(id::text)::uuid into v_n, v_id
    from public.purchase_requests
   where book = 'aipi' and round(total_amount) = 128 and purchased_on in ('2026-10-20', '2026-10-05')   -- 10-05 ＝ 跑過了，重跑不會停
     and exists (select 1 from public.purchase_request_items i where i.request_id = purchase_requests.id and i.item_name like '%郵資%');
  if v_n <> 1 then raise exception '愛皮 $128 郵資那張找到 % 張（要剛好 1 張）—— 整支停下來，什麼都沒改', v_n; end if;

  update public.purchase_requests set purchased_on = '2026-10-05' where id = v_id;
  get diagnostics k = row_count;
  insert into _r values ('請款單付款日', k || ' 張改成 2026-10-05');

  update public.expenses e set spent_on = '2026-10-05'
   where e.spent_on = '2026-10-20'
     and (e.request_id = v_id or e.source_item_id in (select i.id from public.purchase_request_items i where i.request_id = v_id));
  get diagnostics k = row_count;
  insert into _r values ('它產生的支出日期', k || ' 筆改成 2026-10-05');
end $$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '① 郵資電信費' as 檢查, string_agg(k || '：' || v, '；') as 結果, 'ℹ' as 判定 from _r
union all
select 2, '① 改完的樣子',
       (select r.req_no || '・付款日 ' || r.purchased_on || '・支出 '
               || coalesce((select string_agg(e.spent_on::text || ' $' || e.amount::int, '、') from public.expenses e
                             where e.request_id = r.id or e.source_item_id in (select i.id from public.purchase_request_items i where i.request_id = r.id)), '（沒有）')
          from public.purchase_requests r
         where r.book = 'aipi' and round(r.total_amount) = 128
           and exists (select 1 from public.purchase_request_items i where i.request_id = r.id and i.item_name like '%郵資%')
         limit 1),
       'ℹ'
union all
select 3, '② $2,566 那張（只查）',
       coalesce((select string_agg(r.req_no || '・送出 ' || r.submitted_at::date || '・付款日 ' || coalesce(r.purchased_on::text, '—')
                   || '・' || coalesce(r.payment_method, '—') || '/' || coalesce(r.payout_account, '—')
                   || '・項目：' || (select string_agg(i.item_name || ' $' || i.amount::int, '、') from public.purchase_request_items i where i.request_id = r.id), '｜')
                  from public.purchase_requests r where r.book = 'aipi' and round(r.total_amount) = 2566), '★ 找不到'),
       'ℹ'
union all
select 4, '② 它產生的支出',
       coalesce((select string_agg(e.spent_on || ' ' || e.item_name || ' $' || e.amount::int || '・帳本 ' || coalesce(e.book, '—'), '、')
                  from public.expenses e join public.purchase_requests r on r.book = 'aipi' and round(r.total_amount) = 2566
                 where e.request_id = r.id or e.source_item_id in (select i.id from public.purchase_request_items i where i.request_id = r.id)), '（沒有）'),
       'ℹ'
union all
select 5, '② 它長出來的安幸代墊',
       coalesce((select string_agg(a.id::text || '・$' || a.amount::int, '、') from public.advance_payments a
                  join public.purchase_requests r on r.book = 'aipi' and round(r.total_amount) = 2566
                 where a.request_id = r.id), '（沒有）'),
       'ℹ'
union all
select 6, '② 愛皮同名項目的其他請款單（看是不是真的重複）',
       coalesce((select string_agg(distinct r.req_no || ' ' || i.item_name || ' $' || i.amount::int || '（付款日 ' || coalesce(r.purchased_on::text, '—') || '）', '、')
                  from public.purchase_request_items i join public.purchase_requests r on r.id = i.request_id
                 where r.book = 'aipi' and round(r.total_amount) <> 2566
                   and (i.item_name like '%8月勞保%' or i.item_name like '%7月健保%')), '（沒有）'),
       'ℹ'
order by 1;
