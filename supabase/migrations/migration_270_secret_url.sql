/*
 * migration_270_secret_url.sql　2026-09-17
 * 帳密多一個「網址」欄
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *          ★★ migration_262 與 269 要先跑完（你 2026-09-17 都跑了）。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-17：「參考這個來做 密碼管理」＋ ❶「要」】
 *
 * Google 密碼管理每一筆有一欄 Sites。我們現在只能把網址塞進備註，
 * 而備註是一段文字 —— **點不開**，也搜不準。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼存的是「www.airbnb.com.tw」不是完整網址】
 *
 * 使用者填的多半是沒有協定的那種。前端 `secretHref()` 會補上 https://
 * （lib/board.ts，有測試）——**不要在資料庫這一層補**:
 *
 *   · 資料庫補的話，使用者在畫面上看到的字跟他打進去的不一樣
 *   · 而且真的需要 http:// 的內網位址會被改掉
 *
 * ★ 所以這裡存原樣，顯示與開啟那一層各自處理。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 回填只動「現在是空的」那幾列】
 *
 * `where coalesce(url,'') = ''` —— 人已經填過的一律不碰。
 * 沒有這個條件的話，重跑一次會把他改過的網址蓋回我寫死的這一份。
 *
 * ★ 對不到標題的就跳過（`where exists` 那一層由 update…from 自然處理）。
 *   對不到不是錯 —— 使用者可能把某一筆改名了。
 *
 * ══════════════════════════════════════════════════════════
 * 【跑兩次結果一樣】回填帶「現在是空的」條件，第二次影響 0 列。
 * ══════════════════════════════════════════════════════════
 */

begin;

alter table public.board_secrets
  add column if not exists url text;

comment on column public.board_secrets.url is
  '這個帳號在哪裡登入。存使用者打的原樣(常常沒有 https://)。'
  '★ 補協定是前端 lib/board.ts 的 secretHref() 在做 —— 資料庫不要補:'
  '補了之後畫面上的字跟他打進去的不一樣,而且內網的 http:// 會被改掉。';

/*
 * 回填。★ 這一份是**一次性的**:新增的那幾筆自己填就好，
 *   不要把它做成一張對照表留在資料庫裡（那會變成第二個要維護的地方）。
 */
with seed(title, url) as (values
  ('訂房｜Airbnb',              'www.airbnb.com.tw'),
  ('訂房｜Agoda',               'www.agoda.com'),
  ('訂房｜VRBO',                'www.vrbo.com'),
  ('社群｜安幸 FB',             'www.facebook.com'),
  ('社群｜安幸 IG',             'www.instagram.com'),
  ('社群｜正隆官邸 FB',         'www.facebook.com'),
  ('社群｜正隆官邸 IG',         'www.instagram.com'),
  ('社群｜時兆 IG',             'www.instagram.com'),
  ('帳號｜justwork',            'mail.google.com'),
  ('帳號｜安幸',                'mail.google.com'),
  ('帳號｜正隆官邸 Google',     'mail.google.com'),
  ('帳號｜公司信箱（Zoho）',    'mail.zoho.com'),
  ('帳號｜Apple ID',            'appleid.apple.com'),
  ('帳號｜ring',                'account.ring.com'),
  ('電商｜蝦皮',                'shopee.tw'),
  ('電商｜酷澎',                'www.tw.coupang.com'),
  ('電商｜IKEA 企業卡',         'www.ikea.com.tw'),
  ('物流｜DHL',                 'www.dhl.com'),
  ('物流｜EZ WAY',              'www.ezway.com.tw'),
  ('財稅｜綠界電子發票',        'www.ecpay.com.tw'),
  ('財稅｜電子發票整合平台',    'www.einvoice.nat.gov.tw'),
  ('財稅｜工商憑證',            'moeaca.nat.gov.tw'),
  ('其他｜591 會員',            'www.591.com.tw')
)
update public.board_secrets b
   set url = seed.url
  from seed
 where b.title = seed.title
   and coalesce(b.url, '') = '';          -- ★ 人填過的不碰

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('270_secret_url');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
--
-- ★★★ **不印任何密碼**（跟 269 同一個理由:這張表的輸出會被複製到別的地方）。
-- ══════════════════════════════════════════════════════════

with s as (
  select title, account, secret, url, note,
         /* ★ 全形｜。半形 | 在網址與密碼裡出現的機率高得多（lib/board.ts 同一條規則） */
         case when position('｜' in title) > 0
              then split_part(title, '｜', 1) else '' end as cat
    from public.board_secrets
),
gap as (
  select string_agg(g::text, '　' order by g) as miss
    from generate_series(200, 270) g
   where not exists (select 1 from public.schema_migrations m
                      where split_part(m.name, '_', 1) = g::text)
)

select * from (

  select 1 as ord, '① 欄位加好了沒' as "檢查",
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public'      -- ★ 一定要帶（README）
                              and table_name = 'board_secrets' and column_name = 'url')
              then 'url ✅' else 'url ❌' end as "結果",
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public'
                              and table_name = 'board_secrets' and column_name = 'url')
              then '✅' else '❌ 沒加到 —— 下面全部不算數' end as "判定"

  union all
  select 2, '② 母體：帳密共幾列',
         (select count(*)::text from s) || ' 列',
         case when (select count(*) from s) = 0
              then '⚠ **一列都沒有 —— 下面全部不算數**'
              else '參考' end

  union all
  /*
   * ★★★ 這一列是這支的目的。但**不是「越多越好」**——
   *   統編、公司電話、WiFi 那幾筆本來就沒有網址。
   *   所以判定要看「該有的有沒有」，不是數量。
   */
  select 3, '③ 填到幾筆網址',
         (select count(*) filter (where coalesce(btrim(url), '') <> '') from s)::text
         || ' 筆有網址　│ 沒有的 '
         || (select count(*) filter (where coalesce(btrim(url), '') = '') from s)::text || ' 筆',
         case when (select count(*) from s) = 0 then '⚠ 母體是空的,不算數'
              when (select count(*) filter (where coalesce(btrim(url), '') <> '') from s) = 0
              then '❌ 一筆都沒填到 —— 標題對不上（有人改過名字？）'
              else '✅ 沒有網址的多半是公司資料那幾筆（統編、電話、WiFi），那是對的' end

  union all
  /*
   * ★★ 哪幾筆沒有網址。**列出來**而不是只給一個數字 ——
   *   數字看不出「該有卻沒有」跟「本來就不該有」的差別。
   */
  select 4, '④ 沒有網址的是哪幾筆',
         coalesce((select string_agg(title, E'\n' order by title)
                     from s where coalesce(btrim(url), '') = ''), '（都有）'),
         '參考 —— 裡面該有網址的自己在畫面上補'

  union all
  /*
   * ★★★ 標題的格式。前端照全形｜切類別，切不到的會掉進「未分類」，
   *   排在最後面 —— 那不是壞掉，但要看得到有幾筆。
   */
  select 5, '⑤ 標題有沒有照「類別｜名稱」',
         (select count(*) filter (where cat <> '') from s)::text || ' 筆有類別　│ 未分類 '
         || (select count(*) filter (where cat = '') from s)::text || ' 筆'
         || coalesce((select '：' || string_agg(title, '　') from s where cat = ''), ''),
         case when (select count(*) from s) = 0 then '⚠ 母體是空的,不算數'
              when (select count(*) filter (where cat = '') from s) > 0
              then '⚠ 未分類的會排在清單最後面 —— 要歸類的話在畫面上改標題'
              else '✅ 每一筆都有類別' end

  union all
  /*
   * ★★ 類別有沒有打錯字。前端只認得這八個，別的會被歸到
   *   「不認得」那一群（排在已知後面、未分類前面）。
   */
  select 6, '⑥ 類別有沒有前端不認得的',
         coalesce((select string_agg(distinct cat, '　' order by cat) from s
                    where cat <> '' and cat not in
                      ('訂房','社群','帳號','電商','物流','財稅','其他','公司資料')),
                  '（沒有）'),
         case when exists (select 1 from s where cat <> '' and cat not in
                            ('訂房','社群','帳號','電商','物流','財稅','其他','公司資料'))
              then '⚠ 上面那幾個前端不認得（可能是多一個空白）——'
                   || '它們會排在已知類別的後面,而畫面上看不出為什麼'
              else '✅ 全部都是那八類' end

  union all
  select 7, '⑦ 200～270 之間還缺哪幾號',
         coalesce((select miss from gap), '（沒有缺）'),
         case when (select miss from gap) is null then '✅ 一號都沒缺'
              else '⚠ 還缺：' || (select miss from gap) end

  union all
  select 8, '⑧ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '270_secret_url'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '270_secret_url')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
