import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let activeThreadId = "thread-fake";

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    if (!Array.isArray(message.params.dynamicTools) || message.params.dynamicTools[0]?.name !== "taskboard") {
      return send({ id: message.id, error: { message: "dynamic tools missing" } });
    }
    return send({ id: message.id, result: { thread: { id: activeThreadId } } });
  }
  if (message.method === "thread/resume") {
    if (Object.hasOwn(message.params, "dynamicTools")) {
      return send({ id: message.id, error: { message: "dynamic tools are invalid on thread/resume" } });
    }
    activeThreadId = message.params.threadId;
    return send({ id: message.id, result: { thread: { id: activeThreadId } } });
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-fake" } } });
    setTimeout(() => {
      send({ method: "turn/started", params: { turn: { id: "turn-fake" } } });
      send({
        id: "server-tool-request",
        method: "item/tool/call",
        params: {
          callId: "call-fake",
          threadId: activeThreadId,
          turnId: "turn-fake",
          namespace: "taskboard",
          tool: "list_projects",
          arguments: {},
        },
      });
    }, 10);
    return;
  }
  if (message.id === "server-tool-request") {
    const item = message.result?.contentItems?.[0];
    if (message.result?.success !== true || item?.type !== "inputText" || !item.text.includes("project-fake")) {
      return send({ method: "turn/completed", params: { turn: { id: "turn-fake", status: "failed", error: { message: "invalid tool response" } } } });
    }
    send({ method: "item/completed", params: { item: { type: "agentMessage", text: "tool round trip complete" } } });
    send({ method: "turn/completed", params: { turn: { id: "turn-fake", status: "completed" } } });
  }
});
