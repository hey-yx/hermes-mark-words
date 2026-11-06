"""hermes-mark-words 的 Python 半边：把 reply-word-marks 技能打进插件包。

桌面端的标注 UI 在 desktop/plugin.js，由 Electron 主进程复制到
~/.hermes/desktop-plugins/<id>/ 加载；这里只负责让「怎么写标记块」的约定
随插件一起交付，装上插件就有，不用再单独配一个技能。

两件事：
  1. register_skill —— 把 skills/reply-word-marks/SKILL.md 注册成
     hermes-mark-words:reply-word-marks，可被 skill_view 加载，列进可用技能。
  2. register_system_prompt_section —— 往每个新会话的提示词里注入一段精简
     契约（格式 + 口径），让回复末尾稳定带上 ::hmw 标记块；没标记块的回复
     插件不标注，这是正常结果，不补不猜。
"""

from pathlib import Path

_SKILL_DIR = Path(__file__).resolve().parent / "skills" / "reply-word-marks"
_SKILL_MD = _SKILL_DIR / "SKILL.md"

# 常驻注入的精简契约：只留「什么时候写 + 格式 + 不凑数」，细节交给技能本体。
_CONTRACT = """hermes-mark-words 词标记块

写桌面端给用户看的最终回复时，若正文里有读者会存疑的词（疑似生造、含义不明或用法有歧义、值得追问核实），就在回复末尾追加隐藏的 ::hmw 标记块，给这些词加下划线和悬停解释。每词一条，每条单独成段，段之间空一行（少了空行整块会显示成正文）：

::hmw{term="正文里的原词", kind="unclear", explain="这个词在这段话里指什么、是干嘛用的，60 字内", note="不确定处或来源", q1="能直接问的具体追问"}

kind 取 fabricated（疑似生造）、unclear（含义不明）、term（用法值得商榷）之一。term 逐字取自正文，不改写不翻译。只标有疑点的词，不标基础词、标准术语、路径、命令、版本号。一段回复 0 到 3 个，一个够格的都没有就整块不写，绝不凑数。没标记块的回复插件不会标注，这是正常的。完整口径见 reply-word-marks 技能。"""


def register(ctx):
    if _SKILL_MD.exists():
        ctx.register_skill("reply-word-marks", _SKILL_MD)
    ctx.register_system_prompt_section("mark-words", _CONTRACT)
