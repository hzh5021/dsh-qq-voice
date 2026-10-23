/**
 * dsh-qq-voice — 给 QQ 那一条线单独装一张嘴。
 *
 * 为什么得在插件这一层做：QQ 那条会话是 dsh-qq 用 ctx.agents.create 开的，
 * 挂的是同一个 preset、同一份系统提示 —— 而通用人设讲的是"这个 agent 是什么样"，
 * 管不了"这条管道只放得下多少字"。两套口径打起来，输的永远是长度那条。
 *
 * 所以：把这份渠道口径挂成**这一段会话的系统提示段**，只挂进 QQ 的 preset。
 *  - 走 systemPrompt.section（提示词），不走 agent.inject（消息）—— 后者
 *    会进消息历史、每轮都占上下文，而这是长期口径，该待在系统提示里。
 *  - 文本每次组装时再解析（带 mtime 缓存），改 md 就生效，不必重装插件。
 *  - 只认得到 home 里那份文件；读不到就整段不挂，绝不把 boot 弄崩。
 *
 * @module dsh-qq-voice
 */

export const name = "dsh-qq-voice";

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * systemPrompt 是宿主注册表里的服务；没报名连读都不让读（Cordis 规矩）。
 * 不加别的：这个插件除了往提示词里放一段字，什么都不干。
 */
export const inject = ["systemPrompt"];

const TAG = "[dsh-qq-voice]";

const DEFAULTS = {
  /** 家目录。口径文件在这儿；**不配就不挂这一段**（空字符串 = 关闭）。 */
  home: "",
  /** 口径文件名（相对家目录）。 */
  file: "QQ线口径.md",
  /**
   * 插在哪一节后面。
   * 位置比内容要紧：DEPLOYMENT_PERSONA_SUFFIX 是部署级人设的尾巴，
   * 排在它之后、工具说明之前 —— 先读完"我是谁"，紧接着就是这条渠道的规矩。
   */
  after: "DEPLOYMENT_PERSONA_SUFFIX",
  /** 拿不到 after 那一节的顺序时，退到这个值。 */
  fallbackOrder: 10201,
};

const log = (...a) => console.log(TAG, ...a);

/**
 * 带 mtime 缓存的读文件。
 * 提示段每次组装都求值，做不到"启动时读一遍就完"；可每轮都读盘也没必要。
 * mtime 没变就用缓存，变了就重读 —— 这样改完 md 下一轮就生效。
 */
function makeReader(path) {
  let cached = null;
  let stamp = -1;
  return () => {
    try {
      const s = statSync(path);
      if (cached !== null && s.mtimeMs === stamp) return cached;
      const text = String(readFileSync(path, "utf8")).trim();
      if (!text) return null;
      cached = text;
      stamp = s.mtimeMs;
      return text;
    } catch (e) {
      // 文件不在、读不动：不挂这一段。不能因为一张嘴坏了就让人没得说话。
      return null;
    }
  };
}

export function apply(ctx, config = {}) {
  const opts = { ...DEFAULTS, ...(config && typeof config === "object" ? config : {}) };
  const home = String(opts.home || "").trim();
  // 没配家目录就整段不挂：不去猜路径，也不让相对路径落到进程的当前工作目录上。
  if (home === "") {
    log("no home configured — QQ line keeps the default wording");
    return;
  }
  const path = join(home, String(opts.file || DEFAULTS.file));
  const read = makeReader(path);

  // 先确认文件在。不在就直说，别留一个安静的哑巴。
  const first = read();
  if (first === null) {
    log(`no voice file at ${path} — QQ line keeps the default wording`);
  } else {
    log(`voice file ${path} (${first.length} chars)`);
  }

  // 位置：问注册表要 after 那一节的顺序值。
  // getSectionOrder 只有宿主自带的贡献方才用得上；外部贡献也可以给任意有限的
  // 顺序值。所以拿不到就退到 fallbackOrder，不能因为要不到位置就不挂。
  let order = DEFAULTS.fallbackOrder;
  try {
    if (typeof ctx.systemPrompt?.getSectionOrder === "function") {
      const got = ctx.systemPrompt.getSectionOrder(opts.after);
      if (typeof got === "number" && Number.isFinite(got)) order = got + 1;
    }
  } catch (e) {
    log(`getSectionOrder(${opts.after}) failed, using ${order}:`, (e && e.message) || e);
  }

  try {
    ctx.systemPrompt.section({
      name: "qq-voice:channel",
      order,
      // 每次组装时求值：文件改了，下一轮就换新的。
      // 内容是中文，interpolate 关掉 —— 那段里不该有 {{…}} 被当变量解析。
      text: () => {
        const text = read();
        if (text === null) return "";
        return "【本渠道怎么说话】以下只约束当前这条渠道，与通用说话规则冲突时以本段为准。\n\n" + text;
      },
      interpolate: false,
    });
    log(`mounted at order ${order}`);
  } catch (e) {
    // 挂不上也绝不能把 agent 建不起来。
    log("mount failed:", (e && e.message) || e);
  }
}