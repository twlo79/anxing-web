'use client';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';

/**
 * 憑證附件（發票、收據、單據照片）。
 *
 * 檔案本體放在 storage 的 receipts bucket，路徑約定為
 *   pr/{request_id}/{uuid}.{ext}
 *   exp/{expense_id}/{uuid}.{ext}
 *   dep/{deposit_id}/{uuid}.{ext}
 *   op/{order_payment_id}/{uuid}.{ext}
 * storage 的 RLS policy 直接讀這個路徑判斷權限，所以路徑格式不能亂改
 * （見 migration_51_receipts.sql）。
 *
 * bucket 是私有的，看圖要用簽名網址 —— 這也是為什麼縮圖要非同步載入。
 *
 * 還沒存檔的新單沒有 id，路徑就組不出來。這種情況下選的檔案先留在瀏覽器裡
 * （staged），等母單建立後由父層呼叫 flush(id) 才真的上傳。
 * 不採「開視窗就先建一張草稿」的做法 —— 使用者按了關閉就會留下空單並吃掉一個單號。
 */

export type ReceiptsHandle = {
  /** 母單存檔後呼叫，把暫存的檔案真正上傳。回傳錯誤訊息，成功為 null。 */
  flush: (parentId: string) => Promise<string | null>;
  /** 有沒有還沒上傳的檔案 */
  hasStaged: () => boolean;
};

type Att = {
  id: string; path: string; file_name: string | null;
  mime_type: string | null; size_bytes: number | null; created_at: string;
};

const BUCKET = 'receipts';
const MAX_EDGE = 1600;       // 長邊上限。手機直出 4000px 的照片對看發票沒有幫助，只是變慢
const JPEG_QUALITY = 0.82;

/**
 * 手機拍的照片動輒 4~8MB，直接上傳又慢又佔空間。
 * 壓到長邊 1600px 的 JPEG，發票文字依然清楚，檔案通常剩 200~400KB。
 * PDF 與非圖片原樣送出。
 */
async function shrink(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) return file;
  // HEIC 在多數瀏覽器畫不出來，交給後端原樣存，讓使用者自己開
  if (file.type === 'image/heic' || file.type === 'image/heif') return file;

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;

  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 800 * 1024) return file;   // 已經夠小就別再壓一次

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
  return blob && blob.size < file.size ? blob : file;
}

function fmtSize(n: number | null) {
  if (!n) return '';
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type Staged = { key: string; file: File; preview: string };

const Receipts = forwardRef<ReceiptsHandle, {
  kind: 'pr' | 'exp' | 'dep' | 'op';
  parentId: string | null | undefined;
  canEdit?: boolean;
  label?: string;
  /**
   * 這筆支出來自哪張請款單。有值的話，請款單上的憑證會一起顯示（唯讀）。
   * 檔案不複製 —— 一張請款單常拆成多筆支出，複製會讓同一張發票在 storage 出現好幾份。
   */
  inheritFromRequestId?: string | null;
}>(function Receipts({ kind, parentId, canEdit = true, label = '憑證', inheritFromRequestId }, ref) {
  const supabase = createClient();
  const [rows, setRows] = useState<Att[]>([]);
  const [inherited, setInherited] = useState<Att[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [staged, setStaged] = useState<Staged[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const col = kind === 'pr' ? 'request_id'
    : kind === 'dep' ? 'deposit_id'
    : kind === 'op' ? 'order_payment_id'   // 短租收款的證明照片（migration_85）
    : 'expense_id';

  const load = useCallback(async () => {
    if (!parentId) { setRows([]); return; }
    const { data } = await supabase.from('attachments')
      .select('id, path, file_name, mime_type, size_bytes, created_at')
      .eq(col, parentId).order('created_at');
    setRows(data ?? []);
  }, [supabase, parentId, col]);

  useEffect(() => { load(); }, [load]);

  // 母單（請款單）上的憑證。只顯示，不能在支出頁刪 —— 那是請款單的東西。
  useEffect(() => {
    (async () => {
      if (!inheritFromRequestId) { setInherited([]); return; }
      const { data } = await supabase.from('attachments')
        .select('id, path, file_name, mime_type, size_bytes, created_at')
        .eq('request_id', inheritFromRequestId).order('created_at');
      setInherited(data ?? []);
    })();
  }, [supabase, inheritFromRequestId]);

  // 私有 bucket 看不到就是看不到，每張圖都要換一次簽名網址。
  // 一小時到期 —— 對話框開著看發票的情境綽綽有餘。
  useEffect(() => {
    (async () => {
      const missing = [...rows, ...inherited].filter((r) => !urls[r.path]).map((r) => r.path);
      if (!missing.length) return;
      const { data } = await supabase.storage.from(BUCKET).createSignedUrls(missing, 3600);
      if (!data) return;
      const add: Record<string, string> = {};
      data.forEach((d) => { if (d.signedUrl && d.path) add[d.path] = d.signedUrl; });
      setUrls((u) => ({ ...u, ...add }));
    })();
    // urls 故意不放進相依 —— 放了會因為 setUrls 觸發自己而無限迴圈
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, inherited, supabase]);

  /** 傳一個檔案並登記。回傳錯誤訊息，成功為 null。 */
  const putOne = useCallback(async (file: File, pid: string, userId: string): Promise<string | null> => {
    const body = await shrink(file);
    const ext = body.type === 'image/jpeg' ? 'jpg'
      : (file.name.split('.').pop() || 'bin').toLowerCase().slice(0, 5);
    const path = `${kind}/${pid}/${crypto.randomUUID()}.${ext}`;

    const { error: ue } = await supabase.storage.from(BUCKET)
      .upload(path, body, { contentType: body.type || file.type, upsert: false });
    if (ue) return `上傳失敗:${ue.message}`;

    // storage 傳成功但 attachments 寫失敗的話，檔案會變成沒人認領的孤兒，
    // 所以這裡失敗要把剛上傳的檔案刪掉，不要留下看不到的垃圾。
    const { error: ie } = await supabase.from('attachments').insert({
      [col]: pid, path, file_name: file.name,
      mime_type: body.type || file.type, size_bytes: body.size,
      uploaded_by: userId,
    });
    if (ie) {
      await supabase.storage.from(BUCKET).remove([path]);
      return `存檔失敗:${ie.message}`;
    }
    return null;
  }, [supabase, kind, col]);

  async function pick(files: FileList | null) {
    if (!files?.length) return;
    setErr('');

    // 母單還不存在 —— 先留在瀏覽器，等存檔後 flush() 再上傳
    if (!parentId) {
      setStaged((s) => [...s, ...Array.from(files).map((file) => ({
        key: crypto.randomUUID(), file,
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
      }))]);
      if (fileRef.current) fileRef.current.value = '';
      return;
    }

    setBusy(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setErr('尚未登入'); return; }
      for (const file of Array.from(files)) {
        const e = await putOne(file, parentId, user.id);
        if (e) { setErr(e); return; }
      }
      await load();
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';   // 同一個檔案再選一次也要能觸發 onChange
    }
  }

  useImperativeHandle(ref, () => ({
    hasStaged: () => staged.length > 0,
    async flush(pid: string) {
      if (!staged.length) return null;
      setBusy(true);
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return '尚未登入';
        for (const s of staged) {
          const e = await putOne(s.file, pid, user.id);
          if (e) { setErr(e); return e; }
        }
        staged.forEach((s) => s.preview && URL.revokeObjectURL(s.preview));
        setStaged([]);
        return null;
      } finally { setBusy(false); }
    },
  }), [staged, supabase, putOne]);

  // 視窗關掉時把預覽用的 object URL 收回，不然會一直佔著記憶體
  useEffect(() => () => { staged.forEach((s) => s.preview && URL.revokeObjectURL(s.preview)); },
    // 只在卸載時執行
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []);

  function dropStaged(key: string) {
    setStaged((s) => {
      const hit = s.find((x) => x.key === key);
      if (hit?.preview) URL.revokeObjectURL(hit.preview);
      return s.filter((x) => x.key !== key);
    });
  }

  async function remove(a: Att) {
    if (!confirm(`刪除憑證「${a.file_name ?? ''}」?`)) return;
    setBusy(true);
    // 先刪資料列再刪檔案。反過來的話，檔案刪成功而資料列刪失敗，
    // 畫面上會留下一張永遠載不出來的破圖。
    const { error } = await supabase.from('attachments').delete().eq('id', a.id);
    if (error) { setErr('刪除失敗:' + error.message); setBusy(false); return; }
    await supabase.storage.from(BUCKET).remove([a.path]);
    setBusy(false); load();
  }

  const total = rows.length + staged.length + inherited.length;

  /** fromRequest：來自請款單的憑證，只能看不能刪 —— 那是請款單的東西 */
  function tile(a: Att, removable: boolean, fromRequest: boolean) {
    const isPdf = a.mime_type === 'application/pdf';
    const url = urls[a.path];
    return (
      <div key={a.id} className="relative group">
        <a href={url ?? '#'} target="_blank" rel="noopener noreferrer"
          onClick={(e) => { if (!url) e.preventDefault(); }}
          className={`block aspect-square rounded-lg border overflow-hidden bg-mor-sand/40
            ${fromRequest ? 'border-mor-blue/40' : 'border-mor-line'}`}>
          {isPdf || !url ? (
            <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">
              {isPdf ? 'PDF' : '…'}
            </div>
          ) : (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={url} alt={a.file_name ?? '憑證'} className="w-full h-full object-cover" />
          )}
        </a>
        <div className={`mt-0.5 text-[10px] truncate ${fromRequest ? 'text-mor-blue' : 'text-gray-400'}`}>
          {fromRequest ? '來自請款單' : fmtSize(a.size_bytes)}
        </div>
        {removable && (
          <button onClick={() => remove(a)} disabled={busy}
            className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/50 text-white text-xs leading-none
                       flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100
                       md:opacity-0 max-md:opacity-100"
            aria-label="刪除">✕</button>
        )}
      </div>
    );
  }

  return (
    <div className="border-t border-mor-line pt-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-gray-500">{label}{total > 0 ? `（${total}）` : ''}</span>
        {canEdit && (
          <label className={`text-xs underline cursor-pointer ${busy ? 'text-gray-400' : 'text-mor-blue'}`}>
            {busy ? '處理中…' : '+ 上傳'}
            <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple
              disabled={busy} onChange={(e) => pick(e.target.files)} className="hidden" />
          </label>
        )}
      </div>

      {err && <div className="rounded-lg bg-red-50 text-red-600 px-2 py-1.5 text-xs mb-1.5">{err}</div>}
      {staged.length > 0 && (
        <div className="text-xs text-amber-600 mb-1.5">{staged.length} 張待上傳,存檔後才會送出。</div>
      )}

      {total === 0 ? (
        <div className="text-xs text-gray-400">尚未上傳{canEdit ? '，手機可直接拍照' : ''}</div>
      ) : (
        <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
          {staged.map((s) => (
            <div key={s.key} className="relative">
              <div className="block aspect-square rounded-lg border border-dashed border-amber-300 overflow-hidden bg-amber-50">
                {s.preview
                  /* eslint-disable-next-line @next/next/no-img-element */
                  ? <img src={s.preview} alt={s.file.name} className="w-full h-full object-cover opacity-70" />
                  : <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">PDF</div>}
              </div>
              <div className="mt-0.5 text-[10px] text-amber-600 truncate">待上傳</div>
              <button onClick={() => dropStaged(s.key)} disabled={busy}
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/50 text-white text-xs leading-none flex items-center justify-center"
                aria-label="移除">✕</button>
            </div>
          ))}
          {rows.map((a) => tile(a, canEdit, false))}
          {inherited.map((a) => tile(a, false, true))}
        </div>
      )}
    </div>
  );
});

export default Receipts;
