'use client';
import { useCallback, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { pdfToWords, looksCombined, describeWords, PDF_COMBINED_MESSAGE } from '@/lib/pdf-words';
import { parseStatement, validate, isEmptyPeriod, type Statement, type Problem } from '@/lib/bank-statement';

/**
 * 上傳對帳單。
 *
 * ============================================================
 * 【流程：丟檔案 → 認帳號 → 驗 → 預覽 → 確認】
 *
 * 使用者指定（2026-08-18）：「不用選帳號，直接讀 PDF，裡面也有帳號。」
 *
 * PDF 裡就有「帳號元大中崙-綜合活期-20992000170564」——
 * **已經知道答案的事情不要問**。讓人選再驗，只是多開一個出錯的地方。
 *
 * 順帶多一件事變得可行：**一次拖三份進來**，各自認各自的帳戶。
 * 要人選的話這做不到，因為三份要選三次。
 *
 *
 * ============================================================
 * 【解析在瀏覽器，但寫入前後端都要驗】
 *
 * 這裡驗一次是為了「當場看得到」——不用等上傳來回。
 * 後端 `/api/bank-statements/import` 用**同一份 `bank-statement.ts`**
 * 再驗一次，因為它收到的是這裡算好的 JSON，不能無條件相信。
 *
 *
 * ============================================================
 * 【驗不過就整份不讀】
 *
 * 沒有「警告但仍可匯入」。三份真實對帳單全部一次通過 ——
 * 所以沒過就代表解析器真的錯了，不是資料本身有瑕疵。
 * 放行只會讓錯的流水進資料庫，而餘額歪掉是慢慢地、不報錯地發生。
 */

type Ready = {
  file: string;
  statement: Statement;
  /** `block` 一項都不能有才匯得進去；`warn` 會顯示但仍可匯。 */
  problems: Problem[];
};
type Failed = { file: string; error: string; detail?: string };
type Result = { file: string; text: string; ok: boolean };

const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

export default function UploadPanel({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (text: string) => Promise<void> | void;
}) {
  const [reading, setReading] = useState(false);
  const [ready, setReady] = useState<Ready[]>([]);
  const [failed, setFailed] = useState<Failed[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const read = useCallback(async (files: File[]) => {
    setReading(true);
    setResults([]);
    const ok: Ready[] = [];
    const bad: Failed[] = [];
    for (const f of files) {
      try {
        const words = await pdfToWords(await f.arrayBuffer());
        if (words.length === 0) {
          // 掃描的 PDF 抽不到文字。硬解析只會得到 0 筆而看不出原因
          bad.push({ file: f.name, error: '這份 PDF 抽不到文字 —— 是掃描檔嗎？請用網銀下載的原始檔。' });
          continue;
        }

        /*
         * 【先解析，再解釋】（2026-08-18 修正）
         *
         * 第一版先檢查「有沒有黏成一塊」再解析，結果擋掉了一份好好的 PDF：
         * 抬頭的「列印日期時間：2026/08/07 11:53:01」被當成兩個數字黏在一起。
         *
         * 能不能解析出正確的數字，答案在 validate() ——
         * 不在文字長相上。所以現在先跑，跑不出來才問為什麼。
         */
        const st = parseStatement(words);
        const problems = validate(st);

        /*
         * ★★★ 0 筆有兩種（2026-09-04 使用者:「當 0 筆內容時 只更新日期」）:
         *
         *   這段期間真的沒有交易 → **好的對帳單**，照樣讓它進來
         *   版面不認得           → 才是失敗
         *
         * 分辨在 `isEmptyPeriod`:表頭認得 ＋ 銀行印的總計是 0／0。
         * 不分的話，只要查一段沒有進出的期間，系統就說「版面可能改了」——
         * 而那句話是假的，PDF 是好的，壞的是這個判斷。
         */
        if (st.txns.length === 0 && !isEmptyPeriod(st)) {
          bad.push({
            file: f.name,
            error: looksCombined(words)
              ? PDF_COMBINED_MESSAGE
              : '解析不出交易明細 —— 版面可能跟已知的元大格式不同。',
            // 把原始輸出印出來:是抽不到文字、欄位換位置、還是整列黏在一起,
            // 三種的處理方式完全不同,而分辨它們只需要看幾行
            detail: describeWords(words),
          });
          continue;
        }
        ok.push({ file: f.name, statement: st, problems });
      } catch (e) {
        bad.push({ file: f.name, error: (e as Error).message });
      }
    }
    setReady(ok);
    setFailed(bad);
    setReading(false);
  }, []);

  const send = useCallback(async () => {
    setSending(true);
    const supabase = createClient();
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token ?? '';
    const out: Result[] = [];

    for (const r of ready) {
      if (isBlocked(r)) continue;
      try {
        const res = await fetch('/api/bank-statements/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ statement: r.statement, fileName: r.file }),
        });
        /*
         * ★★★ **不要直接 `res.json()`**（2026-09-10）。
         *
         *   伺服器掛掉時 Next 回的是**純文字** `Internal Server Error`，
         *   而 `res.json()` 會丟一個解析錯誤 —— 畫面顯示
         *   「Unexpected token 'I', "Internal S"... is not valid JSON」。
         *
         * ★★ 那句話跟真正的錯完全無關，而它**蓋掉了唯一的線索**:
         *   HTTP 狀態碼、以及伺服器那句純文字。
         *   使用者看到那句只會以為是 PDF 有問題。
         *
         * ★ 先收成文字再試著解析。不是 JSON 就把狀態碼與前 200 字印出來 ——
         *   看不懂沒關係，那是可以整句貼給人看的東西。
         */
        const raw = await res.text();
        let j: any = null;
        try { j = raw ? JSON.parse(raw) : null; } catch { /* 不是 JSON，往下走 */ }

        if (!res.ok || j == null) {
          const text = j?.error
            ?? (raw
              ? `伺服器回了 ${res.status}：${raw.slice(0, 200)}`
              : `失敗（${res.status}，伺服器沒有回任何內容）`);
          out.push({ file: r.file, ok: false, text });
          continue;
        }
        out.push({
          file: r.file,
          ok: true,
          /*
            0 筆的時候不要印「新增 0 筆、重複 0 筆」—— 那讀起來像沒做事。
            實際上做了一件事:對帳日期往前推了。**就寫那件事。**

            餘額印「維持」而不是印一個新數字，因為它不是這份 PDF 說的，
            是上一份接過來的。沒有上一份就整個不印（`money(null)` 會是 $NaN）。
          */
          text: j.empty
            ? `${j.account.name}　${j.period.from} ~ ${j.period.to}　` +
              '沒有交易 —— 只更新對帳日期' +
              (j.closingBalance == null ? '' : `　餘額維持 ${money(j.closingBalance)}`)
            : `${j.account.name}　${j.period.from} ~ ${j.period.to}　` +
              `新增 ${j.inserted} 筆、重複 ${j.duplicate} 筆　餘額 ${money(j.closingBalance)}`,
        });
      } catch (e) {
        out.push({ file: r.file, ok: false, text: (e as Error).message });
      }
    }
    setResults(out);
    setReady([]);
    setSending(false);

    const good = out.filter((o) => o.ok);
    const bad = out.filter((o) => !o.ok);

    /*
     * ★★★ 全部成功就**關掉面板**（2026-09-10 使用者:
     *   「步驟錯誤，按匯入才能匯入，然後跳出啊」）。
     *
     *   原本匯入完成之後面板照樣開著，而「確認匯入」那顆鈕還在 ——
     *   使用者看到的是「我按了、跑完了、但畫面沒有結束」，
     *   於是不確定到底成功了沒，也不知道還該不該再按一次。
     *
     * ★★ 摘要帶到頁面上的訊息列，**不要留在面板裡**:
     *   面板關掉之後底下那張帳戶卡的餘額與筆數已經更新，
     *   那才是他真正要看的東西。留在面板裡等於逼他自己關掉才看得到結果。
     *
     * ★ 有失敗的就**不關** —— 那幾筆的原因只有這裡看得到，
     *   關掉就等於把唯一的線索丟掉。
     */
    if (good.length > 0) {
      await onDone(
        bad.length === 0
          ? `匯入完成：${good.map((g) => g.text).join('；')}`
          : `匯入完成 ${good.length} 份，${bad.length} 份失敗 —— 失敗的原因在上傳視窗裡`,
      );
    }
    if (bad.length === 0 && good.length > 0) onClose();
  }, [ready, onDone, onClose]);

  const isBlocked = (r: Ready) => r.problems.some((p) => p.level === 'block');
  const canSend = ready.length > 0 && !ready.some(isBlocked);
  const blocked = ready.filter(isBlocked);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="w-full max-w-2xl rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="font-semibold">上傳對帳單</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="關閉">
            ✕
          </button>
        </div>

        <div className="space-y-3 p-4">
          {/* ── 拖放區 ─────────────────────────── */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const fs = [...e.dataTransfer.files].filter((f) => f.name.toLowerCase().endsWith('.pdf'));
              if (fs.length) read(fs);
            }}
            onClick={() => inputRef.current?.click()}
            className="cursor-pointer rounded-lg border-2 border-dashed px-4 py-8 text-center text-sm text-gray-500 hover:border-blue-400 hover:bg-blue-50/40"
          >
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf"
              multiple
              className="hidden"
              onChange={(e) => {
                const fs = [...(e.target.files ?? [])];
                if (fs.length) read(fs);
                e.target.value = '';
              }}
            />
            {reading ? (
              '解析中⋯'
            ) : (
              <>
                <div className="text-base">把對帳單 PDF 拖進來</div>
                <div className="mt-1 text-xs">
                  可以一次多份 —— 系統會從 PDF 裡讀帳號，自己分到對的帳戶
                </div>
                <div className="mt-1 text-xs text-gray-400">
                  檔案不會上傳，解析在你的電腦上做
                </div>
              </>
            )}
          </div>

          {/* ── 讀不進去的 ─────────────────────── */}
          {failed.map((f) => (
            <div key={f.file} className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm">
              <div className="font-medium text-red-700">{f.file}</div>
              <div className="text-red-600">{f.error}</div>
              {f.detail && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-red-500">
                    看 PDF 實際讀到什麼（給工程師）
                  </summary>
                  <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-white/70 p-2 text-[11px] text-gray-700">
                    {f.detail}
                  </pre>
                </details>
              )}
            </div>
          ))}

          {/* ── 預覽 ───────────────────────────── */}
          {ready.map((r) => {
            const st = r.statement;
            const bad = isBlocked(r);
            const last = st.txns[st.txns.length - 1];
            return (
              <div
                key={r.file}
                className={`rounded-md border px-3 py-2 text-sm ${
                  bad ? 'border-red-200 bg-red-50' : 'border-gray-200'
                }`}
              >
                <div className="font-medium">{r.file}</div>
                <div className="mt-0.5 text-gray-600">
                  {/* 認到的帳號一定要印出來 —— 對錯都要看得見 */}
                  帳號 {st.accountNo ?? '（讀不到）'}
                  {'　'}
                  {st.periodFrom} ~ {st.periodTo}　{st.txns.length} 筆
                </div>
                {/*
                  0 筆而且通過檢查 = 這段期間銀行說沒有任何進出。
                  **要寫出「按下去會發生什麼事」** —— 只顯示「0 筆」的話，
                  人不知道確認到底有沒有用，多半就不按了。
                */}
                {!bad && !last && (
                  <div className="mt-0.5 text-blue-700">
                    這段期間沒有交易 —— 匯入只會把對帳日期更新到 {st.periodTo}，餘額不變。
                  </div>
                )}
                {!bad && last && (
                  <div className="mt-0.5 text-gray-600">
                    期末餘額 <span className="font-medium">{money(last.balance)}</span>
                    {'　'}
                    支出 {money(st.totalDebit ?? 0)}　存入 {money(st.totalCredit ?? 0)}
                  </div>
                )}
                {r.problems.map((p) => (
                  <div
                    key={p.code}
                    className={`mt-1 ${p.level === 'block' ? 'text-red-600' : 'text-amber-700'}`}
                  >
                    {p.level === 'block' ? '✕' : '⚠'} {p.message}
                  </div>
                ))}
              </div>
            );
          })}

          {blocked.length > 0 && (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              有 {blocked.length} 份沒通過檢查。
              <b>整批都不會匯入</b> —— 先把那幾份查清楚，比匯進一半再回頭找容易。
            </div>
          )}

          {/* ── 匯入結果 ───────────────────────── */}
          {results.map((r) => (
            <div
              key={r.file}
              className={`rounded-md border px-3 py-2 text-sm ${
                r.ok ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'
              }`}
            >
              <div className="font-medium">{r.ok ? '✓' : '✕'} {r.file}</div>
              <div className={r.ok ? 'text-gray-700' : 'text-red-600'}>{r.text}</div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          <button onClick={onClose} className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50">
            關閉
          </button>
          {/*
            ★★ 灰掉的按鈕要說得出為什麼（CLAUDE.md）。
              「確認匯入」在沒有檔案、或有檔案沒過檢查時都是灰的，
              而那是兩件完全不同的事 —— 不講的話使用者只看到一顆壞掉的鈕。
          */}
          <button
            onClick={send}
            disabled={!canSend || sending}
            title={
              sending ? '匯入中⋯'
                : ready.length === 0 ? '還沒有可以匯入的檔案 —— 把 PDF 拖進上面那一格'
                  : blocked.length > 0 ? `有 ${blocked.length} 份沒通過檢查，整批都不會匯入`
                    : ''
            }
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300"
          >
            {sending ? '匯入中⋯' : `確認匯入${ready.length ? `（${ready.length} 份）` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
