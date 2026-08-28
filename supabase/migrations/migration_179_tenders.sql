-- migration_179：標案管理（追蹤器 ＋ 紀錄）
--
-- ============================================================
-- 【要做什麼】（2026-08-28 使用者指定）
--
--   Tab 2  標案追蹤器  tender_feed —— 爬蟲每天推進來的
--   Tab 1  紀錄標案    tenders     —— 加星之後**複製**一份，人自己維護
--
-- 爬蟲：https://github.com/twlo79/tender-scraper（九個政府網站，每天 08:00）
--
--
-- ============================================================
-- 【★★ 為什麼是兩張表，而且是「複製」不是「連動」】
--
-- 追蹤器是**爬蟲的**資料，每天會被覆寫;
-- 紀錄是**人的**資料，寫進去的地址、截標日期、筆記不能被蓋掉。
--
-- 連動的話:某天機關改了標題或撤掉公告，
-- 使用者的筆記就掛在一個不認得的東西上 —— 而畫面不會說發生了什麼。
--
-- 這跟評價那邊「不能真刪、只能隱藏」是同一種考量:
-- **爬蟲會覆蓋的東西，不能拿來當人工資料的載體。**
--
--
-- ============================================================
-- 【★★ 唯一鍵為什麼是三欄，不是 (source, url)】
--
-- 直覺是 `unique (source, url)` —— url 通常帶公告編號。
-- 但爬蟲的 README 寫著郵局那一支:
--
--     「無各別標案頁，連結統一指向來源頁」
--
-- 也就是**郵局的每一筆 url 都一樣**。用兩欄的話那 83 筆會互相覆蓋，
-- 最後只剩一筆 —— 而且是安靜的:沒有錯誤，只是清單很短。
--
-- 加上 title 之後:
--
--   郵局      url 相同、title 不同  → 各自一筆 ✅
--   機關改標題  url 相同、title 變了  → 多一筆重複 ⚠（看得到，可以忽略）
--
-- **少填一個看得到、補得回來;填錯一個沒有人會發現**（CLAUDE.md）——
-- 所以選會多一筆的那個。
--
-- ★ 爬蟲自己是用「標題」去重的，而且每個來源只留最近 300 筆會輪替。
--   ERP 不能依賴那個 —— 輪替掉之後同一筆會再被推一次，
--   這裡的唯一索引就是最後一道防線。
--
--
-- ============================================================
-- 【權限:只有總經理】（2026-08-28 使用者選的）
--
-- ★ 保留意見但照做:只有一個人能維護的清單，他不在的時候就沒人看。
--   之後要放寬是改一行政策，很便宜。
--
-- ★★ 附件那一層要一起管。`can_see_receipt()` 的第一個分支是
--    「accountant / manager / super_admin 一律看得到」——
--    不動它的話，會計與主管會從 attachments 那邊看到標案的文件，
--    **而畫面上根本沒有標案這個選單**。
--    「畫面說的話跟資料庫說的話不一致」正是 README 9.3 那一條。
-- ============================================================

create temp table _chk179 (ord int, item text, result text, note text) on commit drop;


-- ============================================================
-- ① 追蹤器：爬蟲每天推進來的
-- ============================================================
create table if not exists public.tender_feed (
  id          uuid primary key default gen_random_uuid(),
  source      text not null,          -- 哪一支爬蟲（台北市財政局、政府採購網…）
  title       text not null,
  /*
   * ★★ `not null default ''` 而不是可為 null。
   *
   *   唯一索引要能被 `ON CONFLICT` 對到,**只能是純欄位的完整索引** ——
   *   `unique (source, coalesce(url,''), title)` 是運算式索引,
   *   PostgREST 的 upsert 推不出來,症狀是
   *   `there is no unique or exclusion constraint matching the ON CONFLICT specification`。
   *
   *   這個專案為了 ON CONFLICT 對不到索引賠過兩天,而且**踩過兩次**（README 9.1②）。
   *   所以寧可讓「沒有網址」用空字串表示,也不要在索引裡放運算式。
   */
  url         text not null default '',   -- 郵局那一支所有筆都指向同一頁
  agency      text,                   -- 機關名。政府採購網那支沒有,要從標題看
  posted_on   text,                   -- 公告日期。★ **不是截標日期**,而且民國/西元混用,所以存文字
  run_at      timestamptz not null default now(),
  starred_at  timestamptz,
  starred_by  uuid,
  tender_id   uuid,                   -- 加星後建了哪一筆紀錄
  created_at  timestamptz not null default now()
);

comment on table public.tender_feed is
  '標案追蹤器:爬蟲每天推進來的公告。★ 這是爬蟲的資料,人不要在這裡寫東西 —— '
  '要記筆記請加星建成 tenders（migration_179）。';

comment on column public.tender_feed.posted_on is
  '公告日期,**不是截標日期**。爬蟲抓不到截標日期（在詳情頁裡,九個網站格式都不同）。'
  '存 text 是因為來源有民國曆也有西元曆,轉錯的成本高於不轉。';

comment on column public.tender_feed.run_at is
  '這一筆是哪一次執行推進來的。★ 爬蟲的白名單/黑名單寫死在 scraper.py,'
  '哪天調了條件這邊的數量會安靜地跟著變 —— 有這一欄才查得出是那天開始變的。';


-- ============================================================
-- ② 紀錄標案：人自己維護的
-- ============================================================
create table if not exists public.tenders (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,          -- 標案名稱
  source      text,                   -- 來源機關
  url         text,
  address     text,                   -- ★ 爬蟲給不出來,人工填
  due_on      date,                   -- ★ 截標日期。爬蟲給不出來,人工填
  status      text not null default 'watching',
  note        text,
  feed_id     uuid references public.tender_feed(id) on delete set null,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on column public.tenders.due_on is
  '截標日期。★ **可以是 null** —— 爬蟲只給得到公告日期,兩者常差好幾週。'
  '與其填一個猜的日期,不如留空並在畫面上標「未填」:'
  '少填一個看得到、補得回來;填錯一個沒有人會發現。';

comment on column public.tenders.feed_id is
  '從追蹤器哪一筆複製過來的。null = 手動新增（朋友介紹、報紙看到的,'
  '不會出現在那九個網站）。★ 只是出處,不是連動 —— 追蹤器那筆改了不會影響這裡。';

/*
 * 狀態。
 *
 * ★ 「放棄」要留著不要刪 —— 三個月後會想知道「這個我們看過,為什麼沒投」。
 *   刪掉的話同一個案子明年再出現時,沒有人記得上次為什麼放棄。
 */
do $$ begin
  alter table public.tenders drop constraint if exists tender_status_chk;
  alter table public.tenders add constraint tender_status_chk
    check (status in ('watching', 'preparing', 'submitted', 'won', 'lost', 'dropped'));
end $$;


-- ============================================================
-- ③ 唯一索引（理由見檔頭）
-- ============================================================
/*
 * ★ 完整索引，不是部分索引。
 *   `where url is not null` 那種 ON CONFLICT 推不出來 —— 這個專案踩過兩次
 *   （README 9.1②）。NULL 之間不算相等,所以效果一樣。
 *
 * ★★ 三欄都是純欄位,不是運算式 —— `ON CONFLICT (source,url,title)` 才對得到。
 *   `url` 是 `not null default ''`（見上面那段註解）。
 */
create unique index if not exists tender_feed_uniq
  on public.tender_feed (source, url, title);

create index if not exists tender_feed_run_idx on public.tender_feed (run_at desc);
/* 追蹤器預設只看沒建檔的,那是最常跑的查詢 */
create index if not exists tender_feed_open_idx
  on public.tender_feed (run_at desc) where tender_id is null;
create index if not exists tenders_due_idx on public.tenders (due_on);


-- ============================================================
-- ④ 附件：第七個 parent
-- ============================================================
alter table public.attachments
  add column if not exists tender_id uuid;

do $$ begin
  alter table public.attachments
    drop constraint if exists attachments_tender_id_fkey;
  alter table public.attachments
    add constraint attachments_tender_id_fkey
    foreign key (tender_id) references public.tenders(id) on delete cascade;
end $$;

/*
 * ★★ `att_one_parent` **整條重建**，把新欄位加進 num_nonnulls。
 *
 *   漏掉的話一筆附件可以同時掛兩個地方,而刪掉其中一邊時
 *   另一邊會看到一張連不到東西的圖（README 的 attachments 那一節）。
 *
 *   所以不能用 `add constraint ... not valid` 之類的偷懶做法 ——
 *   舊資料本來就合規（tender_id 全是 null）,重建是安全的。
 */
do $$ begin
  alter table public.attachments drop constraint if exists att_one_parent;
  alter table public.attachments add constraint att_one_parent
    check (num_nonnulls(request_id, expense_id, deposit_id,
                        order_payment_id, deposit_payment_id, order_id,
                        tender_id) = 1);
end $$;

create index if not exists att_tender_idx on public.attachments (tender_id)
  where tender_id is not null;


-- ============================================================
-- ⑤ 附件的可見性：td/ 只給總經理
-- ============================================================
/*
 * ★★ 讀線上定義 ＋ 錨點注入，**對不上就整支中止**。
 *
 *   `can_see_receipt` / `can_edit_receipt` 不在這一支的掌控範圍內
 *   （migration_171 改過一次，而 schema-baseline.sql 不可信 —— README 9.5）。
 *   照 baseline 重寫等於用一份可能過期的定義覆蓋線上的,
 *   **而且不會有任何錯誤訊息**。
 *
 * ★ 注入的位置是 `select case` 後面 —— 新分支排在最前面,
 *   所以它會先於「accountant/manager/super_admin 一律 true」那一條被判斷。
 *   排在後面的話永遠走不到。
 */
do $$
declare
  fn text;
  old_def text;
  new_def text;
  n int;
  arm text;
begin
  foreach fn in array array['can_see_receipt', 'can_edit_receipt'] loop
    select pg_get_functiondef(p.oid) into old_def
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = fn
     limit 1;

    if old_def is null then
      raise exception '找不到函式 %，這支 migration 的前提不成立', fn;
    end if;

    -- 已經改過就跳過（規矩 4:要能重跑）
    if position('''td/%''' in old_def) > 0 then
      insert into _chk179 values (0, '⑤ ' || fn, '↷ 已含 td/ 分支，跳過', '重跑是安全的');
      continue;
    end if;

    select count(*) into n from regexp_matches(old_def, 'select\s+case', 'gi');
    if n <> 1 then
      raise exception
        '% 的定義跟預期不同（`select case` 對到 % 處，預期 1 處）。請把 pg_get_functiondef 貼出來人工處理。',
        fn, n;
    end if;

    arm := 'select case when p_path like ''td/%'' then current_role_of() = ''super_admin'' ';
    new_def := regexp_replace(old_def, 'select\s+case', arm, 'i');
    execute new_def;

    insert into _chk179 values (0, '⑤ ' || fn, '✅ td/ 只給 super_admin',
      '新分支排在最前面,先於原本的角色白名單');
  end loop;
end $$;


-- ============================================================
-- ⑥ RLS
-- ============================================================
alter table public.tender_feed enable row level security;
alter table public.tenders     enable row level security;

do $$ begin
  drop policy if exists tf_all on public.tender_feed;
  create policy tf_all on public.tender_feed for all
    using (current_role_of() = 'super_admin')
    with check (current_role_of() = 'super_admin');

  drop policy if exists td_all on public.tenders;
  create policy td_all on public.tenders for all
    using (current_role_of() = 'super_admin')
    with check (current_role_of() = 'super_admin');
end $$;

/*
 * ★ 匯入端點走 service key，不受 RLS 限制 —— 那是刻意的:
 *   爬蟲沒有登入身分,`auth.uid()` 是 null,走 RLS 一列都寫不進來。
 *   端點自己用 `x-import-key` 擋（跟現有六支 import 端點同一個模式）。
 */

/* updated_at 自動維護 */
create or replace function public.tenders_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();   -- ★ 不是 now() —— now() 是交易開始時間
  return new;
end $$;

drop trigger if exists trg_tenders_touch on public.tenders;
create trigger trg_tenders_touch before update on public.tenders
  for each row execute function public.tenders_touch();


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('179_tenders');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★★ 真的寫一次再回滾（README 9.4 #3）。
 *
 *   只用 select 確認「表建好了嗎、索引在嗎」是不夠的 ——
 *   164 那次索引確實存在、名字對、一切看起來都好,而 ON CONFLICT 就是對不到。
 *
 * ★ 內層 begin/exception 是隱式 savepoint:資料回滾、變數留著。
 *   所以結果先存進變數,出了內層再寫進 temp table（規矩 10）。
 */

-- ① 唯一索引真的擋得住重複，而且郵局那種「url 相同」的不會互相覆蓋
do $$
declare v1 text; v2 text; n int;
begin
  begin
    insert into public.tender_feed (source, title, url) values
      ('__t179', 'A案', 'https://same/page'),
      ('__t179', 'B案', 'https://same/page');   -- 同 url、不同標題 → 要並存
    select count(*) into n from public.tender_feed where source = '__t179';
    v1 := case when n = 2 then '✅ 2 筆並存' else '❌ 只剩 ' || n || ' 筆' end;

    begin
      insert into public.tender_feed (source, title, url)
        values ('__t179', 'A案', 'https://same/page');   -- 完全一樣 → 要被擋
      v2 := '❌ 重複的插進去了';
    exception when unique_violation then
      v2 := '✅ 完全相同的被唯一索引擋下';
    end;

    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    -- ★ 抓 others 不是只抓自己丟的那一種（規矩 9）——
    --   被測的東西丟出別種錯時,腳本不該整份炸掉
    if sqlerrm <> '__rollback__' then v1 := coalesce(v1, '') || ' ❌ ' || sqlerrm; end if;
  end;
  insert into _chk179 values (1, '★★ 同 url 不同標題要並存（郵局）', coalesce(v1, '⚠ 測不出來'),
    '兩欄唯一鍵會讓郵局的 83 筆互相覆蓋,而且是安靜的');
  insert into _chk179 values (1, '★ 完全相同的要被擋', coalesce(v2, '⚠ 測不出來'),
    '爬蟲的 state 只留 300 筆會輪替,同一筆會再被推一次');
end $$;

-- ①b ★★ ON CONFLICT 真的對得到那顆索引（踩過兩次的那件事）
do $$
declare v text;
begin
  begin
    insert into public.tender_feed (source, title, url, agency)
      values ('__t179b', 'A案', '', '第一次');
    -- 同一組鍵再來一次,要走 do update 而不是報錯
    insert into public.tender_feed (source, title, url, agency)
      values ('__t179b', 'A案', '', '第二次')
      on conflict (source, url, title) do update set agency = excluded.agency;
    select agency into v from public.tender_feed
      where source = '__t179b' and title = 'A案' and url = '';
    v := case when v = '第二次' then '✅ 對得到,而且真的更新了' else '❌ 值沒被更新（' || coalesce(v,'null') || '）' end;
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    -- ★ 索引是運算式的話,這裡會收到
    --   「there is no unique or exclusion constraint matching...」
    if sqlerrm <> '__rollback__' then v := '❌ ' || sqlerrm; end if;
  end;
  insert into _chk179 values (2, '★★ ON CONFLICT 對得到唯一索引', coalesce(v, '⚠ 測不出來'),
    '運算式索引推不出來 —— 這個專案為了同一件事賠過兩天,踩過兩次');
end $$;

-- ② att_one_parent 真的把 tender_id 算進去了
do $$
declare v text; tid uuid;
begin
  begin
    insert into public.tenders (name) values ('__t179 測試') returning id into tid;
    begin
      -- 兩個 parent 都給 → 要被 CHECK 擋下
      insert into public.attachments (path, tender_id, request_id)
        values ('td/x/y.jpg', tid, tid);
      v := '❌ 兩個 parent 都有值卻插得進去';
    exception when check_violation then
      v := '✅ 兩個 parent 被擋下';
    end;
    -- 只給 tender_id → 要進得去
    if v like '✅%' then
      insert into public.attachments (path, tender_id) values ('td/x/y.jpg', tid);
      v := v || '，只給一個進得去';
    end if;
    raise exception using errcode = 'restrict_violation', message = '__rollback__';
  exception when others then
    if sqlerrm <> '__rollback__' then v := '❌ ' || sqlerrm; end if;
  end;
  insert into _chk179 values (3, '★★ att_one_parent 含 tender_id', coalesce(v, '⚠ 測不出來'),
    '漏掉的話一筆附件可以同時掛兩個地方,刪一邊另一邊看到連不到的圖');
end $$;

-- ③ 附件的 td/ 只有總經理看得到
/*
 * ★★ SQL Editor 沒有登入身分 —— `auth.uid()` 是 null,
 *    直接呼叫 can_see_receipt 永遠回 false,跟這支改了什麼無關（README 9.4 #7）。
 *    所以要**假扮身分**,而且假扮失敗要顯示「⚠ 測不出來」不是「❌」。
 */
do $$
declare uid_sa uuid; uid_ot uuid; a boolean; b boolean; v text;
begin
  select id into uid_sa from public.profiles where role = 'super_admin' and active limit 1;
  select id into uid_ot from public.profiles
    where role in ('accountant','manager') and active limit 1;

  if uid_sa is null or uid_ot is null then
    insert into _chk179 values (4, '★★ td/ 附件只有總經理看得到', '⚠ 測不出來',
      '找不到可假扮的帳號（要有 super_admin 與 accountant/manager 各一）');
    return;
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_sa::text)::text, true);
  a := public.can_see_receipt('td/00000000-0000-0000-0000-000000000000/x.jpg');

  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_ot::text)::text, true);
  b := public.can_see_receipt('td/00000000-0000-0000-0000-000000000000/x.jpg');

  perform set_config('request.jwt.claims', '', true);

  v := case when a and not b then '✅ 總經理 true、會計/主管 false'
            else '❌ 總經理=' || a || '、會計或主管=' || b end;
  insert into _chk179 values (4, '★★ td/ 附件只有總經理看得到', v,
    '不擋的話會計看得到標案文件,而畫面上根本沒有標案這個選單');
end $$;

-- ④ 既有的六種 prefix 沒有被 ⑤ 的注入弄壞
do $$
declare uid_ac uuid; ok int := 0; tot int := 0; k text; v text;
begin
  select id into uid_ac from public.profiles where role = 'accountant' and active limit 1;
  if uid_ac is null then
    insert into _chk179 values (5, '★ 既有六種 prefix 沒被弄壞', '⚠ 測不出來', '找不到會計帳號');
    return;
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid_ac::text)::text, true);
  foreach k in array array['pr','exp','dep','op','dp','of'] loop
    tot := tot + 1;
    if public.can_see_receipt(k || '/00000000-0000-0000-0000-000000000000/x.jpg') then
      ok := ok + 1;
    end if;
  end loop;
  perform set_config('request.jwt.claims', '', true);
  -- ★ 「N / N 全等」比「✅」有用（規矩 6）
  v := case when ok = tot then '✅ ' || ok || ' / ' || tot || ' 會計仍看得到'
            else '❌ 只剩 ' || ok || ' / ' || tot end;
  insert into _chk179 values (5, '★ 既有六種 prefix 沒被弄壞', v,
    '注入位置錯了的話它照樣建得起來,只是把別的 prefix 一起擋掉');
end $$;

-- ⑤ 狀態約束
do $$
declare v text;
begin
  begin
    insert into public.tenders (name, status) values ('__t179', '亂填的狀態');
    v := '❌ 沒擋';
  exception when check_violation then v := '✅ 擋下未知狀態';
    when others then v := '❌ ' || sqlerrm;
  end;
  insert into _chk179 values (6, '★ 狀態只能是那六種', v, 'watching/preparing/submitted/won/lost/dropped');
end $$;

-- ⑥ 結構盤點
insert into _chk179
select 7, '表與欄位',
  case when count(*) = 3 then '✅ 3 / 3' else '❌ ' || count(*) || ' / 3' end,
  'tender_feed、tenders、attachments.tender_id'
from (
  select 1 from information_schema.tables
    where table_schema = 'public' and table_name in ('tender_feed','tenders')
  union all
  select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'attachments' and column_name = 'tender_id'
) x;

/*
 * ★★ 自檢要問**結果**不要問過程（README 9.4 #12）。
 *
 *   「唯一索引建好了嗎」用建索引時同一個條件去查,永遠會是 ✅。
 *   上面 ① 是**真的插兩筆看會不會被擋** —— 不管索引叫什麼名字、
 *   欄位怎麼組合，都逃不掉。
 */

-- ── 單一 SELECT（SQL Editor 只顯示最後一個）──────────
select item as "檢查項目", result as "結果", note as "說明"
from _chk179 order by ord, item;
