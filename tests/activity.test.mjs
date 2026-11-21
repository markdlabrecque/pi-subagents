import assert from "node:assert/strict";
import test from "node:test";
import { ACTIVITY_EVENT, createAgentActivity } from "../activity.ts";

const context = { sessionId: "session-a", task: "Inspect authentication", agent: "general", model: "provider/model" };

function recorder(overrides = {}) {
  const events = [];
  const activity = createAgentActivity((name, data) => {
    assert.equal(name, ACTIVITY_EVENT);
    events.push(data);
  }, { ...context, ...overrides });
  return { activity, events };
}

test("one dispatch emits running, progress and exactly one terminal snapshot", () => {
  const { activity, events } = recorder();
  activity.update({ progress: { label: "read" }, stats: { turns: 1, toolCalls: 2, tokens: 0 } });
  activity.finish("completed", "Authentication uses a signed cookie.");
  activity.finish("failed", "duplicate");
  activity.update({ progress: { label: "late tool" } });
  assert.equal(events.length, 3);
  const [start, progress, end] = events;
  assert.equal(start.status, "running");
  assert.equal(start.progress.label, "Preparing agent");
  assert.equal(progress.progress.label, "read");
  assert.deepEqual(progress.stats, { turns: 1, toolCalls: 2, tokens: 0 });
  assert.equal(end.status, "completed");
  assert.equal(end.progress, undefined);
  assert.equal(end.result, "Authentication uses a signed cookie.");
  assert.equal(end.endedAt, end.updatedAt);
  for (const [index, item] of events.entries()) {
    assert.equal(item.version, 1);
    assert.equal(item.sessionId, context.sessionId);
    assert.equal(item.producer, "subagents");
    assert.equal(item.id, start.id);
    assert.equal(item.revision, index + 1);
    assert.ok(Date.parse(item.updatedAt) >= Date.parse(item.startedAt));
  }
});

test("workflow redispatches have distinct identities, not the stable role name", () => {
  const first = recorder(), second = recorder();
  assert.notEqual(first.events[0].id, second.events[0].id);
});

for (const status of ["failed", "cancelled"]) {
  test(`${status} is not presented as successful completion`, () => {
    const { activity, events } = recorder();
    activity.finish(status, "A reason");
    assert.equal(events.at(-1).status, status);
    assert.equal(events.at(-1).result, "A reason");
  });
}

test("content is bounded by UTF-8 bytes without splitting code points", () => {
  const { activity, events } = recorder({ task: "🔎".repeat(200), model: "m".repeat(400), agent: "a".repeat(200) });
  activity.update({ progress: { label: "界".repeat(1000) } });
  activity.finish("completed", "界".repeat(16000) + "\x1b\x00");
  const end = events.at(-1);
  assert.ok(Buffer.byteLength(end.title) <= 240);
  assert.equal(end.model.length, 256);
  assert.equal(end.agent.length, 128);
  assert.ok(Buffer.byteLength(events[1].progress.label) <= 512);
  assert.ok(Buffer.byteLength(end.result) <= 16000);
  assert.doesNotMatch(JSON.stringify(events), /�|\\u001b|\\u0000/);
});

test("missing usage is omitted, zero remains zero and invalid usage is not published", () => {
  const { activity, events } = recorder();
  activity.update({ stats: { turns: 0, toolCalls: -1, tokens: undefined } });
  assert.deepEqual(events.at(-1).stats, { turns: 0 });
  activity.update({ stats: { turns: NaN, toolCalls: Infinity, tokens: 1.5 } });
  assert.deepEqual(events.at(-1).stats, {});
});

test("unchanged updates do not consume revisions or flood the bridge", () => {
  const { activity, events } = recorder();
  activity.update({ progress: { label: "read" } });
  activity.update({ progress: { label: "read" } });
  assert.equal(events.length, 2);
  assert.equal(events.at(-1).revision, 2);
});

test("throwing or mutating listeners cannot change subsequent snapshots", () => {
  const seen = [];
  const activity = createAgentActivity((_name, data) => {
    seen.push(structuredClone(data));
    data.sessionId = "wrong-session";
    data.status = "failed";
    data.progress.label = "mutated";
    throw new Error("presentation failed");
  }, context);
  assert.doesNotThrow(() => activity.update({ progress: { label: "read" } }));
  assert.doesNotThrow(() => activity.finish("completed", "done"));
  assert.equal(seen.length, 3);
  assert.equal(seen.at(-1).sessionId, "session-a");
  assert.equal(seen.at(-1).status, "completed");
});

test("no session identity means no routable UI event", () => {
  const { activity, events } = recorder({ sessionId: "" });
  activity.finish("completed", "done");
  assert.equal(events.length, 0);
});
