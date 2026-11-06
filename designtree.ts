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
  test: { type: "boolean" },
} as const;

const testOptions = {} as const;

const addQuestionOptions = {
  text: { type: "string" },
  origin: { type: "string" },
} as const;

class DesignTreeError extends Error {}

type Mode = { kind: "test" } | { kind: "op"; op: string };

function readMode(): Mode {
  const { op, test } = parseArgs({ options: cliOptions, strict: false }).values;
  if (op !== undefined && test !== undefined) {
    throw new DesignTreeError("--op and --test are mutually exclusive");
  }
  if (test !== undefined) return { kind: "test" };
  if (op === undefined) throw new DesignTreeError("missing --op or --test");
  if (typeof op !== "string") throw new DesignTreeError("--op requires a value");
  return { kind: "op", op };
}

function readModeConfig<T extends ParseArgsOptionsConfig>(modeOptions: T) {
  try {
    return parseArgs({ options: { ...cliOptions, ...modeOptions } }).values;
  } catch (error) {
    throw new DesignTreeError((error as Error).message);
  }
}

function runTests() {}

function main() {
  const mode = readMode();
  if (mode.kind === "test") {
    readModeConfig(testOptions);
    runTests();
    return;
  }
  runOp(fileLog("designtree.jsonl"), mode.op);
}

function runOp(log: Log, op: string) {
  switch (op) {
    case "add-question": {
      const config = readModeConfig(addQuestionOptions);
      if (!config.text) throw new DesignTreeError("add-question requires --text");
      if (config.origin !== undefined && !exists(log, config.origin)) {
        throw new DesignTreeError(`origin not found: ${config.origin}`);
      }
      const id = nextQuestionId(log);
      log.append({ type: "add-question", id, text: config.text, origin: config.origin });
      console.log(id);
      break;
    }
    default:
      throw new DesignTreeError(`unknown op: ${op}`);
  }
}

try {
  main();
} catch (error) {
  if (!(error instanceof DesignTreeError)) throw error;
  console.error(error.message);
  process.exit(1);
}
