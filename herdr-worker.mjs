// One-shot pane runner. The private socket doubles as a lease: no start frame,
// no worker; losing the supervisor stops a running worker.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { workerStop } from "./worker-stop.mjs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

const socket = createConnection(process.argv[2]);
const send = frame => !socket.destroyed && socket.write(JSON.stringify(frame) + "\n");
const reader = createInterface({ input: socket, crlfDelay: Infinity });
let child, termination, stopReason, ended = false;
const startup = setTimeout(() => socket.destroy(), 10_000);

// Never allow worker text to masquerade as terminal control sequences.
process.stdout.on("error", () => {});
const clean = text => stripVTControlCharacters(String(text)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
let lineOpen = false;
function endLine() { if (lineOpen) process.stdout.write("\n"); lineOpen = false; }
function print(text) { endLine(); process.stdout.write(clean(text) + "\n"); }
function stop(reason) {
  if (ended || stopReason) return;
  stopReason = reason;
  if (!child) { socket.destroy(); return; }
  termination.request();
}
for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"]) {
  process.on(signal, () => stop(`Herdr worker interrupted (${signal})`));
}
socket.on("error", () => {});
socket.on("close", () => { clearTimeout(startup); stop("Herdr worker lost its supervisor"); });
socket.on("connect", () => send({ type: "hello", paneId: process.env.HERDR_PANE_ID, tabId: process.env.HERDR_TAB_ID }));

reader.on("line", line => {
  let frame;
  try { frame = JSON.parse(line); } catch { stop("Invalid supervisor message"); return; }
  if (frame.type === "stop") { stop("Herdr worker stopped by supervisor"); return; }
  if (frame.type !== "start" || child || stopReason) { stop("Unexpected supervisor message"); return; }
  clearTimeout(startup);
  const env = { ...frame.env, ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("HERDR_"))) };
  let error;
  try {
    child = spawn(frame.command, frame.args, { env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (cause) {
    socket.end(JSON.stringify({ type: "exit", code: 1, error: cause.message }) + "\n");
    return;
  }
  termination = workerStop(child);
  print("Pi subagent running (observation only)");
  child.on("error", cause => { error = cause.message; });
  child.once("exit", () => {
    termination.clear();
    // The private marker survives a broken result socket. Only an observed Pi
    // process exit can create it; tab disappearance and signal delivery cannot.
    try { writeFileSync(frame.stoppedPath, "", { flag: "wx", mode: 0o600 }); } catch { /* Without proof the supervisor fails closed. */ }
  });
  child.on("close", (code, signal) => {
    ended = true;
    termination.clear();
    error ??= stopReason ?? (signal ? `Worker terminated (${signal})` : undefined);
    if (buffer) render(buffer);
    if (stderr) print(stderr);
    print(`Pi subagent ${code === 0 && !error ? "finished" : "stopped"}`);
    // The child has exited and both output streams have drained. Only this
    // explicit frame can produce a successful result; EOF alone never can.
    if (!socket.destroyed) socket.end(JSON.stringify({ type: "exit", code: error ? code || 1 : code ?? 1, error }) + "\n");
  });

  let buffer = "", stderr = "", lastBlock;
  const streamed = new Map();
  function appendText(index, text) {
    const safe = clean(text);
    if (!safe) return;
    if (lastBlock !== index) endLine();
    process.stdout.write(safe);
    lastBlock = index;
    lineOpen = !safe.endsWith("\n");
  }
  function render(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === "tool_execution_start") print(`Running ${String(event.toolName).slice(0, 120)}…`);
    if (event?.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update?.type === "text_delta" && typeof update.delta === "string" && Number.isInteger(update.contentIndex)) {
        const { contentIndex: index, delta } = update;
        streamed.set(index, (streamed.get(index) ?? "") + delta);
        appendText(index, delta);
      }
    }
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      const content = event.message.content;
      if (Array.isArray(content)) content.forEach((part, index) => {
        if (part?.type !== "text" || typeof part.text !== "string") return;
        const prefix = streamed.get(index) ?? "";
        if (part.text.startsWith(prefix)) appendText(index, part.text.slice(prefix.length));
        else print(`Final text: ${part.text}`); // Append-only pane; never erase terminal history.
      });
      endLine();
      streamed.clear(); lastBlock = undefined;
      if (event.message.errorMessage) print(String(event.message.errorMessage).slice(0, 2_000));
    }
  }
  function relay(type, stream, display) {
    stream.setEncoding("utf8").on("data", text => {
      display(text);
      if (!socket.destroyed && !send({ type, text })) stream.pause();
    });
    socket.on("drain", () => stream.resume());
    socket.on("close", () => stream.resume());
  }
  relay("stdout", child.stdout, text => {
    const lines = (buffer + text).split("\n"); buffer = lines.pop(); lines.forEach(render);
  });
  relay("stderr", child.stderr, text => {
    const lines = (stderr + text).split("\n"); stderr = lines.pop(); lines.forEach(print);
  });
});
