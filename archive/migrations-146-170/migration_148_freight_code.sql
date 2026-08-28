-- migration_148：新增會計科目「運費」，順便補上「水電瓦斯」漏掉的對照
--
-- ============================================================
-- 【要做什麼】（2026-08-19 使用者指定）
--
--     項目：運費 → 會計科目：運費
--
-- 跟 migration_114 加「保證金」是同一件事，照那支的格式走。
--
--
-- ============================================================
-- 【順便修一個安靜的漏洞：水電瓦斯】
--
-- `order_account_code()` 的對照表裡有「水費／電費／瓦斯費」，
-- **但沒有「水電瓦斯」**。
--
-- 而 2026-08-19 加的一次性費用預設值裡，「電費」的科目正是水電瓦斯
-- （見 lib/fee-types.ts 的 CONTRACT_FEE_PRESETS）——
-- 所以用那個預設記的每一筆電費，都會掉到 `else 'other'`，
-- 在營收報表上變成「其他」。
--
-- ★ 這種錯**不會報錯**：那筆錢有進來、金額也對，只是歸錯了科目。
--   而「其他」本來就是個雜項桶，多幾筆進去沒有人會覺得奇怪。
--
-- 這裡一併補上。**沒有回填** —— 理由跟 migration_114 一樣：
-- orders 上有 orders_recognize 觸發器，update 任何欄位都會讓那筆
-- 訂單的營收認列重算。既有那幾筆歸在「其他」的要不要調整，
-- 是業務決定，不該由這支 migration 順手做掉。
--
-- 要看有幾筆受影響，檔尾有查詢。


-- ── 1. 科目主檔 ────────────────────────────────────
-- sort 接在保證金（152）後面
insert into public.account_codes (code, name, sort, active, kind) values
  ('freight', '運費', 153, true, 'both')
on conflict (code) do update set
  name = excluded.name, kind = excluded.kind, active = true;


-- ── 2. 名目 → 計入科目 ─────────────────────────────
/*
 * 只加兩行:'運費' → 'freight'、'水電瓦斯' → 'utility'。
 * 其餘一個字都不動 —— 這張對照表是營收報表的分組依據，
 * 改動一行就會讓某個科目的歷史數字整批位移。
 */
create or replace function public.order_account_code(p_source text, p_fee_type text)
returns text language sql immutable as $fn$
  select case
    -- 一次性收入：名目計入對應科目。名目本身照舊存在 fee_type，不動。
    when p_source in ('oneoff', 'airbnb_cancelled') then
      case coalesce(p_fee_type, '其他')
        when '水費'     then 'utility'
        when '電費'     then 'utility'
        when '瓦斯費'   then 'utility'
        when '水電瓦斯' then 'utility'   -- ★ 補上（migration_148）
        when '修繕費'   then 'repair'
        when '網路費'   then 'internet'
        when '管理費'   then 'mgmtfee'
        when '清潔費'   then 'cleaning'
        when '停車費'   then 'parking'
        when '設備費'   then 'equipment'
        when '保證金'   then 'guarantee'
        when '運費'     then 'freight'   -- ★ 新增（migration_148）
        -- 認不得的一律計入「其他」
        else 'other'
      end
    -- 其餘全部計入租金收入
    else 'rent_income'
  end
$fn$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('148_freight_code');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk148;
  create temp table _chk148 (ord int, item text, result text, detail text);

  insert into _chk148 values (1, '科目「運費」',
    case when exists (select 1 from public.account_codes where code = 'freight' and active)
         then '✅' else '❌' end, 'code = freight');

  insert into _chk148 values (2, '運費 → freight',
    case when public.order_account_code('oneoff', '運費') = 'freight'
         then '✅' else '❌ 對照沒生效' end, '');

  insert into _chk148 values (3, '★ 水電瓦斯 → utility',
    case when public.order_account_code('oneoff', '水電瓦斯') = 'utility'
         then '✅ 已修正' else '❌ 還是掉到 other' end,
    '這一條之前漏了 —— 用「電費」預設記的一次性費用會歸到「其他」');

  /*
   * ★★ 其餘對照一個都不能被改到。
   *
   * 這張表是營收報表的分組依據。不小心改掉一行，
   * 那個科目的歷史數字會整批位移 —— 而報表上只會看到某一欄突然變高，
   * 沒有人會想到是對照表被動過。
   */
  select count(*) into n from (values
    ('水費','utility'), ('電費','utility'), ('瓦斯費','utility'),
    ('修繕費','repair'), ('網路費','internet'), ('管理費','mgmtfee'),
    ('清潔費','cleaning'), ('停車費','parking'), ('設備費','equipment'),
    ('保證金','guarantee'), ('其他','other')
  ) v(ft, expect)
  where public.order_account_code('oneoff', v.ft) <> v.expect;
  insert into _chk148 values (4, '★★ 既有對照沒被動到',
    case when n = 0 then '✅ 11 條全對' else '❌ 有 ' || n || ' 條變了' end,
    '這張表是營收報表的分組依據，改錯一行歷史數字會整批位移');

  insert into _chk148 values (5, '非一次性的仍然計入租金',
    case when public.order_account_code('airbnb', null) = 'rent_income'
         then '✅' else '❌' end, '');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk148 order by ord;


-- ============================================================
-- 受「水電瓦斯」那個漏洞影響的既有資料
-- ============================================================
/*
 * **這支沒有回填**。orders 上有 orders_recognize 觸發器，
 * update 任何欄位都會讓那筆訂單的營收認列重算 ——
 * 要不要調整是業務決定，不該由 migration 順手做掉。
 *
 * 下面這張表列出有幾筆、多少錢。要調整的話再開一支專門的。
 */
select
  coalesce(fee_type, '（沒填）')                as "名目",
  count(*)                                     as "筆數",
  sum(amount)                                  as "金額",
  min(checkin)                                 as "最早",
  max(checkin)                                 as "最晚",
  public.order_account_code(source, fee_type)  as "現在會計入"
from public.orders
where source in ('oneoff', 'airbnb_cancelled')
  and fee_type in ('水電瓦斯', '運費')
group by fee_type, source
order by count(*) desc;
