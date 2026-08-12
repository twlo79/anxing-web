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

/**
 * 卡片上所有東西的顏色。
 *
 * 【為什麼要兩套，而不是一律白字】
 *
 * 使用者要的是「早上淡藍、中午黃色」—— 那兩個底色是淺的，
 * 白字放上去對比只有 1.2:1，等於看不見。而打卡是站在戶外做的事，
 * 太陽底下那個數字本來就已經很難讀了。
 *
 * 所以淺色底配墨色字、深色底配白字。這不是可有可無的細節：
 * 「幾點打的、算不算遲到」讀不到的話，這張卡就沒有存在的意義。
 *
 * 全部寫成完整的類別字串 —— Tailwind 靜態掃描，組出來的類別不會產生。
 */
export type CardInk = {
  /** 時間、打卡時刻 */
  strong: string;
  /** 問候語、已工作多久 */
  soft: string;
  /** 日期、膠囊標籤 */
  dim: string;
  /** 還沒打的那個破折號 */
  faint: string;
  /** 小膠囊的底＋邊 */
  pill: string;
  /** 遲到／早退 */
  warn: string;
  /** 卡片自己的邊 */
  edge: string;
  glow1: string;
  glow2: string;
  /** 右下角那個大圖示 */
  iconDim: string;
  /**
   * 打卡按鈕整顆。
   *
   * **四個時段都是白底黑字**，不跟著卡片翻面 —— 這顆按鈕是整張卡
   * 唯一要人動手的地方，長得永遠一樣才不用每次重新找。
   * 淺色卡上白對白邊界會糊掉，所以那兩段多一圈細邊把它框出來。
   */
  btn: string;
  /** 按鈕右邊那個漸層圓圈裡的箭頭 */
  arrow: string;
  /** 已完成時那條膠囊 */
  done: string;
};

const ON_DARK: CardInk = {
  strong: 'text-white',
  soft: 'text-white/85',
  dim: 'text-white/60',
  faint: 'text-white/30',
  pill: 'bg-white/[0.08] ring-1 ring-inset ring-white/10',
  warn: 'text-amber-200/90',
  edge: 'ring-1 ring-inset ring-white/10',
  glow1: 'bg-white/10',
  glow2: 'bg-white/[0.06]',
  iconDim: 'opacity-[0.09]',
  btn: 'bg-white text-mor-ink',
  arrow: 'text-white',
  done: 'bg-white/15 border-white/25 text-white',
};

const ON_LIGHT: CardInk = {
  strong: 'text-mor-ink',
  soft: 'text-mor-ink/75',
  dim: 'text-mor-ink/55',
  faint: 'text-mor-ink/25',
  // 淺底上「壓暗」才看得出層次 —— 白色膠囊放在淡藍上等於沒有
  pill: 'bg-black/[0.06] ring-1 ring-inset ring-black/[0.06]',
  warn: 'text-amber-800',
  edge: 'ring-1 ring-inset ring-black/[0.06]',
  glow1: 'bg-white/40',
  glow2: 'bg-white/25',
  iconDim: 'opacity-[0.13]',
  // 白底按鈕擺在淺色卡上,邊界會糊掉 —— 加一圈細邊把它框出來,
  // 而不是把按鈕改成深色（那會讓四個時段長得不一樣）
  btn: 'bg-white text-mor-ink ring-1 ring-inset ring-black/[0.07]',
  arrow: 'text-mor-ink',
  done: 'bg-black/[0.06] border-black/10 text-mor-ink',
};

export type Phase = {
  key: PhaseKey;
  greeting: string;
  icon: string;
  /** 這個時段的字要用哪一套顏色 */
  ink: CardInk;
  /**
   * Tailwind 的漸層類別。
   *
   * **一定要寫成完整的字串常數**：Tailwind 是靜態掃描原始碼的，
   * `from-[${x}]` 這種組出來的類別不會被產生 —— 畫面上會變成沒有背景，
   * 而且編譯不會報錯。這個專案踩過一次。
   *
   * 寫死的 `from-[#41689B]` 沒有這個問題（掃描得到），組出來的才有。
   */
  gradient: string;
};

/*
 * ============================================================
 * 【一天的光線】（使用者選的）
 *
 *   早上 淺藍 → 中午 黃橘 → 傍晚 暮藍 → 晚上 夜空
 *
 * 這條線本身帶資訊：看一眼就知道現在大概幾點，不用去讀那個數字。
 * 而打卡的人正是在確認「現在幾點、我算不算遲到」。
 *
 *
 * ============================================================
 * 【白天配深字、晚上配白字】
 *
 * 早上與中午是淺色的 —— 白字放上去只有 1.8:1 與 1.7:1，
 * 等於整張卡的時間消失。而打卡是站在戶外做的事，太陽底下更慘。
 *
 * 走過一輪「把顏色壓深好讓白字讀得到」，結果是顏色被字牽著走：
 * 淺藍變灰藍、黃橘變焦糖。所以反過來 —— 顏色留著，字跟著底色走。
 *
 * 而且這樣才對得上那條線：白天亮、字深；晚上暗、字白。
 *
 *
 * ============================================================
 * 【只有按鈕四段都一樣】
 *
 * 白底黑字，不跟著卡片翻面。那顆按鈕是整張卡唯一要人動手的地方，
 * 長得永遠一樣才不用每次重新找 —— 而且那片白正是這張卡的呼吸口。
 * ============================================================
 */
const PHASES: Record<PhaseKey, Phase> = {
  morning: {
    key: 'morning', greeting: '早安', icon: '☀️', ink: ON_LIGHT,
    // 清晨的天空
    gradient: 'bg-gradient-to-br from-[#8CC8EA] via-[#71B4DF] to-[#5A9ECF]',
  },
  afternoon: {
    key: 'afternoon', greeting: '午安', icon: '🌤️', ink: ON_LIGHT,
    // 正午的黃橘
    gradient: 'bg-gradient-to-br from-[#F5BC49] via-[#F0A233] to-[#E88A22]',
  },
  evening: {
    key: 'evening', greeting: '傍晚好', icon: '🌆', ink: ON_DARK,
    /*
     * 暮藍：偏藍但留著一點紫。
     *
     * 再往藍走的話會跟晚上的夜空藍變成同一個色相，兩段擺在一起
     * 像同一個顏色的深淺 —— 而傍晚與晚上要分得開：
     * 一個是天還沒黑，一個是天黑了。那點紫就是差別。
     */
    gradient: 'bg-gradient-to-br from-[#6D89D2] via-[#5A74BE] to-[#4A61A6]',
  },
  night: {
    key: 'night', greeting: '晚安', icon: '🌙', ink: ON_DARK,
    // 夜空
    gradient: 'bg-gradient-to-br from-[#2C4271] via-[#1F3057] to-[#15213D]',
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
