'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createClient } from '@/lib/supabase';
import { softDelete } from '@/lib/trash';
import {
  DOC_KINDS, DOC_PARENT_COL, type DocKind, type DocParent, type ContractDoc, docPath, contractDocError,
  defaultDocKind, sortDocs, fmtSize,
} from '@/lib/contract-docs';

/*
 * ══════════════════════════════════════════════════════════
 * 契約文件（PDF）—— migration_324，2026-10-08 David 過審
 *
 *   <ContractDocs>        編輯契約／訂單最下面的那一區：列表、上傳、預覽、刪除
 *                         parent='ct' 契約（contract_id）、'od' 訂單（order_doc_id，migration_325）
 *   <ContractDocIcon>     契約列表與客戶頁：租戶名後面的文件圖示，點了直接預覽
 *   <ContractDocPreview>  預覽視窗（瀏覽器內建 PDF 檢視器），好幾份時上方可以切換
 *
 * ★ 檔案在 receipts bucket（私有），看要換簽名網址，一小時有效 —— 跟憑證同一套。
 * ★ 誰看得到由呼叫端用 canSeeContractDocs() 決定；資料庫那層是 can_see_receipt。
 * ══════════════════════════════════════════════════════════
 */

const BUCKET = 'receipts';
export async function loadContractDocs(supabase: ReturnType<typeof createClient>, parentId: string,
  parent: DocParent = 'ct'): Promise<ContractDoc[]> {
  const col = DOC_PARENT_COL[parent];
  const { data } = await supabase.from('attachments')
    .select(`id, parent_id:${col}, path, file_name, doc_kind, size_bytes, created_at`).eq(col, parentId);
  return sortDocs((data ?? []) as unknown as ContractDoc[]);
}

/* ══════ 預覽 ══════ */
export function ContractDocPreview({ docs, startId, title, onClose }: {
  docs: ContractDoc[]; startId?: string; title?: string; onClose: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [cur, setCur] = useState<string>(startId ?? docs[0]?.id ?? '');
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const doc = docs.find((d) => d.id === cur) ?? docs[0];

  useEffect(() => {
    if (!doc) return;
    let live = true;
    setUrl(null); setErr('');
    supabase.storage.from(BUCKET).createSignedUrl(doc.path, 3600).then(({ data, error }) => {
      if (!live) return;
      if (error || !data?.signedUrl) setErr('打不開這份文件：' + (error?.message ?? '沒有拿到網址'));
      else setUrl(data.signedUrl);
    });
    return () => { live = false; };
  }, [supabase, doc]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  if (!doc || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-3 md:p-6" onClick={(e) => e.stopPropagation()}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-4xl h-[90vh] flex flex-col">
        <div className="px-4 py-2.5 border-b border-mor-line flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-medium truncate">{doc.file_name ?? '契約文件'}</div>
            {title && <div className="text-xs text-gray-400 truncate">{title}</div>}
          </div>
          {url && <>
            <a href={url} download={doc.file_name ?? undefined} className="text-xs text-mor-slate hover:underline shrink-0">下載</a>
            <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs text-mor-slate hover:underline shrink-0">新分頁</a>
          </>}
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none shrink-0" aria-label="關閉">✕</button>
        </div>
        {docs.length > 1 && (
          <div className="px-4 py-2 border-b border-mor-line flex gap-1.5 overflow-x-auto">
            {docs.map((d) => (
              <button key={d.id} onClick={() => setCur(d.id)}
                className={`shrink-0 rounded-md border px-2.5 py-1 text-xs ${d.id === doc.id
                  ? 'border-mor-slate bg-mor-bluelight text-mor-slate' : 'border-mor-line text-gray-600 hover:bg-mor-sand/50'}`}>
                {d.doc_kind ?? '其他'}・{d.created_at.slice(0, 10)}
              </button>
            ))}
          </div>
        )}
        <div className="flex-1 min-h-0 bg-mor-sand/40 rounded-b-xl overflow-hidden">
          {err ? <div className="p-6 text-sm text-red-600">{err}</div>
            : url ? <iframe src={url} title={doc.file_name ?? '契約文件'} className="w-full h-full border-0" />
              : <div className="p-6 text-sm text-gray-400">載入中…</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ══════ 列表上的圖示 ══════ */
export function ContractDocIcon({ parentId, parent = 'ct', count, title }: {
  parentId: string; parent?: DocParent; count: number; title?: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [docs, setDocs] = useState<ContractDoc[] | null>(null);
  if (!(count > 0)) return null;
  const open = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setDocs(await loadContractDocs(supabase, parentId, parent));
  };
  return (
    <>
      <button onClick={open} title={parent === 'od' ? '預覽合約' : '預覽契約文件'} aria-label="預覽文件"
        className="ml-1 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 align-middle text-mor-slate hover:bg-mor-bluelight">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
          <path d="M9 13h6" /><path d="M9 17h6" />
        </svg>
        {count > 1 && <span className="text-[10px] tabular-nums">{count}</span>}
      </button>
      {docs && docs.length > 0 && <ContractDocPreview docs={docs} title={title} onClose={() => setDocs(null)} />}
    </>
  );
}

/* ══════ 編輯契約裡的那一區 ══════ */
export default function ContractDocs({ parentId, parent = 'ct', canEdit, title, onCount }: {
  parentId: string | null; parent?: DocParent; canEdit: boolean; title?: string; onCount?: (n: number) => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [docs, setDocs] = useState<ContractDoc[]>([]);
  const [kind, setKind] = useState<DocKind>('原約');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [drag, setDrag] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!parentId) { setDocs([]); return; }
    const d = await loadContractDocs(supabase, parentId, parent);
    setDocs(d); setKind(defaultDocKind(d)); onCount?.(d.length);
  }, [supabase, parentId, parent, onCount]);
  useEffect(() => { load(); }, [load]);

  const upload = async (files: FileList | File[] | null) => {
    if (!parentId || !files) return;
    const list = Array.from(files);
    if (!list.length) return;
    setErr('');
    for (const f of list) { const e = contractDocError(f); if (e) return setErr(e); }
    setBusy(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      for (const f of list) {
        const path = docPath(parentId, crypto.randomUUID(), parent);
        const { error: ue } = await supabase.storage.from(BUCKET).upload(path, f, { contentType: 'application/pdf', upsert: false });
        if (ue) return setErr(`「${f.name}」上傳失敗：${ue.message}`);
        const { error: ie } = await supabase.from('attachments').insert({
          [DOC_PARENT_COL[parent]]: parentId, path, file_name: f.name, mime_type: 'application/pdf',
          size_bytes: f.size, uploaded_by: u.user?.id ?? null, doc_kind: kind,
        });
        if (ie) {
          // 檔案傳上去但登記失敗 → 刪掉，不留沒人認領的檔案
          await supabase.storage.from(BUCKET).remove([path]);
          return setErr(`「${f.name}」登記失敗：${ie.message}`);
        }
      }
      await load();
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (d: ContractDoc) => {
    if (!confirm(`刪除「${d.file_name ?? '這份文件'}」？\n\n會移到回收桶，可以復原。`)) return;
    setBusy(true); setErr('');
    const r = await softDelete(supabase, 'attachments', d.id);
    setBusy(false);
    if (!r.ok) return setErr(r.message);
    load();
  };

  const setDocKind = async (d: ContractDoc, k: DocKind) => {
    const { error } = await supabase.from('attachments').update({ doc_kind: k }).eq('id', d.id);
    if (error) return setErr('改類型失敗：' + error.message);
    load();
  };

  if (!parentId) {
    return <div className="col-span-2 text-xs text-gray-400">{parent === 'od' ? '訂單' : '契約'}存檔後才能上傳文件。</div>;
  }

  return (
    <div className="col-span-2">
      {docs.length > 0 && (
        <div className="divide-y divide-mor-line/60">
          {docs.map((d) => (
            <div key={d.id} className="flex items-center gap-2.5 py-2 text-sm">
              <span className="shrink-0 rounded bg-red-50 text-red-600 text-[10px] font-bold px-1.5 py-1">PDF</span>
              <div className="min-w-0 flex-1">
                <div className="truncate">{d.file_name ?? '契約文件'}</div>
                <div className="text-[11px] text-gray-400 flex items-center gap-1.5">
                  {canEdit ? (
                    <select value={d.doc_kind ?? '其他'} onChange={(e) => setDocKind(d, e.target.value as DocKind)}
                      className="rounded border border-mor-line bg-white px-1 py-0 text-[11px] text-mor-slate">
                      {DOC_KINDS.map((k) => <option key={k}>{k}</option>)}
                    </select>
                  ) : <span className="text-mor-slate">{d.doc_kind ?? '其他'}</span>}
                  <span>{d.created_at.slice(0, 10)} 上傳・{fmtSize(d.size_bytes)}</span>
                </div>
              </div>
              <button onClick={() => setPreview(d.id)} className="text-xs text-mor-slate hover:underline shrink-0">預覽</button>
              {canEdit && (
                <button onClick={() => remove(d)} disabled={busy}
                  className="text-xs text-red-400 underline hover:text-red-600 shrink-0 disabled:opacity-50">刪除</button>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <div className={`mt-2 rounded-lg border border-dashed px-3 py-3 text-center text-xs ${drag ? 'border-mor-slate bg-mor-bluelight' : 'border-gray-300'}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}>
          <div className="flex flex-wrap items-center justify-center gap-2 text-gray-500">
            <span>類型</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as DocKind)}
              className="rounded border border-mor-line bg-white px-1.5 py-0.5 text-xs">
              {DOC_KINDS.map((k) => <option key={k}>{k}</option>)}
            </select>
            <label className={`cursor-pointer underline ${busy ? 'text-gray-400' : 'text-mor-slate'}`}>
              {busy ? '上傳中⋯' : '選 PDF 上傳'}
              <input ref={fileRef} type="file" accept="application/pdf,.pdf" multiple disabled={busy}
                onChange={(e) => upload(e.target.files)} className="hidden" />
            </label>
            <span className="text-gray-400">或拖進來（10 MB 以內）</span>
          </div>
        </div>
      )}
      {!canEdit && docs.length === 0 && <div className="text-xs text-gray-400">還沒上傳</div>}
      {err && <div className="mt-1.5 rounded-lg bg-red-50 text-red-600 px-2 py-1.5 text-xs">{err}</div>}

      {preview && <ContractDocPreview docs={docs} startId={preview} title={title} onClose={() => setPreview(null)} />}
    </div>
  );
}
