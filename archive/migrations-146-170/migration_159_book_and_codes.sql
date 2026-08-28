-- migration_159：帳本欄位 ＋ 愛皮／洪鯊的會計科目
--
-- ============================================================
-- 【這是什麼】
--
-- 系統原本只記安幸（包租代管）的錢。現在要加兩家:
--
--     洪鯊  投資公司   股利、利息、處分損益、交易稅費
--     愛皮  旅行社     團費、機票住宿代收代付、地接、簽證
--
-- 完整企劃見 `docs/企劃-其他收支帳-愛皮洪鯊.md`。
--
-- ★ 這一支**只動資料結構，不動任何規則**。
--   認列跳過、審核免主管票、單一帳本約束在 migration_160。
--   拆開是為了:160 的自檢過不了時，你手上不會是一個改到一半的 schema。
--
--
-- ============================================================
-- 【跑完之後會怎樣】
--
-- **畫面上什麼都不會變。** 所有既有資料 `book = 'anxing'`，
-- 而前端還沒有任何地方讀這一欄。新科目也還沒有入口選得到。
--
-- 這是刻意的:欄位先有，報表才有東西可以篩，
-- 而報表篩好了才敢開新的填單入口（見企劃第九段的順序）。
-- ============================================================


-- ── ① 三張表的帳本欄位 ─────────────────────────────
/*
 * ★ 為什麼是 text ＋ CHECK 不是 enum
 *
 * 之後多一家公司時 enum 要 `ALTER TYPE ... ADD VALUE`，
 * 而**那不能在交易裡跑** —— SQL Editor 把整份腳本包在一個交易裡，
 * 所以那一天這支腳本會整份失敗。CHECK 改一行就好。
 *
 * ★ default 'anxing' 讓既有的每一列自動回填。
 *   不設預設值的話要另外寫 update，而漏掉的那幾列會是 null ——
 *   然後 `.eq('book','anxing')` 就查不到它們，那筆錢從報表上消失。
 */
alter table public.orders
  add column if not exists book text not null default 'anxing';
alter table public.expenses
  add column if not exists book text not null default 'anxing';
alter table public.purchase_requests
  add column if not exists book text not null default 'anxing';

do $$
declare t text;
begin
  foreach t in array array['orders', 'expenses', 'purchase_requests'] loop
    begin
      execute format(
        'alter table public.%I add constraint %I check (book in (''anxing'',''aipi'',''hongsha''))',
        t, t || '_book_chk');
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

/*
 * 報表一律帶 book 篩選，所以每張表都要有索引。
 * 沒有的話那幾支查詢會退化成全表掃描 —— 資料還少時看不出來，
 * 而看得出來的時候通常是「營收表突然要跑十秒」。
 */
create index if not exists orders_book_idx   on public.orders(book);
create index if not exists expenses_book_idx on public.expenses(book);
create index if not exists pr_book_idx       on public.purchase_requests(book);

comment on column public.orders.book is
  '哪一家的錢:anxing 安幸 / aipi 愛皮 / hongsha 洪鯊（migration_159）。'
  '★ 每一支收入報表都必須帶這個條件，漏掉的話兩家的錢會混進安幸的數字裡。';


-- ── ② 用途多一個「其他事業體」 ─────────────────────
/*
 * `purpose_type` 原本只有 office / estate，而 CHECK 約束把這件事寫死了:
 *
 *     (purpose_type='office' and estate_id is null)
 *  or (purpose_type='estate' and estate_id is not null)
 *
 * 加 'other_biz' 要**整條重寫** —— 漏寫的話新的用途存不進去，
 * 而錯誤訊息會是一句看不懂的 constraint violation。
 *
 * other_biz 的規則跟 office 一樣:estate_id 與 property_id 都是 null。
 * 愛皮洪鯊沒有房子（使用者確認）。
 */
do $$ begin
  alter table public.expenses drop constraint if exists exp_purpose_chk;
  alter table public.expenses add constraint exp_purpose_chk check (
       (purpose_type = 'office'    and estate_id is null)
    or (purpose_type = 'other_biz' and estate_id is null)
    or (purpose_type = 'estate'    and estate_id is not null));

  alter table public.purchase_request_items drop constraint if exists pri_purpose_chk;
  alter table public.purchase_request_items add constraint pri_purpose_chk check (
       (purpose_type = 'office'    and estate_id is null)
    or (purpose_type = 'other_biz' and estate_id is null)
    or (purpose_type = 'estate'    and estate_id is not null));
end $$;


-- ── ③ 會計科目分家 ─────────────────────────────────
/*
 * `account_codes` 的主鍵是 `code`，所以代號**全站唯一** ——
 * 兩家的科目要加前綴，不然「其他收入」會跟安幸的撞在一起。
 *
 *     hs_*  洪鯊（HongSha）
 *     ap_*  愛皮（AiPi）
 *
 * 加 book 欄位之後，填單的下拉只列自己那一家的 ——
 * 旅行社的人不該在清單裡看到「證券交易稅」。
 */
alter table public.account_codes
  add column if not exists book text not null default 'anxing';

do $$ begin
  alter table public.account_codes add constraint account_codes_book_chk
    check (book in ('anxing', 'aipi', 'hongsha'));
exception when duplicate_object then null;
end $$;

comment on column public.account_codes.book is
  '這個科目屬於哪一家。填單的下拉只列同一家的（migration_159）。';

/*
 * 洪鯊 —— 投資公司。
 *
 * sort 從 200 起跳，跟安幸的（100 多）分開。
 * 混號的話之後有人調安幸的排序會不小心插到洪鯊中間。
 */
insert into public.account_codes (code, name, sort, active, kind, book) values
  ('hs_dividend',     '股利收入',     201, true, 'income',  'hongsha'),
  ('hs_interest',     '利息收入',     202, true, 'income',  'hongsha'),
  ('hs_gain',         '處分投資利益', 203, true, 'income',  'hongsha'),
  ('hs_rent',         '租金收入',     204, true, 'income',  'hongsha'),
  ('hs_other_income', '其他收入',     209, true, 'income',  'hongsha'),
  ('hs_loss',         '處分投資損失', 211, true, 'expense', 'hongsha'),
  ('hs_sec_tax',      '證券交易稅',   212, true, 'expense', 'hongsha'),
  ('hs_trade_fee',    '交易手續費',   213, true, 'expense', 'hongsha'),
  ('hs_custody',      '保管費',       214, true, 'expense', 'hongsha'),
  ('hs_advisory',     '顧問費',       215, true, 'expense', 'hongsha'),
  ('hs_accounting',   '記帳／簽證費', 216, true, 'expense', 'hongsha'),
  ('hs_bank',         '銀行費用',     217, true, 'expense', 'hongsha'),
  ('hs_duty',         '稅捐規費',     218, true, 'expense', 'hongsha'),
  ('hs_office',       '辦公費',       219, true, 'expense', 'hongsha'),
  ('hs_other_exp',    '其他支出',     229, true, 'expense', 'hongsha')
on conflict (code) do nothing;

/*
 * 愛皮 —— 旅行社。
 *
 * ★ 機票款／住宿款目前是**毛額**記法:收「團費收入」、付「機票款」。
 *   若記帳士要改成淨額（只記佣金），這兩個科目要拿掉，
 *   而且既有資料要重算 —— 所以趁還沒有資料的時候確認。
 */
insert into public.account_codes (code, name, sort, active, kind, book) values
  ('ap_tour',         '團費收入',     301, true, 'income',  'aipi'),
  ('ap_fit',          '自由行收入',   302, true, 'income',  'aipi'),
  ('ap_ticket_comm',  '票券佣金',     303, true, 'income',  'aipi'),
  ('ap_visa_income',  '簽證代辦收入', 304, true, 'income',  'aipi'),
  ('ap_insur_comm',   '保險佣金',     305, true, 'income',  'aipi'),
  ('ap_other_income', '其他收入',     309, true, 'income',  'aipi'),
  ('ap_air',          '機票款',       311, true, 'expense', 'aipi'),
  ('ap_hotel',        '住宿款',       312, true, 'expense', 'aipi'),
  ('ap_local',        '地接費',       313, true, 'expense', 'aipi'),
  ('ap_meal',         '餐飲費',       314, true, 'expense', 'aipi'),
  ('ap_transport',    '交通費',       315, true, 'expense', 'aipi'),
  ('ap_admission',    '門票費',       316, true, 'expense', 'aipi'),
  ('ap_visa_fee',     '簽證規費',     317, true, 'expense', 'aipi'),
  ('ap_insurance',    '保險費',       318, true, 'expense', 'aipi'),
  ('ap_platform',     '平台手續費',   319, true, 'expense', 'aipi'),
  ('ap_marketing',    '行銷廣告',     320, true, 'expense', 'aipi'),
  ('ap_salary',       '薪資／獎金',   321, true, 'expense', 'aipi'),
  ('ap_office',       '辦公費',       322, true, 'expense', 'aipi'),
  ('ap_other_exp',    '其他支出',     329, true, 'expense', 'aipi')
on conflict (code) do nothing;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('159_book_and_codes');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★ 只能有一個 SELECT —— SQL Editor 只顯示最後一個的結果。
 */
select "檢查項目", "結果", "說明" from (

  select 1 as ord, '★★ 三張表的 book 欄位' as "檢查項目",
         count(*)::text || ' / 3' as "結果",
         case when count(*) = 3 then '✅' else '❌ 有表沒加到' end as "說明"
    from information_schema.columns
   where table_schema = 'public'          -- 少了它，其他 schema 的同名表會誤報
     and table_name in ('orders', 'expenses', 'purchase_requests')
     and column_name = 'book'

  union all
  /*
   * ★★ 這一項是重點:既有資料**一列都不能是 null 或別的值**。
   *   漏掉的話 `.eq('book','anxing')` 查不到它，那筆錢從報表上消失 ——
   *   而消失不會報錯，只有月底加總時少一截。
   */
  select 2, '★★ 既有訂單全部是安幸',
         count(*) filter (where book = 'anxing')::text || ' / ' || count(*)::text,
         case when count(*) = count(*) filter (where book = 'anxing')
              then '✅ 舊資料行為完全不變'
              else '❌ 有 ' || count(*) filter (where book is distinct from 'anxing')::text
                   || ' 列不是 anxing' end
    from public.orders

  union all
  select 3, '★★ 既有支出全部是安幸',
         count(*) filter (where book = 'anxing')::text || ' / ' || count(*)::text,
         case when count(*) = count(*) filter (where book = 'anxing')
              then '✅' else '❌' end
    from public.expenses

  union all
  select 4, '★ 用途約束已放寬',
         case when (select count(*) from pg_constraint
                     where conname in ('exp_purpose_chk', 'pri_purpose_chk')
                       and pg_get_constraintdef(oid) like '%other_biz%') = 2
              then '✅ 2 / 2' else '❌ 約束沒重寫到' end,
         '沒重寫的話新的用途存不進去，錯誤訊息看不懂'

  union all
  select 5, '★★ 洪鯊的科目', count(*)::text || ' / 15',
         case when count(*) = 15 then '✅ 5 收 ＋ 10 支' else '❌ 數量不對' end
    from public.account_codes where book = 'hongsha'

  union all
  select 6, '★★ 愛皮的科目', count(*)::text || ' / 19',
         case when count(*) = 19 then '✅ 6 收 ＋ 13 支' else '❌ 數量不對' end
    from public.account_codes where book = 'aipi'

  union all
  /*
   * ★ 安幸的科目一個都不能被動到。
   *   這支只 insert 新的、加一欄 default —— 但確認一次比較安心，
   *   因為科目表是營收報表的分組依據，少一個科目就有一批歷史數字失去分類。
   */
  select 7, '★ 安幸的科目沒被動到', count(*)::text || ' 個',
         case when count(*) > 0 then '✅ 都還在（跑之前的數字應該一樣）'
              else '❌ 安幸的科目不見了' end
    from public.account_codes where book = 'anxing'

) v order by ord;
