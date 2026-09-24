/* ══════════════════════════════════════════════════════════════════════
 * migration_299  契約每期租金明細（rent_lines）＋ 發票金額可填                2026-09-24
 *
 * 【為什麼】David：「租期之下可以拆分明細並儲存 —— 房租多少、設備租賃多少（都未稅），
 *   明細加總要等於外面填的每期租金，一定要擋」；「開發票要能存金額」。
 *
 * 【這支做什麼】
 *   1. contracts.rent_lines jsonb not null default '[]'
 *        形狀 [{label, amount}]，跟 concessions 同一種存法。
 *   2. 觸發器 ct_rent_lines_chk：有明細時 ── 每列 label 非空、amount ≥ 0、
 *        加總 ＝ amount_per_period；不然拒絕（訊息是人話，前端也擋同一條）。
 *        ★ 沒明細（[]）一律放行 —— 明細是選填。
 *        ★ 改 amount_per_period 也會觸發：明細留著、租金改了 → 擋，要先改明細。
 *   3. invoices.amount 本來就有（以前前端自動塞），只補 COMMENT 說明現在可以填。
 *
 * 【不動的】月租單、應收、收租、認列全部照舊看 amount_per_period；舊契約 rent_lines = []。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

alter table public.contracts
  add column if not exists rent_lines jsonb not null default '[]'::jsonb;

comment on column public.contracts.rent_lines is
  '每期租金明細 [{label, amount}]，未稅、備查用（migration_299）。'
  '有明細時加總必須等於 amount_per_period（觸發器 ct_rent_lines_chk 擋）。'
  '月租單、應收、認列都不看這欄 —— 真相還是 amount_per_period。';

comment on column public.invoices.amount is
  '發票金額。migration_299 起由登錄發票視窗填（預設帶那一期的應收）；之前自動塞的與 null 都照舊。';

create or replace function public.ct_rent_lines_chk()
returns trigger language plpgsql as $fn$
declare
  n   int;
  s   numeric;
begin
  if new.rent_lines is null then new.rent_lines := '[]'::jsonb; end if;
  if jsonb_typeof(new.rent_lines) <> 'array' then
    raise exception '租金明細格式不對（要是陣列）' using errcode = 'check_violation';
  end if;
  n := jsonb_array_length(new.rent_lines);
  if n = 0 then return new; end if;

  if exists (select 1 from jsonb_array_elements(new.rent_lines) e
              where coalesce(btrim(e->>'label'), '') = '') then
    raise exception '有一列租金明細沒填項目' using errcode = 'check_violation';
  end if;
  if exists (select 1 from jsonb_array_elements(new.rent_lines) e
              where (e->>'amount') is null or (e->>'amount') !~ '^-?\d+(\.\d+)?$' or (e->>'amount')::numeric < 0) then
    raise exception '租金明細的金額要是 0 或正數' using errcode = 'check_violation';
  end if;

  select sum(round((e->>'amount')::numeric)) into s from jsonb_array_elements(new.rent_lines) e;
  if s <> round(coalesce(new.amount_per_period, 0)) then
    raise exception '租金明細合計 % 跟每期租金 % 對不上，要先改明細', s, coalesce(new.amount_per_period, 0)
      using errcode = 'check_violation';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_ct_rent_lines_chk on public.contracts;
create trigger trg_ct_rent_lines_chk
  before insert or update of rent_lines, amount_per_period on public.contracts
  for each row execute function public.ct_rent_lines_chk();

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('299_rent_lines');
  end if;
end $do$;

commit;

-- 自檢（在 commit 後面 —— 看不到就是整支回滾了）
select 1 as 序, '這支跑過了沒' as 檢查,
       (select count(*)::text from public.schema_migrations where name = '299_rent_lines') as 結果,
       case when exists (select 1 from public.schema_migrations where name = '299_rent_lines') then '✅' else '❌' end as 判定
union all select 2, 'contracts.rent_lines 欄位',
       coalesce((select data_type || ' / default ' || column_default from information_schema.columns
                  where table_schema = 'public' and table_name = 'contracts' and column_name = 'rent_lines'), '沒有'),
       case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'contracts' and column_name = 'rent_lines') then '✅' else '❌' end
union all select 3, '觸發器 trg_ct_rent_lines_chk 掛在 contracts 上',
       (select count(*)::text from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace ns on ns.oid = c.relnamespace
         where ns.nspname = 'public' and c.relname = 'contracts' and t.tgname = 'trg_ct_rent_lines_chk' and not t.tgisinternal),
       case when exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace ns on ns.oid = c.relnamespace
                          where ns.nspname = 'public' and c.relname = 'contracts' and t.tgname = 'trg_ct_rent_lines_chk') then '✅' else '❌' end
union all select 4, '既有契約：有明細但合計對不上的（應該 0 —— 舊資料全是 []）',
       (select count(*)::text from public.contracts c
         where jsonb_array_length(c.rent_lines) > 0
           and (select sum(round((e->>'amount')::numeric)) from jsonb_array_elements(c.rent_lines) e) <> round(coalesce(c.amount_per_period, 0))),
       case when (select count(*) from public.contracts c
                   where jsonb_array_length(c.rent_lines) > 0
                     and (select sum(round((e->>'amount')::numeric)) from jsonb_array_elements(c.rent_lines) e) <> round(coalesce(c.amount_per_period, 0))) = 0
            then '✅' else '❌ 貼給我' end
union all select 5, '母體：契約張數／已有明細的張數',
       (select count(*)::text || ' / ' || count(*) filter (where jsonb_array_length(rent_lines) > 0)::text from public.contracts),
       case when (select count(*) from public.contracts) = 0 then '⚠ 一張契約都沒有，上面等於沒檢查到' else 'ℹ 剛跑完「已有明細」會是 0，正常' end
union all select 6, '發票：有金額／沒金額的張數（舊的沒存就是 null，照舊）',
       (select count(*) filter (where amount is not null)::text || ' / ' || count(*) filter (where amount is null)::text from public.invoices),
       'ℹ 參考'
order by 1;
