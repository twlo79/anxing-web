/**
 * 打卡的前端邏輯（純函式，可測）。
 *
 * ============================================================
 * 【瀏覽器的 GPS 有三種失敗，訊息完全不同】
 *
 * navigator.geolocation 的錯誤碼只有 1/2/3，而使用者要做的事差很多：
 *
 *   1 PERMISSION_DENIED   去瀏覽器設定把定位改成允許
 *   2 POSITION_UNAVAILABLE 室內收不到訊號 —— 走到窗邊
 *   3 TIMEOUT              等太久 —— 再按一次
 *
 * 全部講成「定位失敗」的話，室內收不到訊號的人會跑去改權限設定，
 * 改完還是不行，然後放棄。
 */

export type GeoFail = { code: string; message: string };

/** 定位的逾時。太短會讓室內的人一直失敗，太長會讓人以為當掉。 */
export const GEO_TIMEOUT_MS = 15000;

export function geoErrorMessage(code: number): GeoFail {
  switch (code) {
    case 1:
      return {
        code: 'PERMISSION_DENIED',
        message: '瀏覽器不給定位權限，所以打不了卡。\n\n'
          + '　• Chrome：網址列左邊的鎖頭 → 位置 → 允許\n'
          + '　• iPhone Safari：設定 → Safari → 位置 → 允許\n'
          + '　• 無痕視窗常常擋定位，請用一般視窗開啟',
      };
    case 2:
      return {
        code: 'POSITION_UNAVAILABLE',
        message: '收不到定位訊號。\n\n'
          + '室內、地下室、電梯裡的 GPS 通常收不到 —— 走到窗邊或戶外再按一次。\n'
          + '如果一直不行，請主管幫你補登。',
      };
    case 3:
      return {
        code: 'TIMEOUT',
        message: '定位等太久了（超過 15 秒）。\n\n'
          + '再按一次通常就好。如果連續失敗，可能是室內收不到訊號 —— 走到窗邊試試。',
      };
    default:
      return { code: 'GEO_UNKNOWN', message: '拿不到位置，請再試一次。' };
  }
}

/**
 * 取得目前座標。
 *
 * enableHighAccuracy 開著 —— 打卡要判斷 500 公尺內，
 * 低精度模式（基地台定位）誤差可能上千公尺，直接讓人打不了卡。
 */
export function getPosition(): Promise<{ lat: number; lng: number; accuracy: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject({ code: 'NO_GEO', message: '這個瀏覽器不支援定位，打不了卡。請換一支手機或請主管補登。' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(geoErrorMessage(e.code)),
      { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 0 },
    );
  });
}

/**
 * 打卡按鈕現在該顯示什麼。
 *
 * 【為什麼「已下班」之後兩顆都不能按】
 * 一天一次上下班（migration_98）。已經打完的話再按只會得到 ALREADY_OUT，
 * 讓按鈕可按等於邀請使用者去撞一個必定失敗的動作。
 */
export type TodayState = {
  in_at?: string | null;
  out_at?: string | null;
};

export type PunchUi = {
  /** 主要按鈕的動作。null = 今天已經打完了 */
  action: 'in' | 'out' | null;
  label: string;
  hint: string;
};

export function punchUi(t: TodayState | null): PunchUi {
  const hasIn = !!t?.in_at;
  const hasOut = !!t?.out_at;
  // hint 只在「有下一步動作」時才有字。
  // 上下班時間就顯示在按鈕旁邊，再寫一次「已於 09:02 上班打卡」是重複；
  // 「按下去會取得你的位置」更是廢話 —— 按了就知道。
  if (!hasIn) return { action: 'in', label: '上班打卡', hint: '' };
  if (!hasOut) return { action: 'out', label: '下班打卡', hint: '' };
  return { action: null, label: '今天已完成', hint: '要修改請用補登申請' };
}

/** HH:MM。null 顯示成 — 而不是空白，空白看起來像壞掉。 */
export const hhmm = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * 剩餘假的顯示。
 *
 * 時數同時給「小時」與「天」—— 制度上是小時，但人腦是用天在想的。
 * 只給小時的話「還剩 52 小時」要自己除以 8 才知道是六天半。
 */
export function remainText(remainHours: number | null, dailyHours: number): string {
  if (remainHours === null) return '不限';
  const h = Math.round(remainHours * 100) / 100;
  const d = dailyHours > 0 ? Math.round((h / dailyHours) * 100) / 100 : 0;
  return `${h} 小時（約 ${d} 天）`;
}
