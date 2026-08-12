/**
 * 打卡卡片的時段外觀。
 *
 * 【為什麼要分時段，而不是固定一個藍色】
 * 顏色如果只是裝飾，那它就只是裝飾。分時段之後這張卡多帶了一個真的資訊：
 * 一眼看得出現在是早上還是晚上 —— 而打卡的人正是在確認「現在幾點、我算不算遲到」。
 *
 * 代價是同一張卡在不同時間長得不一樣，截圖比對時會以為畫面壞了。
 * 所以分界訂得單純（四段、整點切），不做日出日落那種會隨季節漂移的計算。
 */

export type PhaseKey = 'morning' | 'afternoon' | 'evening' | 'night';

export type Phase = {
  key: PhaseKey;
  greeting: string;
  icon: string;
  /**
   * Tailwind 的漸層類別。
   *
   * **一定要寫成完整的字串常數**：Tailwind 是靜態掃描原始碼的，
   * `from-[${x}]` 這種組出來的類別不會被產生 —— 畫面上會變成沒有背景，
   * 而且編譯不會報錯。這個專案踩過一次。
   */
  gradient: string;
};

const PHASES: Record<PhaseKey, Phase> = {
  morning: {
    key: 'morning', greeting: '早安', icon: '☀️',
    gradient: 'bg-gradient-to-br from-amber-400 via-orange-400 to-orange-500',
  },
  afternoon: {
    key: 'afternoon', greeting: '午安', icon: '🌤️',
    gradient: 'bg-gradient-to-br from-sky-500 via-blue-500 to-indigo-600',
  },
  evening: {
    key: 'evening', greeting: '傍晚好', icon: '🌆',
    gradient: 'bg-gradient-to-br from-indigo-500 via-purple-600 to-purple-700',
  },
  night: {
    key: 'night', greeting: '晚安', icon: '🌙',
    gradient: 'bg-gradient-to-br from-slate-700 via-slate-800 to-slate-900',
  },
};

/**
 * 幾點算哪一段。
 *
 * 05–11 早上／11–17 下午／17–20 傍晚／20–05 晚上。
 * 用整點切，不算日出日落 —— 那會隨季節漂移，而「為什麼今天卡片顏色不一樣」
 * 不是任何人想在打卡時思考的問題。
 */
export function dayPhase(hour: number): Phase {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 5 && h < 11) return PHASES.morning;
  if (h >= 11 && h < 17) return PHASES.afternoon;
  if (h >= 17 && h < 20) return PHASES.evening;
  return PHASES.night;
}

/** 從 Date 取台北時間的小時。伺服器或使用者裝置在別的時區時仍然正確。 */
export function taipeiHour(now: Date = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false,
  }).format(now));
}

/**
 * 上班到現在多久。
 *
 * 【為什麼要顯示這個】
 * 打完上班卡之後，那張卡就只剩兩個靜止的時間。加上「已工作 1 小時 43 分」
 * 之後它變成活的 —— 而且回答了一個真的會被問的問題：「我今天做多久了」。
 *
 * @param inAt 上班時間 HH:mm；沒有或已下班就回空字串
 */
export function workedText(
  inAt: string | null | undefined, now: Date = new Date(),
): string {
  if (!inAt || !/^\d{1,2}:\d{2}$/.test(inAt)) return '';
  const [h, m] = inAt.split(':').map(Number);
  const tw = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  const [nh, nm] = tw.split(':').map(Number);

  let mins = (nh * 60 + nm) - (h * 60 + m);
  // 跨午夜的班（22:00 上班、01:00 還在）—— 不補一天的話會顯示負數
  if (mins < 0) mins += 24 * 60;
  if (mins < 1) return '剛打完上班卡';
  if (mins < 60) return `已工作 ${mins} 分`;
  const hh = Math.floor(mins / 60);
  const mm = mins % 60;
  return mm ? `已工作 ${hh} 小時 ${mm} 分` : `已工作 ${hh} 小時`;
}
