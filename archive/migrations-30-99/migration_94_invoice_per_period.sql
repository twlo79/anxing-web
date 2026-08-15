-- migration_94：發票改成「一期一張」，同一期可以再開
--
-- ============================================================
-- 【問題】
--
-- 發票以「月」為單位：年繳契約的收租視窗會展開成 12 列
--
--     發票 2026/6   ZX31935700  2026-05-06  改
--     發票 2026/7   ZX31935700  2026-05-06  改
--     ...（一路到 2027/5）
--
-- 12 列全部是同一個號碼、同一個日期 —— 因為實務上那是**一張**發票。
-- 使用者一期收一次錢、開一張發票，畫面卻要他確認 12 次。
--
--
-- ============================================================
-- 【為什麼要動約束】
--
--     invoices_contract_ym_uniq ON (contract_id, ym) WHERE status='issued'
--
-- 這條讓「一個契約的一個月只能有一張發票」。改成一期一張之後，
-- 使用者說「若還要開自行新增」—— 同一期開第二張（補開、折讓後重開）
-- 會直接撞上這條。
--
-- 【換成什麼】
--
--     unique (invoice_no) where status='issued'
--
-- **這才是真的不變式。** 統一發票號碼全國唯一，同一個號碼不可能出現兩次；
-- 而「一個月一張」只是這個系統當初的簡化假設，實務上並不成立。
--
-- 換過去之後保護反而更強：以前同一個號碼可以打進不同月份而不會被擋，
-- 那種重複沒有任何跡象；現在打第二次就會被擋下來。
--
--
-- ============================================================
-- 【既有資料怎麼辦】
--
-- 年繳契約現在有 12 列同號碼的發票。它們是真實的紀錄（有人按過 12 次），
-- **這支不刪** —— 畫面會把同一期的發票全部列出來，所以看得到。
--
-- 但那 12 列的 invoice_no 相同，會直接違反新的唯一索引。
-- 所以下面先把「同號碼的重複列」收斂成一列：留 ym 最小的那張
-- （也就是該期第一個月），其餘標成 voided 而不是刪掉 ——
-- 標記保留了「這裡曾經有一列」的事實，而刪掉就查不到了。


-- ============================================================
-- 1. 收斂重複號碼
-- ============================================================

do $$
declare n int;
begin
  -- 同一張契約、同一個發票號碼、多列 issued → 只留 ym 最小的
  with dup as (
    select id, row_number() over (
             partition by coalesce(contract_id::text, id::text), invoice_no
             order by ym, created_at) as rn
      from public.invoices
     where status = 'issued'
  )
  update public.invoices i
     set status = 'voided',
         note = coalesce(i.note || ' / ', '') || 'migration_94：同號碼重複列，已收斂為一期一張'
    from dup
   where dup.id = i.id and dup.rn > 1;
  get diagnostics n = row_count;
  raise notice 'ℹ 收斂了 % 列重複號碼的發票（標成 voided,沒有刪除）', n;
end $$;


-- ============================================================
-- 2. 換約束
-- ============================================================

drop index if exists public.invoices_contract_ym_uniq;

-- 發票號碼全國唯一 —— 這是真的不變式,不是系統的簡化假設
create unique index if not exists invoices_no_uniq
  on public.invoices (invoice_no) where status = 'issued';

comment on index public.invoices_no_uniq is
  '發票號碼唯一（只管 issued）。取代 migration_94 之前的 (contract_id, ym) 唯一 —— '
  '那條假設「一個月一張」,但年繳是一期一張,而且同一期可能補開第二張。';


-- ============================================================
-- 驗證
-- ============================================================

do $$
declare n int;
begin
  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname = 'invoices_contract_ym_uniq';
  if n = 0 then raise notice '✅ 舊的「一個月一張」約束已移除';
  else raise warning '❌ invoices_contract_ym_uniq 還在,同一期開第二張會被擋'; end if;

  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname = 'invoices_no_uniq';
  if n = 1 then raise notice '✅ 發票號碼唯一索引已建立';
  else raise warning '❌ invoices_no_uniq 不存在,同一個號碼可以重複輸入'; end if;

  -- 還有沒有重複號碼（有的話上面的索引根本建不起來,這是雙重確認）
  select count(*) into n from (
    select invoice_no from public.invoices where status = 'issued'
     group by invoice_no having count(*) > 1) x;
  if n = 0 then raise notice '✅ 沒有重複的發票號碼';
  else raise warning '❌ 還有 % 個號碼重複', n; end if;

  select count(*) into n from public.invoices where status = 'issued';
  raise notice 'ℹ 目前有效發票 % 張', n;
  select count(*) into n from public.invoices where status = 'voided';
  raise notice 'ℹ 作廢/收斂的 % 張（保留紀錄,可查）', n;

exception when others then
  raise warning '驗證區出錯（上面的變更不受影響）:%', sqlerrm;
end $$;


-- ── 收斂結果（給人核對）─────────────────────────────
select c.room as 房源, c.tenant_name as 租戶, c.cadence as 繳別,
       i.invoice_no as 發票號碼, i.invoice_date as 開票日,
       count(*) filter (where i.status = 'issued') over (partition by i.invoice_no) as 有效列數,
       i.ym as 月份, i.status as 狀態
from public.invoices i
left join public.contracts c on c.id = i.contract_id
where i.contract_id is not null
order by c.room, i.invoice_no, i.ym
limit 60;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('94_invoice_per_period'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
