import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalStore, now } from "./local";
export async function createExampleArtifacts(store: LocalStore): Promise<void> {
  if (store.state.artifacts.some((a) => a.id === "example-preview")) return;
  const root = join(store.dir, "examples");
  await mkdir(root, { recursive: true });
  const html = join(root, "workspace-preview.html");
  await writeFile(
    html,
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#f3f7f4;color:#12271b;padding:40px}.eyebrow{font-size:9px;letter-spacing:2px;color:#528d76}.hero{border-radius:20px;background:radial-gradient(ellipse at 100% 0,#174b37,transparent 70%),#0b1d13;padding:44px 35px;color:#ecf9ef;margin-top:22px}h1{font-size:clamp(28px,6vw,56px);font-weight:450;line-height:1.05;letter-spacing:-2px;margin:0 0 20px}h1 span{color:#8db6a0}p{font-size:12px;line-height:1.9;color:#8fae99;max-width:390px}.pill{display:inline-block;margin-top:20px;border-radius:30px;background:#bde9d0;color:#163d27;font-size:10px;padding:12px 18px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:20px}.card{padding:22px 18px;background:#fff;border:1px solid #e1eadf;border-radius:12px}.card small{font-size:9px;color:#8da18d}.card h2{font-size:18px;font-weight:500;letter-spacing:-.5px}.card p{font-size:10px;color:#889d86}.caption{font-size:8px;letter-spacing:1px;color:#91a38d;margin-top:22px}</style></head><body><div class="eyebrow">MEMCODE · EXAMPLE ARTIFACT</div><section class="hero"><h1>Ideas, made real.<br><span>Work, kept in focus.</span></h1><p>A local workspace for the conversations, context and coordinated work that turn an idea into working software.</p><span class="pill">Your code. Your fleet. Your workspace. ↗</span></section><div class="grid"><div class="card"><small>01 / UNDERSTAND</small><h2>Context first.</h2><p>Ground the work in source relationships and a clear brief.</p></div><div class="card"><small>02 / COORDINATE</small><h2>Move together.</h2><p>Give every worker a focused place in the bigger picture.</p></div><div class="card"><small>03 / REVIEW</small><h2>See the result.</h2><p>Keep changes, previews and artifacts close to the work.</p></div></div><div class="caption">ILLUSTRATIVE DESIGN OUTPUT · NO AGENT WAS RUN TO PRODUCE THIS EXAMPLE</div></body></html>`,
  );
  store.state.artifacts.push({
    id: "example-preview",
    name: "workspace-preview.html",
    kind: "html",
    path: html,
    taskId: "example-06",
    projectId: "example",
    createdAt: now(),
    source: "Example output",
  });
  const text = join(root, "workspace-notes.md");
  await writeFile(
    text,
    "# MemCode workspace notes\n\nThis is an example artifact.\n\n- MemCode is an independent Tauri app.\n- Memtrace supplies code intelligence and Fleet coordination.\n- Task workers share a goal branch with Memtrace Fleet coordination.\n- Conversations, runbooks, changes and artifacts stay together.\n- A finished worker produces a review candidate.\n",
  );
  store.state.artifacts.push({
    id: "example-notes",
    name: "workspace-notes.md",
    kind: "text",
    path: text,
    taskId: "example-08",
    projectId: "example",
    createdAt: now(),
    source: "Example output",
  });
  await store.save();
}
