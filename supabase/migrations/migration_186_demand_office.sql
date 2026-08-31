/*
 * migration_186 —— 採購需求單的「用途」可以選安幸辦公室
 * ============================================================
 * 2026-08-31 使用者：「採購需求單 用途也要 安幸辦公室」
 *
 * 【現況：需求單是唯一沒有這個選項的地方】
 *
 *   支出（expenses）        ✅ purpose_type = 'office'
 *   請款單（purchase_request_items） ✅ 同上
 *   採購需求單（purchase_demand_items） ❌ 只能選物業 ← 這一支修的
 *
 * ★ 而需求單是這條鏈的**第一站**（需求 → 請款 → 支出）。
 *   第一站選不到辦公室，就得先亂填一個物業再到下一站改回來 ——
 *   而那個亂填的值會留在需求單上，永遠對不回去。
 *
 * ============================================================
 * 【★★★ estate_id 是 not null，這是唯一的難處】
 *
 * migration_140:
 *     estate_id uuid not null references public.estates(id)
 *
 * 「安幸辦公室」**不是物業** —— 它不在 estates 裡，也不該在
 * （放進去的話全站每一張物業清單、每一份物業分項報表都會多它一列）。
 *
 * 所以要三件事一起做:
 *   ① 加 purpose_type（跟 expenses 用同一組值:'estate' / 'office'）
 *   ② estate_id 放寬成可為空
 *   ③ 加互斥約束 —— 不然「office 但有 estate_id」這種矛盾的列會進得去
 *
 * ★★ 第三件最容易漏。少了它的話，畫面上選了辦公室、estate_id 卻留著
 *   上一次選的物業 —— 而報表是照 estate_id 分組的，
 *   那一筆會**同時被算成辦公室與那個物業**，兩邊都對不上。
 *
 * ============================================================
 * 【為什麼不沿用 ship_to 那招】
 *
 * 同一張表的「寄送地點」用的是純文字（`SHIP_EXTRA = ['安幸辦公室','其他']`，
 * migration_141）。那裡可以，因為寄送地點**不進任何報表** ——
 * 它只是給送貨的人看的一行字。
 *
 * 用途不一樣:它會一路傳到請款單與支出，而那兩邊是照
 * `purpose_type` 分組出報表的。存文字的話，
 * 「安幸辦公室」與「安幸辦公室 」（多一個空格）會變成兩個不同的分類 ——
 * 而畫面上長得一模一樣。
 */

-- ① 用途類別
/*
 * ★ `not null default 'estate'`:既有的每一列都是選物業選出來的。
 *   允許 null 的話「舊資料」與「還沒選」會長得一樣，
 *   而下面那個約束碰到 null 會回 null（不是 false）—— 檢查悄悄失效。
 */
alter table public.purchase_demand_items
  add column if not exists purpose_type text not null default 'estate';

do $$
begin
  alter table public.purchase_demand_items
    add constraint pdi_purpose_type_chk check (purpose_type in ('estate', 'office'));
exception when duplicate_object then null;   -- 重跑安全
end $$;

comment on column public.purchase_demand_items.purpose_type is
  'estate=這一項是為了某個物業買的／office=安幸辦公室自用（migration_186）。'
  '跟 expenses.purpose_type、purchase_request_items.purpose_type 同一組值。';

-- ② estate_id 放寬
/*
 * ★★ 順序:先放寬 not null，**再**加互斥約束。
 *   反過來的話，加約束的那一刻 office 的列還不能存在（estate_id 仍是 not null），
 *   而那沒有壞處但也沒有意義 —— 照正確的順序不用付任何代價。
 */
alter table public.purchase_demand_items alter column estate_id drop not null;

-- ③ 互斥約束
do $$
begin
  alter table public.purchase_demand_items
    add constraint pdi_purpose_one_of check (
      (purpose_type = 'office' and estate_id is null)
      or
      (purpose_type = 'estate' and estate_id is not null)
    );
exception when duplicate_object then null;
end $$;

comment on constraint pdi_purpose_one_of on public.purchase_demand_items is
  '辦公室不能帶物業、物業不能沒有物業。少了這條的話「選了辦公室但 estate_id '
  '還留著上一次的物業」會進得去，而報表會把那一筆同時算進兩邊。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('186_demand_office');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢。★ `raise notice` 在 SQL Editor 看不到，所以回一張表。
-- ★ 排序欄位留在子查詢裡（`v.ord`）—— `order by 1` 會照文字排（migration_181 踩過）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ purpose_type 建好了',
         coalesce((select data_type || ' / ' || is_nullable || ' / ' || coalesce(column_default, '(無預設)')
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'purchase_demand_items'
                      and column_name = 'purpose_type'), '⚠ 沒有這個欄位'),
         '要看到 text / NO / ''estate''::text —— 允許 null 的話下面那個約束會悄悄失效'

  union all
  select 2, '★★ estate_id 已經可以是空的',
         coalesce((select case when is_nullable = 'YES' then '✅ 可為空' else '⚠ 還是 NOT NULL，辦公室存不進去' end
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'purchase_demand_items'
                      and column_name = 'estate_id'), '⚠ 查不到'),
         '安幸辦公室不是物業，它的 estate_id 一定是 null'

  union all
  select 3, '★★★ 互斥約束在',
         coalesce((select pg_get_constraintdef(oid) from pg_constraint
                    where conrelid = 'public.purchase_demand_items'::regclass
                      and conname = 'pdi_purpose_one_of'), '⚠ 沒建起來'),
         '辦公室不能帶物業、物業不能沒有物業 —— 少了它報表會重複計算'

  union all
  /*
   * ★ 這支只加欄位與約束，**既有的需求項目一列都不該動**。
   *   而且既有的全部應該是 estate（default 給的）。
   */
  select 4, '★★ 既有需求項目沒動',
         (select count(*)::text || ' 項（'
                 || count(*) filter (where purpose_type = 'estate')::text || ' 物業／'
                 || count(*) filter (where purpose_type = 'office')::text || ' 辦公室）'
            from public.purchase_demand_items),
         '總數跟跑之前一模一樣，而且辦公室那一格現在應該是 0'

  union all
  /*
   * ★★ 沒有矛盾的列。跑完應該是 0 ——
   *   不是 0 的話代表既有資料本來就有問題，而約束會擋住之後的寫入
   *   但**不會回頭修**那幾列。
   */
  select 5, '★ 沒有矛盾的列',
         (select case when count(*) = 0 then '✅ 0 筆'
                      else '⚠ ' || count(*) || ' 筆矛盾（office 卻有物業，或 estate 卻沒有）' end
            from public.purchase_demand_items
           where (purpose_type = 'office' and estate_id is not null)
              or (purpose_type = 'estate' and estate_id is null)),
         '有的話約束根本加不上去，所以看到這一行就代表已經是乾淨的'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
