/*
 * ══════════════════════════════════════════════════════════
 * 一次性：刪掉重複建單 PR-202610-015（愛皮 $2,566，2026-10-07 David）
 *
 *   這張的兩個項目都已經付過了：
 *     115/7月健保費 $1,428 → PR-202608-075（9/9 付）
 *     115/8月勞保費 $1,138 → PR-202610-026（10/5 付）
 *
 *   這支會把它整組搬進回收桶（可以從回收桶復原）：
 *     請款單 → 2 個項目 → 2 筆代墊 → 2 筆支出 → 附件（有的話）
 *   然後刪掉。
 *
 * ★ 只認這一張：單號 PR-202610-015、愛皮、合計 2,566，
 *   而且要剛好 2 筆支出 2 筆代墊、各自合計 2,566。不符就整支停下來，什麼都不動。
 * ★ 代墊已經有還款紀錄的話也會停（還款明細不能指向一筆不存在的代墊）。
 * ★ 第二次跑：找不到那張單 → 只印「已經刪過了」，不動任何東西。
 * ══════════════════════════════════════════════════════════
 */

begin;

do $do$
declare
  r      public.purchase_requests%rowtype;
  v_item uuid[];
  v_exp  uuid[];
  v_ap   uuid[];
  n_exp  int; s_exp numeric;
  n_ap   int; s_ap  numeric;
  kids   jsonb := '[]'::jsonb;
  rows_  jsonb;
  n_kids int := 0;
begin
  select * into r from public.purchase_requests where req_no = 'PR-202610-015';
  if not found then
    raise notice '找不到 PR-202610-015 —— 已經刪過了，這次什麼都沒動';
    return;
  end if;
  if (select count(*) from public.purchase_requests where req_no = 'PR-202610-015') <> 1 then
    raise exception '單號 PR-202610-015 不只一張，停下來不動';
  end if;
  if r.book is distinct from 'aipi' or round(r.total_amount) <> 2566 then
    raise exception '這張不是愛皮 $2,566（book=%, 合計=%），停下來不動', r.book, r.total_amount;
  end if;

  select coalesce(array_agg(id), '{}') into v_item
    from public.purchase_request_items where request_id = r.id;

  select coalesce(array_agg(id), '{}'), count(*), coalesce(sum(amount), 0) into v_exp, n_exp, s_exp
    from public.expenses where request_id = r.id or source_item_id = any(v_item);

  select coalesce(array_agg(id), '{}'), count(*), coalesce(sum(amount), 0) into v_ap, n_ap, s_ap
    from public.advance_payments where request_id = r.id or source_item_id = any(v_item);

  if n_exp <> 2 or round(s_exp) <> 2566 then
    raise exception '支出不是 2 筆合計 2,566（%筆 / %），停下來不動', n_exp, s_exp;
  end if;
  if n_ap <> 2 or round(s_ap) <> 2566 then
    raise exception '代墊不是 2 筆合計 2,566（%筆 / %），停下來不動', n_ap, s_ap;
  end if;
  if exists (select 1 from public.advance_repayment_lines where advance_id = any(v_ap)) then
    raise exception '這兩筆代墊已經有還款紀錄，要先處理還款，停下來不動';
  end if;

  -- ── 收進回收桶：子列的順序就是復原時插回去的順序（先父後子）──
  for rows_ in
    select x from (values
      (1, 'purchase_request_items', (select jsonb_agg(to_jsonb(t)) from public.purchase_request_items t where t.id = any(v_item))),
      (2, 'advance_payments',       (select jsonb_agg(to_jsonb(t)) from public.advance_payments t       where t.id = any(v_ap))),
      (3, 'expenses',               (select jsonb_agg(to_jsonb(t)) from public.expenses t               where t.id = any(v_exp))),
      (4, 'attachments',            (select jsonb_agg(to_jsonb(t)) from public.attachments t
                                       where t.request_id = r.id or t.expense_id = any(v_exp))),
      (5, 'other_book_payments',    (select jsonb_agg(to_jsonb(t)) from public.other_book_payments t    where t.expense_id = any(v_exp))),
      (6, 'noncash_batch_items',    (select jsonb_agg(to_jsonb(t)) from public.noncash_batch_items t    where t.expense_id = any(v_exp)))
    ) v(ord, tbl, x0)
    cross join lateral (select jsonb_build_object('table', v.tbl, 'rows', v.x0) as x) z
    where v.x0 is not null
    order by v.ord
  loop
    kids   := kids || jsonb_build_array(rows_);
    n_kids := n_kids + jsonb_array_length(rows_->'rows');
  end loop;

  insert into public.trash (table_name, record_id, label, payload, children, child_count, reason, deleted_by)
  values ('purchase_requests', r.id,
          'PR-202610-015 愛皮 115/8月勞保費、115/7月健保費 $2,566',
          to_jsonb(r), kids, n_kids,
          '重複建單（2026-10-07 David）：7月健保已在 PR-202608-075、8月勞保已在 PR-202610-026',
          null);

  -- ── 刪：支出 → 代墊 → 請款單（項目與附件跟著 cascade）──
  delete from public.expenses         where id = any(v_exp);
  delete from public.advance_payments where id = any(v_ap);
  delete from public.purchase_requests where id = r.id;

  raise notice 'PR-202610-015 已搬進回收桶並刪除：支出 % 筆、代墊 % 筆、子列共 % 列', n_exp, n_ap, n_kids;
end
$do$;

commit;

-- ══════ 自檢（看不到那張表就是整支回滾了）══════
select '① PR-202610-015 還在嗎' as 檢查,
       (select count(*) from public.purchase_requests where req_no = 'PR-202610-015')::text as 結果,
       '要 0' as 應該
union all
select '② 那兩筆代墊還在嗎',
       (select count(*) from public.advance_payments
         where id in ('0feebe73-69e8-4a2b-a781-11d7c5da7a4a', '68853e4b-9b81-4163-bba2-c50cc667c500'))::text,
       '要 0'
union all
select '③ 回收桶裡有它嗎',
       coalesce((select '有（子列 ' || child_count || ' 列）' from public.trash
                  where table_name = 'purchase_requests' and label like 'PR-202610-015%' and restored_at is null
                  order by deleted_at desc limit 1), '沒有'),
       '有'
union all
select '④ PR-202608-075（7月健保）還在',
       (select count(*) from public.purchase_requests where req_no = 'PR-202608-075')::text, '要 1'
union all
select '⑤ PR-202610-026（8月勞保）還在',
       (select count(*) from public.purchase_requests where req_no = 'PR-202610-026')::text, '要 1';
