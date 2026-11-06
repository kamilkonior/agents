import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

type Event = { type: "add-question"; id: string; text: string; origin?: string };

type Log = {
  read(): Event[];
  append(event: Event): void;
};

function fileLog(path: string): Log {
  return {
    read() {
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));
    },
    append(event) {
      appendFileSync(path, JSON.stringify(event) + "\n");
    },
  };
}

function memoryLog(events: Event[] = []): Log {
  return {
    read() {
      return [...events];
    },
    append(event) {
      events.push(event);
    },
  };
}

function nextQuestionId(log: Log): string {
  const numbers = log
    .read()
    .filter((event) => event.type === "add-question")
    .map((event) => Number(event.id.slice(1)));
  return `Q${Math.max(0, ...numbers) + 1}`;
}

function exists(log: Log, id: string): boolean {
  return log.read().some((event) => event.id === id);
}

const cliOptions = {
  op: { type: "string" },
} as const;

const addQuestionOptions = {
  text: { type: "string" },
  origin: { type: "string" },
} as const;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readOp() {
  const { op } = parseArgs({ options: cliOptions, strict: false }).values;
  if (op === undefined) fail("missing --op");
  if (typeof op !== "string") fail("--op requires a value");
  return op;
}

function readOpConfig<T extends ParseArgsOptionsConfig>(opOptions: T) {
  try {
    return parseArgs({ options: { ...cliOptions, ...opOptions } }).values;
  } catch (error) {
    fail((error as Error).message);
  }
}

const log = fileLog("designtree.jsonl");
const op = readOp();

switch (op) {
  case "add-question": {
    const config = readOpConfig(addQuestionOptions);
    if (!config.text) fail("add-question requires --text");
    if (config.origin !== undefined && !exists(log, config.origin)) {
      fail(`origin not found: ${config.origin}`);
    }
    const id = nextQuestionId(log);
    log.append({ type: "add-question", id, text: config.text, origin: config.origin });
    console.log(id);
    break;
  }
  default:
    fail(`unknown op: ${op}`);
}
