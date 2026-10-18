/*
 * 一次性：舊折讓的「原因」搬到新的「備註」（2026-10-18）
 *
 * 【為什麼】改版前折讓視窗的「原因(選填)」是接在訂單 note 的算式後面：
 *     契約折讓・原應收 $2,040,000 − 本次折讓 $18,000 = $2,022,000・<原因>
 *   新版的「備註」存在 item_name，列表顯示備註取代「折讓」。舊的原因還在算式尾巴，列表讀不到。
 *
 * 【這支做什麼】只動 fee_type = '折讓'、item_name 還是空的、note 尾巴有「・原因」的那幾筆：
 *   · 把「・」後面那段複製到 item_name（note 原封不動，算式照留）
 *   · 沒填過原因的不動 —— 列表照舊顯示「折讓」
 *   · 重跑安全：已經有 item_name 的不會再改
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 */

begin;

update public.orders
   set item_name = btrim(substring(note from '= \$[0-9,]+・(.+)$'))
 where fee_type = '折讓'
   and coalesce(btrim(item_name), '') = ''
   and note ~ '^契約折讓・原應收 .*= \$[0-9,]+・.+$';

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select 1 as 序, '有備註的折讓' as 項目,
       count(*)::text || ' 筆' as 結果,
       coalesce(string_agg(item_name || ' −$' || to_char(abs(amount), 'FM999,999,990'), '；'), '（沒有）') as 明細
  from public.orders where fee_type = '折讓' and coalesce(btrim(item_name), '') <> ''
union all
select 2, '沒有備註的折讓（照舊顯示「折讓」）',
       count(*)::text || ' 筆',
       coalesce(string_agg(checkin::text || ' −$' || to_char(abs(amount), 'FM999,999,990'), '；'), '（沒有）')
  from public.orders where fee_type = '折讓' and coalesce(btrim(item_name), '') = ''
order by 1;
