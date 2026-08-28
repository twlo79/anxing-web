-- migration_180：補回 attachments.order_id（加費憑證）
--
-- ============================================================
-- 【★★★ 這件事最重要的部分不是 bug 本身，是它被抓到過】
--
-- `migration_172` 的自檢裡有這麼一項:
--
--     '應為 7 個。是 6 的話表示 migration_158 的 order_id 還沒建'
--
-- 也就是說 —— **172 跑的時候那一項就是 6，而它已經把答案印在畫面上了。**
-- 沒有人動作。從那天起到今天（2026-08-28），加費憑證一直是壞的。
--
-- ★ 這比「有 bug」嚴重:守門員盡責了，而報告沒有人讀。
--   自檢寫得再好，出來的東西沒有人看的話跟沒有一樣。
--
--
-- ============================================================
-- 【怎麼發現的】（2026-08-28，寫 migration_179 的時候）
--
-- 179 要在 attachments 加第七個 parent，先照 README 那張表寫死六個欄位:
--
--     ERROR 42703: column "order_id" does not exist
--
-- 線上實際是:
--   deposit_id, deposit_payment_id, expense_id,
--   order_payment_id, request_id, request_item_id
--
-- 六欄，但**跟 README 那張表對不起來** —— 多了 request_item_id、少了 order_id。
--
--
-- ============================================================
-- 【★★ 為什麼沒有人發現】
--
-- `Receipts.tsx` 的 load():
--
--     const { data } = await supabase.from('attachments')
--       .select(...).eq(col, parentId);
--     setRows(data ?? []);
--                ^^^^^^ error 沒有被檢查
--
-- 查詢報錯 → data 是 null → 畫面顯示「沒有附件」。
-- **跟真的沒有附件長得一模一樣。**
--
-- 這正是 README 9.2 那條「空的但合理」:每一個零件單獨看都正確
-- （欄位在型別裡、元件寫對了、路徑前綴也對），串起來就是一片空白。
--
-- ★ 所以這一支之外，`Receipts.tsx` 的 load() 也補上了 error 檢查 ——
--   只補資料庫的話，下一次同樣的事還是會安靜地發生。
--
--
-- ============================================================
-- 【這支做什麼】
--
--   ① 補 attachments.order_id（＋ FK、索引、註解）
--   ② att_one_parent 整條重建 —— 欄位清單去問線上，不寫死
--   ③ 自檢:真的插一筆再回滾，確認 order_id 可用而且互斥仍然成立
-- ============================================================

create temp table _chk180 (ord int, item text, result text, note text) on commit drop;


-- ============================================================
-- ① 補欄位
-- ============================================================
alter table public.attachments
  add column if not exists order_id uuid;

/*
 * on delete cascade —— 跟 migration_158 原本的設計一致。
 *
 * 訂單的加費被刪掉時，那張收據就沒有任何東西指得到它了，
 * 留著只會變成永遠沒人清的孤兒檔。
 * （押金那條是 set null，因為押金退掉之後那些水單還有稽核價值。）
 */
do $$ begin
  alter table public.attachments drop constraint if exists attachments_order_id_fkey;
  alter table public.attachments add constraint attachments_order_id_fkey
    foreign key (order_id) references public.orders(id) on delete cascade;
end $$;

create index if not exists attachments_order_id_idx
  on public.attachments (order_id) where order_id is not null;

comment on column public.attachments.order_id is
  '掛在訂單（含加費子單）底下的憑證。路徑前綴 of/。'
  '★ migration_158 原本要建但沒建成,2026-08-28 由 migration_180 補回 —— '
  '中間這段時間加費憑證是壞的,而且是安靜的（Receipts 的 load 沒檢查 error）。';


-- ============================================================
-- ② att_one_parent 整條重建
-- ============================================================
/*
 * ★★ 欄位清單**去問線上**，不寫死。
 *
 *   寫死是 179 第一版的錯法 —— 而那個錯法之所以危險,是它
 *   **可能建得起來但擋錯東西**:漏掉某一欄的話,那一欄就不再互斥,
 *   一筆附件可以同時掛兩個地方,刪一邊另一邊看到連不到的圖。
 *
 * ★ 這裡認兩種形狀（跟 179 同一套）:
 *     `num_nonnulls(a,b,c)`        —— 179 之後線上是這種
 *     `(a IS NOT NULL)::int + …`   —— 158/172 留下的舊寫法
 */
do $$
declare def text; cols text; n int;
begin
  select pg_get_constraintdef(oid) into def
    from pg_constraint
   where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent';

  if def is null then
    raise exception 'attachments 上找不到 att_one_parent —— 這支 migration 的前提不成立';
  end if;

  if position('order_id' in def) > 0 then
    insert into _chk180 values (0, '② att_one_parent', '↷ 已含 order_id，跳過',
      '這支 migration 重跑是安全的');
  else
    cols := btrim(substring(def from 'num_nonnulls\(([^)]*)\)'));
    if cols is null or cols = '' then
      select string_agg(m[1], ', ' order by m[1]) into cols
        from regexp_matches(def, '([a-z_][a-z0-9_]*)\s+IS\s+NOT\s+NULL', 'gi') as m;
    end if;
    if cols is null or cols = '' then
      raise exception 'att_one_parent 認不出欄位清單，請人工處理：%', def;
    end if;

    n := length(cols) - length(replace(cols, ',', '')) + 1;
    /*
     * ★ 下限訂在 6。
     *
     *   179 跑完之後線上一定有七欄（六舊 ＋ tender_id）。
     *   解析出來少於 6 就是**解析錯了**,不是資料庫少東西 ——
     *   而解析錯又照樣建上去的話,被漏掉的那幾欄就不再互斥。
     */
    if n < 6 then
      raise exception 'att_one_parent 只解析出 % 欄（%），不合理，請人工確認：%', n, cols, def;
    end if;

    execute 'alter table public.attachments drop constraint att_one_parent';
    execute format(
      'alter table public.attachments add constraint att_one_parent check (num_nonnulls(%s, order_id) = 1)',
      cols);

    insert into _chk180 values (0, '② att_one_parent', '✅ 原有 ' || n || ' 欄 ＋ order_id',
      '線上原本是：' || cols);
  end if;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('180_fix_order_receipt');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================

-- ① 真的插一筆 order_id 的附件（158 從來沒走通過的那條路）
do $$
declare v text; v2 text; oid_ uuid; rid uuid;
begin
  select id into oid_ from public.orders limit 1;
  select id into rid  from public.purchase_requests limit 1;

  if oid_ is null then
    insert into _chk180 values (1, '★★ order_id 附件插得進去', '⚠ 測不出來', '一張訂單都沒有');
    return;
  end if;

  begin
    insert into public.attachments (path, order_id) values ('of/x/y.jpg', oid_);
    v := '✅ 插得進去';

    -- 互斥仍然成立
    if rid is null then
      v2 := '⚠ 沒有請款單可借用';
    else
      begin
        insert into public.attachments (path, order_id, request_id)
          values ('of/x/z.jpg', oid_, rid);
        v2 := '❌ 兩個 parent 都有值卻插得進去';
      exception when check_violation then v2 := '✅ 兩個被擋下';
        when others then v2 := '⚠ 撞到別的錯：' || sqlerrm;
      end;
    end if;

    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    -- ★ 抓 others,不是只抓自己丟的那一種（README 9.4 #9）
    if sqlerrm <> '__rollback__' then v := '❌ ' || sqlerrm; end if;
  end;

  insert into _chk180 values (1, '★★ order_id 附件插得進去（158 沒走通的那條路）',
    coalesce(v, '⚠ 測不出來') || '；' || coalesce(v2, '⚠ 測不出來'),
    '這就是加費憑證上傳走的路');
end $$;

-- ② parent 欄位一個都沒少
/*
 * ★★ 問的是**互斥的欄位有幾個**，不是「order_id 加好了嗎」。
 *
 *   問後者的話等於用「我剛剛做的那件事」檢查自己,永遠會過（README 9.4 #12）。
 *
 * ★★★ 但第一版把它寫成 `= 7`，而實際是 8（六個舊的 ＋ tender_id ＋ order_id）——
 *     於是印出「❌ 只有 8 / 7」這種**看不懂的句子**。
 *
 *     這是同一天第三次犯同一種錯:
 *       ① sql-comments 的 `scanned > 10`     ← 封存 migration 之後紅了
 *       ② day-phase 的 `stops.length >= 5`   ← 漸層簡化之後紅了
 *       ③ 這一條的 `= 7`                      ← 多加一欄之後紅了
 *
 *     每一次都是**把「現在剛好是幾個」寫成了規則**。
 *     而三次紅燈的原因都跟被檢查的東西無關 —— 那是假警報，
 *     假警報比漏報更傷:下次真的紅時就沒有人相信了。
 *
 * ★ 所以改成**下限 ＋ 印出實際值**。少了才是問題;多了是有人加了新的 parent,
 *   那是好事。
 */
insert into _chk180
select 2, '★★ att_one_parent 涵蓋的 parent 欄位',
  case when n >= 8 then '✅ ' || n || ' 個' else '❌ 只有 ' || n || ' 個，少了' end,
  '至少要有 request_id、request_item_id、expense_id、deposit_id、'
  || 'order_payment_id、deposit_payment_id、order_id、tender_id 這八個'
from (
  select (select count(*) from regexp_matches(
            pg_get_constraintdef(oid), '[a-z_][a-z0-9_]*_id', 'g')) as n
  from pg_constraint
  where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent'
) x;

-- ③ 印出結果，給下一個人看
insert into _chk180
select 3, 'att_one_parent 現在長這樣', '📋', pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.attachments'::regclass and conname = 'att_one_parent';

-- ④ 過去有沒有人試著上傳過加費憑證（那些嘗試都失敗了，這裡確認沒有殘留）
insert into _chk180
select 4, 'of/ 開頭的附件', count(*)::text || ' 筆',
  '這欄之前不存在,所以應該是 0 —— 不是 0 的話代表有別的路徑寫進來過'
from public.attachments where path like 'of/%';

-- ── 單一 SELECT（SQL Editor 只顯示最後一個）──────────
select item as "檢查項目", result as "結果", note as "說明"
from _chk180 order by ord, item;
