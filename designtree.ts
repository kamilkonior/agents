import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

type Event =
  | { type: "add-question"; id: string; text: string; origin?: string }
  | { type: "add-option"; id: string; text: string; origin: string };

type Log = {
  read(): Event[];
  append(event: Event): void;
};

class DesignTreeError extends Error {}

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

  function find(log: Log, id: string): Event | undefined {
    return log.read().find((event) => event.id === id);
  }

  function has(log: Log, id: string): boolean {
    return find(log, id) !== undefined;
  }

  return { fileLog, memoryLog, find, has };
})();

const AddQuestion = (() => {
  const options = {
    text: { type: "string" },
    origin: { type: "string" },
  } as const;

  function nextQuestionId(log: Log): string {
    const numbers = log
      .read()
      .filter((event) => event.type === "add-question")
      .map((event) => Number(event.id.slice(1)));

    return `Q${Math.max(0, ...numbers) + 1}`;
  }

  function addQuestion(log: Log, text: string, origin?: string): string {
    if (origin !== undefined && !Log.has(log, origin)) {
      throw new DesignTreeError(`origin not found: ${origin}`);
    }

    const id = nextQuestionId(log);
    const event: Event = { type: "add-question", id, text };
    if (origin !== undefined) event.origin = origin;

    log.append(event);

    return id;
  }

  function run(log: Log, config: { text?: string; origin?: string }): string {
    if (!config.text) throw new DesignTreeError("add-question requires --text");

    return addQuestion(log, config.text, config.origin);
  }

  function tests() {
    test("first question in an empty log gets Q1", () => {
      // given
      const log = Log.memoryLog();

      // when
      const id = addQuestion(log, "a");

      // then
      assert.equal(id, "Q1");
    });

    test("question ids go up in order", () => {
      // given
      const log = Log.memoryLog();
      addQuestion(log, "a");

      // when
      const id = addQuestion(log, "b");

      // then
      assert.equal(id, "Q2");
    });

    test("question without origin is stored without an origin field", () => {
      // given
      const log = Log.memoryLog();

      // when
      addQuestion(log, "a");

      // then
      assert.deepEqual(log.read(), [{ type: "add-question", id: "Q1", text: "a" }]);
    });

    test("question with an existing origin is stored with it", () => {
      // given
      const log = Log.memoryLog();
      addQuestion(log, "a");

      // when
      addQuestion(log, "b", "Q1");

      // then
      assert.deepEqual(log.read()[1], { type: "add-question", id: "Q2", text: "b", origin: "Q1" });
    });

    test("question with an unknown origin throws and appends nothing", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => addQuestion(log, "a", "Q9");

      // then
      assert.throws(act, DesignTreeError);
      assert.deepEqual(log.read(), []);
    });
  }

  return { options, run, tests };
})();

const Cli = (() => {
  const cliOptions = {
    op: { type: "string" },
    test: { type: "boolean" },
  } as const;

  const testOptions = {} as const;

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

  function runTests() {
    AddQuestion.tests();
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
        const config = readModeConfig(AddQuestion.options);
        console.log(AddQuestion.run(log, config));
        break;
      }
      default:
        throw new DesignTreeError(`unknown op: ${op}`);
    }
  }

  return { main };
})();

try {
  Cli.main();
} catch (error) {
  if (!(error instanceof DesignTreeError)) throw error;

  console.error(error.message);
  process.exit(1);
}
