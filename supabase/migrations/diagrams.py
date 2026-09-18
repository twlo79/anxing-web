#!/usr/bin/env python3
"""
安幸 ERP 的流程圖／狀態圖。用程式產生 SVG —— 座標算出來的，不是手排的。
★ 2026-09-18 使用者：「你畫的圖很難懂，要有流程、狀態、跟角色關係」。
  前一版是一堆卡片配長段文字 —— 那是排版，不是圖。
  這一版：泳道（誰做的）＋ 箭頭（往哪裡去）＋ 狀態機（會變成什麼）。
"""
import html

INK   = '#2E3840'
LINE  = '#D6D2C8'
SLATE = '#41689B'
SAND  = '#8A7A5C'
GREEN = '#217346'
RED   = '#B3423C'
AMBER = '#B45309'
GREY  = '#8b929a'

DEFS = f'''<defs>
<marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
  <path d="M0 0 L10 5 L0 10 z" fill="{INK}"/></marker>
<marker id="ag" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
  <path d="M0 0 L10 5 L0 10 z" fill="{GREEN}"/></marker>
<marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
  <path d="M0 0 L10 5 L0 10 z" fill="{RED}"/></marker>
<marker id="as" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
  <path d="M0 0 L10 5 L0 10 z" fill="{SLATE}"/></marker>
</defs>'''

F = 'system-ui,-apple-system,\'Noto Sans TC\',sans-serif'
M = 'ui-monospace,SFMono-Regular,Menlo,monospace'


def esc(t):
    return html.escape(str(t))


def box(x, y, w, h, lines, fill='#fff', stroke=LINE, sw=1.4, rx=9, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    o = [f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" '
         f'stroke="{stroke}" stroke-width="{sw}"{d}/>']
    n = len(lines)
    total = sum(ln.get('lh', 17) for ln in lines)
    cy = y + h / 2 - total / 2 + 12
    for ln in lines:
        o.append(f'<text x="{x + w/2}" y="{cy:.1f}" text-anchor="middle" '
                 f'font-family="{ln.get("f", F)}" font-size="{ln.get("s", 13)}" '
                 f'fill="{ln.get("c", INK)}" font-weight="{ln.get("w", 400)}">{esc(ln["t"])}</text>')
        cy += ln.get('lh', 17)
    return '\n'.join(o)


def txt(x, y, t, s=12, c=INK, anchor='middle', w=400, f=F):
    return (f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-family="{f}" '
            f'font-size="{s}" fill="{c}" font-weight="{w}">{esc(t)}</text>')


def arrow(x1, y1, x2, y2, marker='a', color=INK, dash=None, sw=1.8):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    return (f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{color}" '
            f'stroke-width="{sw}" marker-end="url(#{marker})"{d}/>')


def elbow(pts, marker='a', color=INK, dash=None, sw=1.8):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    p = ' '.join(f'{x},{y}' for x, y in pts)
    return (f'<polyline points="{p}" fill="none" stroke="{color}" stroke-width="{sw}" '
            f'stroke-linejoin="round" marker-end="url(#{marker})"{d}/>')


def label(x, y, t, c=GREY, s=11.5, bg='#F1F0EC'):
    """箭頭上的字。先鋪一塊底色，線才不會從字中間穿過去。"""
    wpx = sum(13 if ord(ch) > 0x2E80 else 7 for ch in t) + 10
    return (f'<rect x="{x - wpx/2}" y="{y - 11}" width="{wpx}" height="16" fill="{bg}" rx="3"/>'
            + txt(x, y + 1, t, s=s, c=c))


def svg(w, h, body, title):
    return (f'<figure><svg role="img" aria-label="{esc(title)}" viewBox="0 0 {w} {h}" '
            f'width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg">'
            f'<rect x="0" y="0" width="{w}" height="{h}" fill="#F1F0EC"/>{DEFS}{body}</svg></figure>')


# ══════════════════════════════════════════════════════════
# 圖 A　代墊：誰做什麼，東西往哪裡去（泳道）
# ══════════════════════════════════════════════════════════
def fig_lend():
    """
    ★★ 2026-09-18 第二版：愛皮那一列的框**往右錯開**。
      第一版兩個帳本的框同一個 x，於是「再建支出」那條箭頭
      非得穿過暫付的框才到得了 —— 看起來像那條線跟暫付有關係。
      錯開之後每一條箭頭都走空白處。
    """
    W, H = 1240, 632
    LX, LW = 16, 118
    lanes = [
        ('會計（人）',   80, 118, '#FFFFFF'),
        ('系統・觸發器', 210, 96, '#F7F6F2'),
        ('安幸的帳',     318, 118, '#FFFFFF'),
        ('愛皮的帳',     448, 110, '#FFFFFF'),
    ]
    o = [txt(W / 2, 34, '代墊：誰做什麼，東西往哪裡去', s=19, w=700, c=INK),
         txt(W / 2, 55, '橫軸是時間　·　每一列是一個角色　·　箭頭上的字是「做了什麼」', s=12, c=GREY)]

    for name, y, h, fill in lanes:
        o.append(f'<rect x="{LX}" y="{y}" width="{W - LX - 16}" height="{h}" rx="10" '
                 f'fill="{fill}" stroke="{LINE}" stroke-width="1.2"/>')
        o.append(f'<rect x="{LX}" y="{y}" width="{LW}" height="{h}" rx="10" fill="#ECE8DF"/>')
        o.append(f'<rect x="{LX + LW - 10}" y="{y}" width="10" height="{h}" fill="#ECE8DF"/>')
        o.append(txt(LX + LW / 2, y + h / 2 + 5, name, s=13, w=700, c='#5b5344'))

    # 左半（出款）與右半（收回）各一組；愛皮的框往右錯開 200
    L, R = 392, 840          # 安幸／會計／系統 這三列的框 x
    LA, RA = 592, 1040       # 愛皮那一列的框 x
    BW = 150
    o.append(box(170, 110, 168, 58, [
        {'t': '開請款單', 'w': 700, 's': 14},
        {'t': '勾「代墊 → 愛皮」', 's': 11.5, 'c': GREY}]))
    o.append(box(L, 110, BW, 58, [
        {'t': '確認出款', 'w': 700, 's': 14},
        {'t': '填 purchased_on', 's': 11, 'c': GREY, 'f': M}]))
    o.append(box(R, 110, 168, 58, [
        {'t': '按「收回」', 'w': 700, 's': 14},
        {'t': '在安幸的暫付頁', 's': 11.5, 'c': GREY}]))
    o.append(arrow(338, 139, 386, 139))
    o.append(arrow(L + BW, 139, R - 6, 139, dash='6 5'))
    o.append(label((L + BW + R) / 2, 130, '之後　愛皮把錢還給安幸', c=AMBER, bg='#FFFFFF'))

    o.append(box(L, 228, BW, 58, [
        {'t': 'gen_expenses_from_pr()', 's': 11, 'f': M, 'w': 700},
        {'t': '一個交易，順序不能倒', 's': 11, 'c': GREY}], fill='#EFEDE7'))
    o.append(arrow(L + BW / 2, 168, L + BW / 2, 224, marker='as', color=SLATE))
    o.append(label(L + BW / 2, 206, '觸發', c=SLATE))

    o.append(box(R, 228, 168, 58, [
        {'t': 'recover_advances()', 's': 11, 'f': M, 'w': 700},
        {'t': '一次改好幾列', 's': 11, 'c': GREY}], fill='#EFEDE7'))
    o.append(arrow(R + 84, 168, R + 84, 224, marker='as', color=SLATE))
    o.append(label(R + 84, 206, '呼叫', c=SLATE))

    # 安幸
    o.append(box(L, 336, BW, 78, [
        {'t': '暫付　一列', 'w': 700, 's': 14},
        {'t': '代墊 · $1,428', 's': 11.5, 'c': GREY},
        {'t': '待收回', 's': 12.5, 'c': AMBER, 'w': 700}], stroke=AMBER))
    o.append(arrow(L + BW / 2, 286, L + BW / 2, 332, marker='as', color=SLATE))
    o.append(label(L + BW / 2, 316, '① 先建暫付', c=SLATE))

    o.append(box(R, 336, 168, 78, [
        {'t': '同一列暫付', 'w': 700, 's': 14},
        {'t': 'refunded_amount = 1,428', 's': 10.5, 'c': GREY, 'f': M},
        {'t': '已收回', 's': 12.5, 'c': GREEN, 'w': 700}], stroke=GREEN))
    o.append(arrow(R + 84, 286, R + 84, 332, marker='ag', color=GREEN))
    o.append(label(R + 84, 316, '寫入收回日與金額', c=GREEN))

    # 愛皮（往右錯開）
    o.append(box(LA, 466, BW, 78, [
        {'t': '支出　一列', 'w': 700, 's': 14},
        {'t': '應支 $1,428', 's': 12},
        {'t': '實支 $0', 's': 12, 'c': RED, 'w': 700}]))
    o.append(elbow([(L + BW, 257), (LA + BW / 2, 257), (LA + BW / 2, 462)],
                   marker='as', color=SLATE))
    o.append(label(LA + BW / 2 + 6, 300, '② 再建支出（在愛皮那本帳）', c=SLATE))

    o.append(box(RA, 466, 168, 78, [
        {'t': '同一列支出', 'w': 700, 's': 14},
        {'t': '應支 $1,428', 's': 12},
        {'t': '實支 $1,428', 's': 12, 'c': GREEN, 'w': 700}]))
    o.append(elbow([(R + 168, 375), (RA + 84, 375), (RA + 84, 462)], marker='ag', color=GREEN))
    o.append(label(RA + 84, 430, '實支＝讀這個數字', c=GREEN))

    # advance_id：支出指回那一列暫付（短、斜、不穿框）
    o.append(elbow([(LA, 490), (L + BW + 14, 490), (L + BW + 14, 400), (L + BW + 6, 400)],
                   color=SAND, sw=1.7))
    o.append(label(LA - 96, 452, 'advance_id 指回那列暫付', c=SAND))

    # 規則（不是流程的一步）——放在泳道**外面**的註腳條。
    # ★ 放進泳道裡的話，它會看起來像時間軸上的第三格，而它是一條規矩。
    o.append(f'<rect x="16" y="572" width="{W - 32}" height="44" rx="9" fill="#FFF6F5" '
             f'stroke="{RED}" stroke-width="1.3" stroke-dasharray="5 4"/>')
    o.append(txt(46, 600, '✗', s=18, c=RED, w=700))
    o.append(txt(68, 599, '愛皮那一頁不能自己記實支 —— 實支只有一個寫入者（安幸的暫付頁）。'
                          '兩邊各記一次會不一致，而且不會有任何地方報錯。',
                 s=12.5, c=RED, anchor='start'))
    return svg(W, H, '\n'.join(o),
               '代墊流程泳道圖：會計、觸發器、安幸的帳、愛皮的帳四個角色')


# ══════════════════════════════════════════════════════════
# 圖 B　一列暫付的狀態機
# ══════════════════════════════════════════════════════════
def fig_state():
    W, H = 1160, 470
    o = [txt(W / 2, 34, '一列暫付：會經過哪些狀態', s=19, w=700, c=INK),
         txt(W / 2, 55, '框是狀態　·　箭頭上的字是「發生了什麼才會變過去」', s=12, c=GREY)]

    o.append(box(40, 190, 150, 64, [
        {'t': '待出款', 'w': 700, 's': 16},
        {'t': 'draft', 's': 11, 'c': GREY, 'f': M}]))
    o.append(box(276, 190, 150, 64, [
        {'t': '待收回', 'w': 700, 's': 16, 'c': AMBER},
        {'t': '錢在外面', 's': 11, 'c': GREY}], stroke=AMBER, fill='#FFFBEB'))

    o.append(arrow(190, 222, 270, 222))
    o.append(label(230, 212, '出款'))

    # 三種結局
    o.append(box(560, 88, 168, 64, [
        {'t': '已收回', 'w': 700, 's': 16, 'c': GREEN},
        {'t': '不記收入', 's': 11, 'c': GREY}], stroke=GREEN))
    o.append(box(560, 190, 168, 64, [
        {'t': '部分收回', 'w': 700, 's': 16, 'c': RED},
        {'t': '差額＝被扣掉的', 's': 11, 'c': GREY}], stroke=RED))
    o.append(box(560, 292, 168, 64, [
        {'t': '全額被扣', 'w': 700, 's': 16, 'c': RED},
        {'t': '收回 ＝ 0', 's': 11, 'c': GREY, 'f': M}], stroke=RED))

    # ★★ 條件的字放在**目標框的正上方**，不要夾在來源框與分岔線中間 ——
    #   那段只有 128px，而「0 ＜ 收回 ＜ 付出去的」要 150px，一定會壓到。
    o.append(elbow([(426, 222), (500, 222), (500, 120), (554, 120)], marker='ag', color=GREEN))
    o.append(arrow(426, 222, 554, 222, marker='ar', color=RED))
    o.append(elbow([(426, 222), (500, 222), (500, 324), (554, 324)], marker='ar', color=RED))
    o.append(label(644, 78,  '收回 ＝ 付出去的', c=GREEN))
    o.append(label(644, 180, '0 ＜ 收回 ＜ 付出去的', c=RED))
    o.append(label(644, 282, '收回 ＝ 0', c=RED))

    # 被扣 → 支出
    o.append(box(880, 190, 210, 90, [
        {'t': '產生一筆支出', 'w': 700, 's': 16},
        {'t': '記費用 · 要選會計科目', 's': 11.5, 'c': GREY},
        {'t': 'forfeit_expense_id 指過去', 's': 10, 'c': GREY, 'f': M}], stroke=RED, fill='#FDECEA'))
    o.append(arrow(728, 222, 874, 226, marker='ar', color=RED))
    o.append(label(800, 212, '差額', c=RED))
    o.append(elbow([(728, 324), (800, 324), (800, 262), (874, 262)], marker='ar', color=RED))
    o.append(label(800, 302, '全部', c=RED))

    # 註
    o.append(box(40, 380, 1080, 62, [
        {'t': 'refunded_amount = null 是「還沒收回，錢在外面」　·　= 0 是「收回了，但全額被扣」', 's': 13, 'w': 700},
        {'t': '用 !refunded_amount 判斷的話兩者都是 true —— 一筆全額沒收的押金會永遠躺在「待收回」', 's': 12, 'c': GREY}],
        fill='#F5F3FF', stroke='#C4B5FD'))

    return svg(W, H, '\n'.join(o), '暫付的狀態機：待出款、待收回，以及已收回／部分收回／全額被扣三種結局')


# ══════════════════════════════════════════════════════════
# 圖 C　一張請款單的三條路
# ══════════════════════════════════════════════════════════
def fig_routes():
    W, H = 1160, 430
    o = [txt(W / 2, 34, '一張請款單，按下「確認出款」之後分三條路', s=19, w=700, c=INK),
         txt(W / 2, 55, '看的是這張單勾了什麼　·　三條互斥，同時勾兩個會被擋下來', s=12, c=GREY)]

    o.append(box(40, 172, 170, 72, [
        {'t': '採購請款單', 'w': 700, 's': 15},
        {'t': '確認出款', 's': 12, 'c': GREY},
        {'t': 'purchased_on', 's': 10.5, 'c': GREY, 'f': M}], stroke=SLATE))

    rows = [
        (96,  '一般',     '兩個欄位都沒設',        GREEN,
         [('支出', True), ('暫付', False)],
         ['支出：一個項目一列 · 記在這張單自己那本帳']),
        (208, '暫支款',   'advance_category 有值', AMBER,
         [('支出', False), ('暫付', True)],
         ['暫付：一張單一列 · 在安幸', '不產生支出 —— 錢還沒花掉，只是換個地方放']),
        (320, '安幸代墊', 'advance_for_book 有值', SLATE,
         [('支出', True), ('暫付', True)],
         ['支出：一個項目一列 · 在愛皮那本帳', '暫付：一個項目一列 · 在安幸']),
    ]
    for y, name, cond, col, made, notes in rows:
        o.append(elbow([(210, 208), (250, 208), (250, y + 28), (296, y + 28)], color=col, marker='a'))
        o.append(box(296, y, 196, 56, [
            {'t': name, 'w': 700, 's': 15, 'c': col},
            {'t': cond, 's': 10.5, 'c': GREY, 'f': M}], stroke=col))
        x = 530
        for lbl, yes in made:
            o.append(f'<rect x="{x}" y="{y + 4}" width="104" height="48" rx="8" fill="#fff" '
                     f'stroke="{LINE if yes else RED}" stroke-width="1.3"'
                     + ('' if yes else ' stroke-dasharray="4 4"') + '/>')
            o.append(txt(x + 24, y + 34, '✓' if yes else '✗', s=17,
                         c=(GREEN if yes else RED), w=700))
            o.append(txt(x + 66, y + 34, lbl, s=14, c=(INK if yes else RED), w=700))
            x += 118
        cy = y + 22 if len(notes) > 1 else y + 32
        for n in notes:
            o.append(txt(772, cy, n, s=11.5, c=GREY, anchor='start'))
            cy += 19
        o.append(arrow(492, y + 28, 524, y + 28, color=col))

    o.append(box(40, 380, 1080, 40, [
        {'t': '★ 只有「第一次確認出款」會動 —— 單子出款之後再回去把勾勾打上，欄位會變、勾會亮，但一列暫付都不會產生，而且不會有錯誤訊息',
         's': 12.5, 'w': 700}], fill='#FFFBEB', stroke='#FDE68A'))
    return svg(W, H, '\n'.join(o), '請款單三條路：一般、暫支款、安幸代墊，各自產生什麼')


def fig_forfeit():
    """
    被扣那一段的**決策流程** —— 狀態圖說「會走到這裡」，這張說「怎麼判斷」。
    ★ 重點是那顆菱形「已經產生過了嗎」:冪等靠它，
      沒有它的話按兩次「確認收回」就是兩筆支出，而總額只是「多了一筆」。
    """
    W, H = 1240, 470
    o = [txt(W / 2, 34, '被扣：按下「確認收回」之後怎麼判斷', s=19, w=700, c=INK),
         txt(W / 2, 55, '菱形是判斷　·　箭頭上的字是答案　·　三道都過了才產生那筆支出', s=12, c=GREY)]

    def dia(cx, cy, w, h, t1, t2=None, col=INK):
        pts = f'{cx},{cy - h/2} {cx + w/2},{cy} {cx},{cy + h/2} {cx - w/2},{cy}'
        r = [f'<polygon points="{pts}" fill="#fff" stroke="{col}" stroke-width="1.5"/>']
        if t2:
            r.append(txt(cx, cy - 3, t1, s=13, w=700))
            r.append(txt(cx, cy + 15, t2, s=10.5, c=GREY, f=M))
        else:
            r.append(txt(cx, cy + 5, t1, s=13, w=700))
        return '\n'.join(r)

    o.append(box(30, 186, 150, 62, [
        {'t': '按「確認收回」', 'w': 700, 's': 14},
        {'t': '填了收回日與金額', 's': 11, 'c': GREY}], stroke=SLATE))

    o.append(dia(300, 217, 190, 96, '差額 ＞ 0 ？', 'amount − refunded'))
    o.append(arrow(180, 217, 203, 217))

    o.append(dia(580, 217, 210, 96, '已經產生過了嗎？', 'forfeit_expense_id'))
    o.append(arrow(395, 217, 473, 217))
    o.append(label(434, 207, '是'))

    o.append(dia(860, 217, 190, 96, '選了會計科目？'))
    o.append(arrow(685, 217, 763, 217))
    o.append(label(724, 207, '還沒'))

    o.append(box(1060, 176, 150, 82, [
        {'t': '產生一筆支出', 'w': 700, 's': 14},
        {'t': '記費用', 's': 11.5, 'c': RED},
        {'t': '把 id 記回暫付', 's': 10.5, 'c': GREY}], stroke=RED, fill='#FDECEA'))
    o.append(arrow(955, 217, 1054, 217, marker='ar', color=RED))
    o.append(label(1004, 207, '選了', c=RED))

    # 三個「不做事」的出口
    o.append(box(226, 344, 148, 54, [
        {'t': '什麼都不做', 'w': 700, 's': 13},
        {'t': '沒被扣就沒有支出要記', 's': 10.5, 'c': GREY}], stroke=LINE, dash='4 4'))
    o.append(arrow(300, 265, 300, 340, color=GREY, sw=1.5))
    o.append(label(300, 306, '否'))

    o.append(box(506, 344, 148, 54, [
        {'t': '不再產生', 'w': 700, 's': 13, 'c': GREEN},
        {'t': '按十次也只有一筆', 's': 10.5, 'c': GREY}], stroke=GREEN, dash='4 4'))
    o.append(arrow(580, 265, 580, 340, color=GREEN, sw=1.5, marker='ag'))
    o.append(label(580, 306, '產生過了', c=GREEN))

    o.append(box(786, 344, 148, 54, [
        {'t': '擋住，存不了', 'w': 700, 's': 13, 'c': AMBER},
        {'t': '請他去選一個科目', 's': 10.5, 'c': GREY}], stroke=AMBER, dash='4 4'))
    o.append(arrow(860, 265, 860, 340, color=AMBER, sw=1.5))
    o.append(label(860, 306, '沒選', c=AMBER))

    o.append(f'<rect x="16" y="416" width="{W - 32}" height="42" rx="9" fill="#FFFBEB" '
             f'stroke="#FDE68A" stroke-width="1.3"/>')
    o.append(txt(46, 443, '★', s=15, c=AMBER, w=700))
    o.append(txt(68, 442, '中間那顆菱形就是冪等 —— 沒有它，重複按一次就是重複一筆支出，'
                          '而總額看起來只是「多了一筆」，沒有人會回去比對。',
                 s=12.5, c='#7c5a12', anchor='start'))
    return svg(W, H, '\n'.join(o), '被扣的判斷流程：差額、是否已產生、有沒有選科目三道關卡')


PAGE = '''<!doctype html><html lang="zh-Hant"><meta charset="utf-8">
<style>body{{margin:0;background:#F1F0EC}}figure{{margin:0}}svg{{display:block}}</style>
<div id="lend">{a}</div><div id="state">{b}</div><div id="routes">{c}</div><div id="forfeit">{d}</div></html>'''

open('/home/claude/dia/index.html', 'w', encoding='utf-8').write(
    PAGE.format(a=fig_lend(), b=fig_state(), c=fig_routes(), d=fig_forfeit()))
print('written')
