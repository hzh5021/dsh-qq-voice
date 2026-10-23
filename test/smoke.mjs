/**
 * dsh-qq-voice 冒烟测试。
 *
 * 不碰 profile、不碰 DSH 进程，也**不读任何真文件**：用 tmpdir 造一个临时家、
 * 往里写一份样例口径，再跑 apply()，看它挂出来的段对不对 —— order 取没取到、
 * 文本读没读到、文件不在时会不会安静地空着。
 *
 * 跑法：node test/smoke.mjs
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apply } from "../lib/index.js";

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log((ok ? "  ok   " : "  FAIL ") + label + (extra ? " — " + extra : ""));
  if (!ok) failures += 1;
};

/** 样例口径：够短，且带上断言要认的那两句。 */
const SAMPLE = [
  "# 渠道口径（样例）",
  "",
  "- 一轮只发一条。",
  "- 两行以内，不换行。",
].join("\n");

/** 临时家：造一个空目录 + 一份样例口径。 */
async function makeHome() {
  const dir = await mkdtemp(join(tmpdir(), "qq-voice-"));
  const file = "channel-voice.md";
  await writeFile(join(dir, file), SAMPLE, "utf8");
  return { dir, file };
}

/** 假 ctx：section 记下来，getSectionOrder 照宿主的形状给值。 */
function makeCtx() {
  const sections = [];
  const orders = {
    HARNESS_IDENTITY: -1000,
    DEPLOYMENT_PERSONA_SUFFIX: 10200,
  };
  return {
    sections,
    systemPrompt: {
      section(s) {
        if (!s || typeof s.name !== "string") throw new Error("section needs a name");
        if (typeof s.order !== "number" || !Number.isFinite(s.order)) {
          throw new Error("section needs a finite order");
        }
        sections.push(s);
      },
      getSectionOrder(name) {
        return orders[name];
      },
    },
  };
}

console.log("dsh-qq-voice smoke");

const home = await makeHome();

// 1) 正常路径：文件在，位置能取到
{
  const ctx = makeCtx();
  apply(ctx, { home: home.dir, file: home.file });
  check("挂了一段", ctx.sections.length === 1, `got ${ctx.sections.length}`);
  const s = ctx.sections[0];
  check("段名固定", s?.name === "qq-voice:channel", String(s?.name));
  check("插在 persona 后缀之后", s?.order === 10201, `order=${s?.order}`);
  check("关掉变量插值", s?.interpolate === false);
  const text = typeof s?.text === "function" ? s.text() : "";
  check("读到了文件内容", text.includes("两行以内") || text.includes("一轮只发一条"), `${text.length} chars`);
  check("带了渠道说明头", text.includes("只约束当前这条渠道"));
  check("内容是中文口径", text.includes("一轮只发一条"));
}

// 2) 拿不到 getSectionOrder：退到 fallback，不能崩
{
  const ctx = makeCtx();
  ctx.systemPrompt.getSectionOrder = () => undefined;
  apply(ctx, { home: home.dir });
  check("要不到位置也能挂", ctx.sections.length === 1);
  check("退到 fallbackOrder", ctx.sections[0]?.order === 10201, `order=${ctx.sections[0]?.order}`);
}

// 3) getSectionOrder 直接抛：一样不能崩
{
  const ctx = makeCtx();
  ctx.systemPrompt.getSectionOrder = () => {
    throw new Error("boom");
  };
  let threw = false;
  try {
    apply(ctx, { home: home.dir });
  } catch (e) {
    threw = true;
  }
  check("getSectionOrder 抛错也不崩", !threw && ctx.sections.length === 1);
}

// 4) 文件不存在：段还在（空文本），不能把 boot 弄崩
{
  const ctx = makeCtx();
  let threw = false;
  try {
    apply(ctx, { home: home.dir, file: "这份文件不存在.md" });
  } catch (e) {
    threw = true;
  }
  check("文件不在也不崩", !threw);
  if (ctx.sections.length === 1) {
    const text = ctx.sections[0].text();
    check("空文本而不是乱码", text === "", JSON.stringify(text).slice(0, 60));
  }
}

// 5) section 本身抛错：不能把 boot 弄崩
{
  const ctx = makeCtx();
  ctx.systemPrompt.section = () => {
    throw new Error("registry full");
  };
  let threw = false;
  try {
    apply(ctx, { home: home.dir });
  } catch (e) {
    threw = true;
  }
  check("挂不上也不崩", !threw);
}

await rm(home.dir, { recursive: true, force: true });

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);