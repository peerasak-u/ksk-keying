// Token-free fake engine: emits the same event shapes engine.ts expects from a
// real `claude -p --output-format stream-json` run, so the rest of the system
// (persistence, SSE, frontend) can't tell the difference. Zero API cost.
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { RunState } from "./engine.ts";
import { config } from "./config.ts";

const STAGE_LINES = [
  "Stage 0 Profile — อ่านโฟลเดอร์ลูกค้า สร้าง CLIENT.md",
  "Stage 1 Segment — เริ่มสแกนโฟลเดอร์เอกสาร แบ่งเป็น segments",
  "Stage 2 Interpret — ตีความ segment ที่อนุมัติแล้ว",
  "Stage 3 Link — เชื่อมโยง segment ที่เป็นธุรกรรมเดียวกัน",
  "Stage 4 Group — จัดกลุ่มเอกสารตามหมวดหมู่บัญชี",
  "Stage 5 Categorize — จับคู่กลุ่มเอกสารกับผังบัญชี",
];

function randomDelay(min = 300, max = 800): number {
  return min + Math.floor(Math.random() * (max - min));
}

/** Spawn a fake run. resumeSessionId set => resume flow (shorter); else full flow. */
export function spawnMock(
  run: RunState,
  resumeSessionId: string | null,
  onEvent: (evt: any) => void,
  onExit: (code: number | null) => void,
): { stop: () => void } {
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;

  const schedule = (delayMs: number, fn: () => void) => {
    const t = setTimeout(() => {
      if (stopped) return;
      fn();
    }, delayMs);
    timers.push(t);
  };

  let t = 0;

  if (!resumeSessionId) {
    schedule((t += randomDelay(100, 300)), () => {
      onEvent({
        type: "system",
        subtype: "init",
        session_id: `mock-${run.id}`,
        model: "mock-model",
      });
    });

    for (const line of STAGE_LINES) {
      schedule((t += randomDelay()), () => {
        onEvent({
          type: "assistant",
          message: { content: [{ type: "text", text: line }] },
        });
      });
    }

    schedule((t += randomDelay()), () => {
      onEvent({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }],
        },
      });
    });

    schedule((t += randomDelay()), () => {
      onEvent({
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "Ledger Gate: รอการตรวจทาน — เปิด ตรวจทาน/index.html",
            },
          ],
        },
      });
    });

    schedule((t += randomDelay()), () => {
      onEvent({
        type: "result",
        subtype: "success",
        result: "mock run complete",
        total_cost_usd: 0.0123,
        num_turns: STAGE_LINES.length + 2,
      });
      onExit(0);
    });
  } else {
    schedule((t += randomDelay()), () => {
      onEvent({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "ดำเนินการต่อจากจุดที่ค้างไว้…" }],
        },
      });
    });
    schedule((t += randomDelay()), () => {
      onEvent({
        type: "assistant",
        message: { content: [{ type: "text", text: "เสร็จสิ้นการตรวจทานเพิ่มเติม" }] },
      });
    });
    schedule((t += randomDelay()), () => {
      onEvent({
        type: "result",
        subtype: "success",
        result: "mock resume complete",
        total_cost_usd: 0.0041,
        num_turns: 2,
      });
      onExit(0);
    });
  }

  return {
    stop: () => {
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

/** Only when mock mode is using the auto-created demo workspace (no explicit
 * KSK_WORKSPACE_ROOT env var). Idempotent — safe to call on every boot. */
export async function ensureDemoWorkspace(): Promise<void> {
  if (config.engineMode !== "mock" || process.env.KSK_WORKSPACE_ROOT) return;

  const monthDir = join(config.workspaceRoot, "บจ.ตัวอย่าง จำกัด", "มิ.ย. 2569");
  const reviewDir = join(monthDir, "ตรวจทาน");
  const files: Array<[string, string]> = [
    [join(monthDir, "ใบกำกับภาษี_001.pdf"), "placeholder invoice document (demo, not a real PDF)\n"],
    [
      join(reviewDir, "index.html"),
      "<!doctype html>\n<html lang=\"th\"><head><meta charset=\"utf-8\">" +
        "<title>ตรวจทาน</title></head><body><h1>หน้าตรวจทาน (ตัวอย่าง)</h1>" +
        "<p>นี่คือหน้าตรวจทานตัวอย่างสำหรับ demo workspace</p></body></html>\n",
    ],
  ];

  for (const [path, content] of files) {
    if (existsSync(path)) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
  }
}
