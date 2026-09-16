/*
 * 查-14B4的那一位客戶.sql　2026-09-16
 *
 * 【為什麼查這個】
 * 刪-房源14B4.sql 被擋下來了，擋住的是一列：
 *
 *     外鍵 customers.property_id　1 列指著 14B4・ON DELETE SET NULL
 *
 * ══════════════════════════════════════════════════════════
 * ★★★ 先講清楚這條外鍵**不會**造成的事：
 *   `ON DELETE SET NULL` —— 刪掉房源**不會刪掉那位客戶**，
 *   只會把他的 `property_id` 變成 null。客戶還在、備註還在。
 *
 * ★★ 那為什麼還是擋下來？因為腳本不知道那是誰。
 *   `customers` 是 `sync_customers()` 覆蓋的彙整檔，但
 *   **電話、Email、備註是人手動填的，同步永遠不動**
 *   （customers/page.tsx 的檔頭寫著）。
 *   那三欄如果有東西，它就不只是一列垃圾資料。
 *
 * ★ 而且 14B4 的訂單 0 筆、契約 0 張 —— 那這位客戶**當初是怎麼來的**？
 *   十之八九是 `stale`（來源已不存在）。但「十之八九」不是答案。
 * ══════════════════════════════════════════════════════════
 *
 * 【這支只讀不寫】跑幾次都一樣。把整列貼回來，我再給下一步。
 */

select
  c.name                                   as "客戶名",
  c.property_label                         as "房源（文字）",
  coalesce(c.stay_from, '—') || ' ~ ' || coalesce(c.stay_to, '—') as "住宿起訖",
  c.stay_count                             as "住過幾次",
  coalesce(c.src_kind, '（沒有來源）')       as "來源",
  case when c.stale then '⚠ 來源已不存在' else '有對到來源' end as "對得到嗎",

  /* ── 人手動填的三欄。同步不會動它們，所以這三欄才是「會不會弄丟東西」 ── */
  coalesce(c.phone, '')                    as "電話",
  coalesce(c.email, '')                    as "Email",
  coalesce(c.note, '')                     as "備註",

  case
    when coalesce(c.phone, '') = ''
     and coalesce(c.email, '') = ''
     and coalesce(c.note,  '') = ''
      then '✅ 三欄都是空的 —— 沒有人工資料會被弄丟'
    else '⚠ 有人手動填過東西 —— 刪房源不會弄丟它（SET NULL），但先看一眼是誰'
  end                                      as "判定：人工資料",

  /*
   * ★ 這位客戶名下到底有沒有單。`customers` 是彙整檔,
   *   它自己說的話不能當證據 —— 直接去 orders／contracts 數一次。
   *   （2026-09-03 踩過:判定照程式碼寫、沒拿同一列的資料對。）
   */
  (select count(*) from public.orders o
     where o.guest_name = c.name)          as "同名的訂單數",
  (select count(*) from public.contracts t
     where coalesce(t.display_name, t.tenant_name) = c.name) as "同名的契約數",

  c.id                                     as "customers.id"

from public.customers c
where c.property_id = '34b1c39b-e0f7-42fe-9a63-6e2ff5b9ab87';
