import { afterEach, expect, it } from "vitest";
import { createCliTestHarness } from "./cli-runtime.test-support.js";
import { executeClaudeCli } from "./cli.runtime.js";

const harness = createCliTestHarness("claude-deep-tasks-");
afterEach(() => harness.cleanup());

// Adapted from stable 8bf0e03: native stdio snapshots, not internal hold-set assertions.
const fixture = String.raw`
import { createInterface } from "node:readline";
const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const system = (subtype, fields) => send({ type: "system", subtype, ...fields });
const result = (answer, fields = {}) => send({ type: "result", subtype: "success",
  result: answer, session_id: "deep-fixture", num_turns: 1, stop_reason: "end_turn", ...fields });
const scenario = JSON.parse(process.env.DEEP_SCENARIO);
let input = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    system("init", { capabilities: ["msg_lifecycle_v1"] });
    if (scenario.beforeInput) system("background_tasks_changed", { tasks: scenario.beforeInput });
  } else if (message.type === "user") {
    send({ type: "command_lifecycle", state: "started", command_uuid: message.uuid });
    if (++input > 1) { result("warm reply"); continue; }
    system("task_started", { ...scenario.tasks.find(task => task.task_id === scenario.chain[0]), is_backgrounded: true });
    system("background_tasks_changed", { tasks: scenario.tasks });
    result("waiting");
    if (scenario.stopAfterWaiting) continue;
    for (const id of scenario.chain) {
      system("task_notification", { task_id: id, status: "completed" });
      result(id + " reply", { origin: { kind: "task-notification" } });
    }
  }
}
`;

type Task = {
  task_id: string;
  task_type: "local_agent" | "local_workflow";
  parent_task_id?: string;
  owned_by_subagent?: boolean;
};
type Scenario = {
  chain: string[];
  tasks: Task[];
  beforeInput?: Task[];
  stopAfterWaiting?: boolean;
};

function scenario(order: number[], taskType: Task["task_type"]): Scenario {
  const chain = order.map((_, index) => "level-" + index);
  return {
    chain,
    tasks: order.map((index) => ({
      task_id: chain[index]!,
      task_type: taskType,
      ...(index > 0 ? { parent_task_id: chain[index - 1]! } : {}),
    })),
  };
}

async function context(value: Scenario) {
  return harness.context(
    fixture,
    { liveSession: harness.liveSession() },
    { DEEP_SCENARIO: JSON.stringify(value) },
  );
}

async function assertAnswers(value: Scenario, excludedDescendants = false) {
  const ctx = await context(value);
  const results: Record<string, unknown>[] = [];
  for await (const record of executeClaudeCli(ctx)) {
    if (record.type === "result") {
      results.push(record);
    }
  }
  expect(results.map((record) => record.result)).toEqual([
    "waiting",
    ...value.chain.map((id) => id + " reply"),
  ]);
  expect(results.slice(0, -1).every((record) => record.openclaw_interim_result === true)).toBe(
    true,
  );
  expect(results.at(-1)).not.toHaveProperty("openclaw_interim_result");
  if (excludedDescendants) {
    // Main retires any still-running descendant rather than lending it warm-turn authority.
    expect(ctx.liveSession?.current()).toBeUndefined();
    return;
  }
  expect(ctx.liveSession?.current()?.isIdle()).toBe(true);
  const warm: Record<string, unknown>[] = [];
  for await (const record of executeClaudeCli({ ...ctx, useResume: true, prompt: "next" })) {
    if (record.type === "result") {
      warm.push(record);
    }
  }
  expect(warm.map((record) => record.result)).toEqual(["warm reply"]);
}

const orders = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
  [4, 3, 2, 1, 0],
  [2, 4, 0, 3, 1],
];
it.each(
  (["local_agent", "local_workflow"] as const).flatMap((taskType) =>
    orders.map((order) => ({ taskType, order })),
  ),
)("retains deep answers for $taskType snapshot $order", async ({ taskType, order }) => {
  await assertAnswers(scenario(order, taskType));
});

it.each(["owned", "old-input", "cycle", "orphan"] as const)(
  "does not acquire holds through excluded %s ancestry",
  async (exclusion) => {
    const value = scenario([2, 1, 0], "local_agent");
    const excluded: Task = {
      task_id: "excluded",
      task_type: "local_workflow",
      parent_task_id: value.chain[0],
    };
    const child: Task = {
      task_id: "excluded-child",
      task_type: "local_agent",
      parent_task_id: excluded.task_id,
    };
    if (exclusion === "owned") {
      excluded.owned_by_subagent = true;
    } else if (exclusion === "old-input") {
      value.beforeInput = [excluded];
    } else if (exclusion === "cycle") {
      excluded.parent_task_id = child.task_id;
    } else {
      excluded.parent_task_id = "unknown-parent";
    }
    value.tasks.unshift(child, excluded);
    await assertAnswers(value, true);
  },
);

it("retires deep holds when the stream consumer cancels", async () => {
  const value = scenario([4, 3, 2, 1, 0], "local_agent");
  value.stopAfterWaiting = true;
  const ctx = await context(value);
  let sawWaiting = false;
  for await (const record of executeClaudeCli(ctx)) {
    if (record.type === "result") {
      expect(record).toMatchObject({ result: "waiting", openclaw_interim_result: true });
      sawWaiting = true;
      break;
    }
  }
  expect(sawWaiting).toBe(true);
  expect(ctx.liveSession?.current()).toBeUndefined();
});
