import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

type Event = { type: "add-question"; id: string; text: string; origin?: string };

type Log = {
  read(): Event[];
  append(event: Event): void;
};

const Log = (() => {
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

  function exists(log: Log, id: string): boolean {
    return log.read().some((event) => event.id === id);
  }

  return { fileLog, memoryLog, exists };
})();

function nextQuestionId(log: Log): string {
  const numbers = log
    .read()
    .filter((event) => event.type === "add-question")
    .map((event) => Number(event.id.slice(1)));
  return `Q${Math.max(0, ...numbers) + 1}`;
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

function addQuestion(log: Log, text: string, origin?: string): string {
  if (origin !== undefined && !Log.exists(log, origin)) {
    throw new DesignTreeError(`origin not found: ${origin}`);
  }
  const id = nextQuestionId(log);
  const event: Event = { type: "add-question", id, text };
  if (origin !== undefined) event.origin = origin;
  log.append(event);
  return id;
}

function runTests() {
  test("first question in an empty log gets Q1", () => {
    const log = Log.memoryLog();
    assert.equal(addQuestion(log, "a"), "Q1");
  });

  test("question ids go up in order", () => {
    const log = Log.memoryLog();
    assert.equal(addQuestion(log, "a"), "Q1");
    assert.equal(addQuestion(log, "b"), "Q2");
  });

  test("question without origin is stored without an origin field", () => {
    const log = Log.memoryLog();
    addQuestion(log, "a");
    assert.deepEqual(log.read(), [{ type: "add-question", id: "Q1", text: "a" }]);
  });

  test("question with an existing origin is stored with it", () => {
    const log = Log.memoryLog();
    addQuestion(log, "a");
    addQuestion(log, "b", "Q1");
    assert.deepEqual(log.read()[1], { type: "add-question", id: "Q2", text: "b", origin: "Q1" });
  });

  test("question with an unknown origin throws and appends nothing", () => {
    const log = Log.memoryLog();
    assert.throws(() => addQuestion(log, "a", "Q9"), DesignTreeError);
    assert.deepEqual(log.read(), []);
  });
}

function main() {
  const mode = readMode();
  if (mode.kind === "test") {
    readModeConfig(testOptions);
    runTests();
    return;
  }
  runOp(Log.fileLog("designtree.jsonl"), mode.op);
}

function runOp(log: Log, op: string) {
  switch (op) {
    case "add-question": {
      const config = readModeConfig(addQuestionOptions);
      if (!config.text) throw new DesignTreeError("add-question requires --text");
      console.log(addQuestion(log, config.text, config.origin));
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
