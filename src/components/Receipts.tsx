'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';

/**
 * 憑證附件（發票、收據、單據照片）。
 *
 * 檔案本體放在 storage 的 receipts bucket，路徑約定為
 *   pr/{request_id}/{uuid}.{ext}
 *   exp/{expense_id}/{uuid}.{ext}
 * storage 的 RLS policy 直接讀這個路徑判斷權限，所以路徑格式不能亂改
 * （見 migration_51_receipts.sql）。
 *
 * bucket 是私有的，看圖要用簽名網址 —— 這也是為什麼縮圖要非同步載入。
 */

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

export default function Receipts({
  kind, parentId, canEdit = true, label = '憑證',
}: {
  kind: 'pr' | 'exp';
  parentId: string | null | undefined;
  canEdit?: boolean;
  label?: string;
}) {
  const supabase = createClient();
  const [rows, setRows] = useState<Att[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const col = kind === 'pr' ? 'request_id' : 'expense_id';

  const load = useCallback(async () => {
    if (!parentId) { setRows([]); return; }
    const { data } = await supabase.from('attachments')
      .select('id, path, file_name, mime_type, size_bytes, created_at')
      .eq(col, parentId).order('created_at');
    setRows(data ?? []);
  }, [supabase, parentId, col]);

  useEffect(() => { load(); }, [load]);

  // 私有 bucket 看不到就是看不到，每張圖都要換一次簽名網址。
  // 一小時到期 —— 對話框開著看發票的情境綽綽有餘。
  useEffect(() => {
    (async () => {
      const missing = rows.filter((r) => !urls[r.path]).map((r) => r.path);
      if (!missing.length) return;
      const { data } = await supabase.storage.from(BUCKET).createSignedUrls(missing, 3600);
      if (!data) return;
      const add: Record<string, string> = {};
      data.forEach((d) => { if (d.signedUrl && d.path) add[d.path] = d.signedUrl; });
      setUrls((u) => ({ ...u, ...add }));
    })();
    // urls 故意不放進相依 —— 放了會因為 setUrls 觸發自己而無限迴圈
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, supabase]);

  async function upload(files: FileList | null) {
    if (!files?.length || !parentId) return;
    setErr(''); setBusy(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setErr('尚未登入'); return; }

      for (const file of Array.from(files)) {
        const body = await shrink(file);
        const ext = body.type === 'image/jpeg' ? 'jpg'
          : (file.name.split('.').pop() || 'bin').toLowerCase().slice(0, 5);
        const path = `${kind}/${parentId}/${crypto.randomUUID()}.${ext}`;

        const { error: ue } = await supabase.storage.from(BUCKET)
          .upload(path, body, { contentType: body.type || file.type, upsert: false });
        if (ue) { setErr(`上傳失敗:${ue.message}`); return; }

        // storage 傳成功但 attachments 寫失敗的話，檔案會變成沒人認領的孤兒，
        // 所以這裡失敗要把剛上傳的檔案刪掉，不要留下看不到的垃圾。
        const { error: ie } = await supabase.from('attachments').insert({
          [col]: parentId, path, file_name: file.name,
          mime_type: body.type || file.type, size_bytes: body.size,
          uploaded_by: user.id,
        });
        if (ie) {
          await supabase.storage.from(BUCKET).remove([path]);
          setErr(`存檔失敗:${ie.message}`);
          return;
        }
      }
      await load();
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';   // 同一個檔案再選一次也要能觸發 onChange
    }
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

  if (!parentId) {
    return (
      <div className="border-t border-mor-line pt-3">
        <div className="text-xs text-gray-500 mb-1">{label}</div>
        <div className="rounded-lg bg-mor-sand/60 text-gray-500 px-3 py-2 text-xs">
          先儲存這張單，之後再打開就可以上傳憑證。
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-mor-line pt-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-gray-500">{label}{rows.length > 0 ? `（${rows.length}）` : ''}</span>
        {canEdit && (
          <label className={`text-xs underline cursor-pointer ${busy ? 'text-gray-400' : 'text-mor-blue'}`}>
            {busy ? '處理中…' : '+ 上傳'}
            <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple
              disabled={busy} onChange={(e) => upload(e.target.files)} className="hidden" />
          </label>
        )}
      </div>

      {err && <div className="rounded-lg bg-red-50 text-red-600 px-2 py-1.5 text-xs mb-1.5">{err}</div>}

      {rows.length === 0 ? (
        <div className="text-xs text-gray-400">尚未上傳{canEdit ? '，手機可直接拍照' : ''}</div>
      ) : (
        <div className="grid grid-cols-3 md:grid-cols-4 gap-2">
          {rows.map((a) => {
            const isPdf = a.mime_type === 'application/pdf';
            const url = urls[a.path];
            return (
              <div key={a.id} className="relative group">
                <a href={url ?? '#'} target="_blank" rel="noopener noreferrer"
                  onClick={(e) => { if (!url) e.preventDefault(); }}
                  className="block aspect-square rounded-lg border border-mor-line overflow-hidden bg-mor-sand/40">
                  {isPdf || !url ? (
                    <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">
                      {isPdf ? 'PDF' : '…'}
                    </div>
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={url} alt={a.file_name ?? '憑證'} className="w-full h-full object-cover" />
                  )}
                </a>
                <div className="mt-0.5 text-[10px] text-gray-400 truncate">{fmtSize(a.size_bytes)}</div>
                {canEdit && (
                  <button onClick={() => remove(a)} disabled={busy}
                    className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/50 text-white text-xs leading-none
                               flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100
                               md:opacity-0 max-md:opacity-100"
                    aria-label="刪除">✕</button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
