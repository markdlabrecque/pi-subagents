// One-shot pane runner. The private socket doubles as a lease: no start frame,
// no worker; losing the supervisor stops a running worker.
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

const socket = createConnection(process.argv[2]);
const send = frame => !socket.destroyed && socket.write(JSON.stringify(frame) + "\n");
const reader = createInterface({ input: socket, crlfDelay: Infinity });
let child, killTimer, stopReason, ended = false;
const startup = setTimeout(() => socket.destroy(), 10_000);

// Never allow worker text to masquerade as terminal control sequences.
process.stdout.on("error", () => {});
const print = text => process.stdout.write(stripVTControlCharacters(String(text)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "") + "\n");
function stop(reason) {
  if (ended || stopReason) return;
  stopReason = reason;
  if (!child) { socket.destroy(); return; }
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
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
  print("Pi subagent running (observation only)");
  child.on("error", cause => { error = cause.message; });
  child.on("close", (code, signal) => {
    ended = true;
    clearTimeout(killTimer);
    error ??= stopReason ?? (signal ? `Worker terminated (${signal})` : undefined);
    if (buffer) render(buffer);
    if (stderr) print(stderr);
    print(`Pi subagent ${code === 0 && !error ? "finished" : "stopped"}`);
    // The child has exited and both output streams have drained. Only this
    // explicit frame can produce a successful result; EOF alone never can.
    if (!socket.destroyed) socket.end(JSON.stringify({ type: "exit", code: error ? code || 1 : code ?? 1, error }) + "\n");
  });

  let buffer = "", stderr = "";
  function render(line) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === "tool_execution_start") print(`Running ${String(event.toolName).slice(0, 120)}…`);
    if (event?.type === "message_end" && event.message?.role === "assistant") {
      const content = event.message.content;
      if (Array.isArray(content)) for (const part of content) if (part?.type === "text" && typeof part.text === "string") print(part.text.slice(0, 50_000));
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
