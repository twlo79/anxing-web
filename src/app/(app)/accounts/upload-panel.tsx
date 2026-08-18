'use client';
import { useCallback, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { pdfToWords, looksCombined, describeWords, PDF_COMBINED_MESSAGE } from '@/lib/pdf-words';
import { parseStatement, validate, type Statement } from '@/lib/bank-statement';

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
  /** 空陣列才可以匯入。 */
  problems: { code: string; message: string }[];
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

        if (problems.length > 0 && st.txns.length === 0) {
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
      if (r.problems.length > 0) continue;
      try {
        const res = await fetch('/api/bank-statements/import', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ statement: r.statement, fileName: r.file }),
        });
        const j = await res.json();
        if (!res.ok) {
          out.push({ file: r.file, ok: false, text: j.error ?? `失敗（${res.status}）` });
          continue;
        }
        out.push({
          file: r.file,
          ok: true,
          text:
            `${j.account.name}　${j.period.from} ~ ${j.period.to}　` +
            `新增 ${j.inserted} 筆、重複 ${j.duplicate} 筆　餘額 ${money(j.closingBalance)}`,
        });
      } catch (e) {
        out.push({ file: r.file, ok: false, text: (e as Error).message });
      }
    }
    setResults(out);
    setReady([]);
    setSending(false);
    const good = out.filter((o) => o.ok).length;
    if (good > 0) await onDone(`匯入完成：${good} 份對帳單`);
  }, [ready, onDone]);

  const canSend = ready.length > 0 && ready.every((r) => r.problems.length === 0);
  const blocked = ready.filter((r) => r.problems.length > 0);

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
            const bad = r.problems.length > 0;
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
                {!bad && last && (
                  <div className="mt-0.5 text-gray-600">
                    期末餘額 <span className="font-medium">{money(last.balance)}</span>
                    {'　'}
                    支出 {money(st.totalDebit ?? 0)}　存入 {money(st.totalCredit ?? 0)}
                  </div>
                )}
                {r.problems.map((p) => (
                  <div key={p.code} className="mt-1 text-red-600">
                    ✕ {p.message}
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
          <button
            onClick={send}
            disabled={!canSend || sending}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300"
          >
            {sending ? '匯入中⋯' : `確認匯入${ready.length ? `（${ready.length} 份）` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
