import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { validate, type Statement } from '@/lib/bank-statement';
import { planImport, matchAccount, type ExistingTxn, type AccountLike } from '@/lib/bank-import';

export const dynamic = 'force-dynamic';

/**
 * 對帳單匯入。
 *
 * ============================================================
 * 【為什麼這裡要再驗一次】
 *
 * 解析跑在瀏覽器（`lib/pdf-words.ts`），所以這支收到的是**前端算好的 JSON**。
 *
 * 不重驗的話，任何人打這個網址都能塞任意流水進資料庫 ——
 * 而銀行流水是「拿來對帳的真相」，被污染之後每一次對不上都會先懷疑別的地方。
 *
 * 重驗的成本只是三個迴圈的純算術（餘額鏈、序號、總計）。
 * 用的是**同一份 `bank-statement.ts`** —— 兩邊的規則不會分岔。
 *
 *
 * ============================================================
 * 【為什麼用呼叫者的 token 而不是 service key】
 *
 * service key 會繞過 RLS。這一頁的權限是「會計 / 主管 / 總經理」，
 * 而那條規則已經寫在 migration_142 的 policy 裡 ——
 * 再用 service key 手寫一次角色判斷，就變成兩個地方各寫一份，
 * 改一邊忘另一邊的時候不會有人發現。
 *
 * 帶著 token 走一般 client，RLS 就是唯一的真相。
 * **但 RLS 擋下的 INSERT 可能回成功且影響 0 列** ——
 * 所以底下每一次寫入都檢查回傳的列數。
 */

const CHUNK = 500;

export async function POST(req: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return NextResponse.json({ error: '伺服器設定不全' }, { status: 500 });

  const token = (req.headers.get('authorization') || '').replace('Bearer ', '');
  if (!token) return NextResponse.json({ error: '未登入' }, { status: 401 });

  const db = createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: me } = await db.auth.getUser(token);
  if (!me?.user) return NextResponse.json({ error: '登入已過期' }, { status: 401 });

  let body: { statement?: Statement; fileName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '內容不是 JSON' }, { status: 400 });
  }
  const st = body.statement;
  if (!st || !Array.isArray(st.txns)) {
    return NextResponse.json({ error: '沒有收到對帳單內容' }, { status: 400 });
  }

  // ── 1. 這份是哪個帳戶的 ──────────────────────────
  /*
   * RLS 會把不能看的帳戶擋掉,所以撈回來的就是這個人看得到的。
   * 看不到任何帳戶 = 沒有權限,不是「一個帳戶都沒建」——
   * 但兩者的訊息要分得開,不然會計會去問「為什麼帳戶不見了」。
   */
  const { data: accts, error: aErr } = await db
    .from('bank_accounts')
    .select('id, name, account_no, account_no_tail')
    .eq('active', true);
  if (aErr) return NextResponse.json({ error: `讀取帳戶失敗：${aErr.message}` }, { status: 500 });
  if (!accts || accts.length === 0) {
    return NextResponse.json({ error: '看不到任何銀行帳戶 —— 可能是權限不足' }, { status: 403 });
  }

  const m = matchAccount(st, accts as AccountLike[]);
  if (!m.ok) return NextResponse.json({ error: m.message, reason: m.reason }, { status: 400 });
  const account = m.account;

  // ── 2. 重驗 ──────────────────────────────────────
  /*
   * `block` 一項都不能有。`warn` 是「PDF 本身有瑕疵但資料完整」——
   * 例如銀行把某一格餘額印錯,而總計與期初期末都對得起來。
   *
   * warn 放行,但**一定要留痕跡**:寫進 bank_statements.warnings。
   * 將來數字對不上時,這裡是唯一查得到「當初就知道有這件事」的地方。
   */
  const problems = validate(st);
  const blocks = problems.filter((x) => x.level === 'block');
  const warns = problems.filter((x) => x.level === 'warn');
  if (blocks.length > 0) {
    return NextResponse.json(
      { error: '對帳單沒通過檢查，沒有寫入任何資料', problems: blocks },
      { status: 400 },
    );
  }
  if (!st.periodFrom || !st.periodTo) {
    return NextResponse.json({ error: 'PDF 上找不到查詢期間' }, { status: 400 });
  }

  // ── 3. 這個帳戶在這段期間已經有哪些 ──────────────
  /*
   * **Supabase 預設最多回 1000 列且不報錯** —— 分頁撈完。
   * 少撈一頁的話,那幾筆會被當成新的而重複匯入,
   * 而畫面上只會說「新增 N 筆」,看起來很正常。
   */
  const existing: ExistingTxn[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('bank_transactions')
      .select('post_date, bank_balance, txn_time')
      .eq('account_id', account.id)
      .gte('post_date', st.periodFrom)
      .lte('post_date', st.periodTo)
      .order('post_date')
      .range(from, from + 999);
    if (error) return NextResponse.json({ error: `讀取既有流水失敗：${error.message}` }, { status: 500 });
    existing.push(...((data ?? []) as ExistingTxn[]));
    if (!data || data.length < 1000) break;
  }

  const plan = planImport(account.id, st.txns, existing);

  // ── 4. 寫入 ──────────────────────────────────────
  const last = st.txns[st.txns.length - 1];
  const { data: stmt, error: sErr } = await db
    .from('bank_statements')
    .insert({
      account_id: account.id,
      period_from: st.periodFrom,
      period_to: st.periodTo,
      closing_balance: last.balance,
      total_debit: st.totalDebit,
      total_credit: st.totalCredit,
      parsed_count: st.txns.length,
      inserted_count: plan.fresh.length,
      skipped_count: plan.duplicate.length,
      warnings: warns.length > 0 ? warns.map((w) => w.message) : null,
      file_name: body.fileName ?? null,
      uploaded_by: me.user.id,
    })
    .select('id')
    .single();
  /*
   * RLS 擋下的 INSERT 回成功且影響 0 列 —— `.single()` 那時會給錯誤,
   * 但訊息是 PostgREST 的內部說法。翻成人看得懂的。
   */
  if (sErr || !stmt) {
    return NextResponse.json(
      { error: `寫入失敗（可能是權限不足）：${sErr?.message ?? '沒有回傳資料'}` },
      { status: 403 },
    );
  }

  let inserted = 0;
  for (let i = 0; i < plan.fresh.length; i += CHUNK) {
    const rows = plan.fresh.slice(i, i + CHUNK).map((t) => ({
      account_id: account.id,
      statement_id: stmt.id,
      seq: t.seq,
      txn_date: t.txnDate,
      post_date: t.postDate,
      txn_time: t.txnTime,
      description: t.description || null,
      counterparty: t.counterparty || null,
      debit: t.debit,
      credit: t.credit,
      balance: t.balance,           // 我們算的 —— 畫面顯示這個
      bank_balance: t.bankBalance,  // 銀行印的 —— 技術欄位,去重看這個
      // **只有不一樣才有備註** —— 每筆都寫的話這一欄就沒有訊號了
      balance_note: t.balanceNote,
      memo: t.memo || null, // 全形字原樣存 —— 轉半形之後跟 PDF 對不起來
      ref_no: t.refNo || null,
    }));
    const { data, error } = await db.from('bank_transactions').insert(rows).select('id');
    if (error) {
      /*
       * 寫到一半失敗:已經寫進去的那幾筆留著（它們是對的）,
       * 但要**說清楚寫了幾筆**,不然下次重傳時人不知道會不會重複。
       * 去重是靠內容不是靠批次,所以重傳是安全的 —— 訊息裡要講。
       */
      await db.from('bank_statements')
        .update({ inserted_count: inserted, note: `寫入中斷：${error.message}` })
        .eq('id', stmt.id);
      return NextResponse.json(
        {
          error: `寫入第 ${inserted + 1} 筆之後中斷：${error.message}。` +
            `已經寫進去的 ${inserted} 筆是完整的，重新上傳同一份不會重複。`,
          inserted,
        },
        { status: 500 },
      );
    }
    inserted += data?.length ?? 0;
  }

  if (inserted !== plan.fresh.length) {
    await db.from('bank_statements')
      .update({ inserted_count: inserted, note: `預期 ${plan.fresh.length} 筆，實際 ${inserted} 筆` })
      .eq('id', stmt.id);
  }

  return NextResponse.json({
    ok: true,
    statementId: stmt.id,
    account: { id: account.id, name: account.name },
    period: { from: st.periodFrom, to: st.periodTo },
    parsed: st.txns.length,
    inserted,
    duplicate: plan.duplicate.length,
    selfDuplicate: plan.selfDuplicate.length,
    closingBalance: last.balance,
    warnings: warns.map((w) => w.message),
  });
}
