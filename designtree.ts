import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

type Event =
  | { type: "add-question"; id: string; text: string; origin?: string }
  | { type: "add-option"; id: string; text: string; origin: string }
  | { type: "select-option"; origin: string }
  | { type: "add-follow-up"; id: string; text: string; origin: string }
  | { type: "promote-follow-up"; origin: string; question: string }
  | { type: "dismiss-follow-up"; origin: string };

type Log = {
  read(): Event[];
  append(event: Event): void;
};

type OptionData = { id: string; text: string };

type QuestionData = { id: string; text: string; options: OptionData[] };

type SelectionData = { question: { id: string; text: string }; option: OptionData };

type FollowUpData = { id: string; text: string };

type NextData =
  | { kind: "question"; question: QuestionData }
  | { kind: "follow-up"; followUp: FollowUpData };

type QuestionNode = {
  kind: "question";
  id: string;
  text: string;
  parent?: OptionNode | QuestionNode;
  options: OptionNode[];
  children: QuestionNode[];
  followUps: FollowUpNode[];
  answer?: OptionNode;
};

type OptionNode = {
  kind: "option";
  id: string;
  text: string;
  question: QuestionNode;
  children: QuestionNode[];
  followUps: FollowUpNode[];
};

type FollowUpNode = {
  kind: "follow-up";
  id: string;
  text: string;
  parent: OptionNode | QuestionNode;
  status: "open" | "promoted" | "dismissed";
};

type Graph = {
  nodes: Map<string, QuestionNode | OptionNode | FollowUpNode>;
  roots: QuestionNode[];
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
    return log.read().find((event) => "id" in event && event.id === id);
  }

  function has(log: Log, id: string): boolean {
    return find(log, id) !== undefined;
  }

  function nextId(log: Log, type: Event["type"], prefix: string): string {
    const numbers = log
      .read()
      .filter((event) => event.type === type)
      .map((event) => ("id" in event ? Number(event.id.slice(prefix.length)) : 0));

    return `${prefix}${Math.max(0, ...numbers) + 1}`;
  }

  function transaction<T>(log: Log, work: (staged: Log) => T): T {
    const existing = log.read();
    const staged = memoryLog([...existing]);

    const result = work(staged);

    for (const event of staged.read().slice(existing.length)) log.append(event);

    return result;
  }

  function tests() {
    test("transaction that throws leaves the log untouched", () => {
      // given
      const question: Event = { type: "add-question", id: "Q1", text: "q" };
      const log = memoryLog([question]);

      // when
      const act = () =>
        transaction(log, (staged) => {
          staged.append({ type: "add-option", id: "Q1a", text: "a", origin: "Q1" });
          throw new Error("boom");
        });

      // then
      assert.throws(act, /boom/);
      assert.deepEqual(log.read(), [question]);
    });

    test("transaction flushes only the new events and returns the result", () => {
      // given
      const question: Event = { type: "add-question", id: "Q1", text: "q" };
      const option: Event = { type: "add-option", id: "Q1a", text: "a", origin: "Q1" };
      const log = memoryLog([question]);

      // when
      const result = transaction(log, (staged) => {
        staged.append(option);
        return "done";
      });

      // then
      assert.equal(result, "done");
      assert.deepEqual(log.read(), [question, option]);
    });

    test("file log without a file reads as empty", (t) => {
      // given
      const dir = mkdtempSync(join(tmpdir(), "designtree-"));
      t.after(() => rmSync(dir, { recursive: true }));
      const path = join(dir, "designtree.jsonl");

      // when
      const events = fileLog(path).read();

      // then
      assert.deepEqual(events, []);
      assert.equal(existsSync(path), false);
    });

    test("file log reads back what it appended", (t) => {
      // given
      const dir = mkdtempSync(join(tmpdir(), "designtree-"));
      t.after(() => rmSync(dir, { recursive: true }));
      const path = join(dir, "designtree.jsonl");
      const question: Event = { type: "add-question", id: "Q1", text: "q" };
      const option: Event = { type: "add-option", id: "Q1a", text: "a", origin: "Q1" };

      // when
      const log = fileLog(path);
      log.append(question);
      log.append(option);

      // then
      assert.deepEqual(fileLog(path).read(), [question, option]);
      assert.equal(readFileSync(path, "utf8").split("\n").filter((line) => line !== "").length, 2);
    });

    test("memory log read returns a copy", () => {
      // given
      const question: Event = { type: "add-question", id: "Q1", text: "q" };
      const log = memoryLog([question]);

      // when
      log.read().push({ type: "add-question", id: "Q2", text: "q2" });

      // then
      assert.deepEqual(log.read(), [question]);
    });
  }

  return { fileLog, memoryLog, find, has, nextId, transaction, tests };
})();

const Graph = (() => {
  function questionNode(nodes: Graph["nodes"], id: string): QuestionNode {
    const node = nodes.get(id);
    if (node?.kind !== "question") throw new Error(`log has no question ${id}`);

    return node;
  }

  function optionNode(nodes: Graph["nodes"], id: string): OptionNode {
    const node = nodes.get(id);
    if (node?.kind !== "option") throw new Error(`log has no option ${id}`);

    return node;
  }

  function followUpNode(nodes: Graph["nodes"], id: string): FollowUpNode {
    const node = nodes.get(id);
    if (node?.kind !== "follow-up") throw new Error(`log has no follow-up ${id}`);

    return node;
  }

  function parentNode(nodes: Graph["nodes"], id: string): OptionNode | QuestionNode {
    const node = nodes.get(id);
    if (node === undefined || node.kind === "follow-up") {
      throw new Error(`log has no option or question ${id}`);
    }

    return node;
  }

  function build(log: Log): Graph {
    const nodes: Graph["nodes"] = new Map();
    const roots: QuestionNode[] = [];

    for (const event of log.read()) {
      switch (event.type) {
        case "add-question": {
          const node: QuestionNode = {
            kind: "question",
            id: event.id,
            text: event.text,
            options: [],
            children: [],
            followUps: [],
          };
          nodes.set(node.id, node);

          if (event.origin === undefined) {
            roots.push(node);
            break;
          }

          const parent = parentNode(nodes, event.origin);
          node.parent = parent;
          parent.children.push(node);
          break;
        }

        case "add-option": {
          const question = questionNode(nodes, event.origin);
          const node: OptionNode = {
            kind: "option",
            id: event.id,
            text: event.text,
            question,
            children: [],
            followUps: [],
          };
          nodes.set(node.id, node);
          question.options.push(node);
          break;
        }

        case "select-option": {
          const option = optionNode(nodes, event.origin);
          option.question.answer = option;
          break;
        }

        case "add-follow-up": {
          const parent = parentNode(nodes, event.origin);
          const node: FollowUpNode = {
            kind: "follow-up",
            id: event.id,
            text: event.text,
            parent,
            status: "open",
          };
          nodes.set(node.id, node);
          parent.followUps.push(node);
          break;
        }

        case "promote-follow-up": {
          followUpNode(nodes, event.origin).status = "promoted";
          break;
        }

        case "dismiss-follow-up": {
          followUpNode(nodes, event.origin).status = "dismissed";
          break;
        }
      }
    }

    return { nodes, roots };
  }

  function frontier(graph: Graph): (QuestionNode | FollowUpNode)[] {
    const open: (QuestionNode | FollowUpNode)[] = [];

    function backtrack(node: QuestionNode | OptionNode) {
      open.push(...node.followUps.filter((followUp) => followUp.status === "open"));
    }

    function walk(question: QuestionNode) {
      if (question.answer === undefined) {
        open.push(question);
      } else {
        question.answer.children.forEach(walk);
        backtrack(question.answer);
      }

      question.children.forEach(walk);
      backtrack(question);
    }

    graph.roots.forEach(walk);

    return open;
  }

  function tests() {
    test("the latest selection is the question's answer", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", origin: "Q1a" },
        { type: "select-option", origin: "Q1b" },
      ]);

      // when
      const graph = build(log);

      // then
      assert.equal(questionNode(graph.nodes, "Q1").answer?.id, "Q1b");
    });

    test("questions without an origin become roots in order", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2" },
        { type: "add-question", id: "Q3", text: "q3", origin: "Q1" },
      ]);

      // when
      const graph = build(log);

      // then
      assert.deepEqual(
        graph.roots.map((root) => root.id),
        ["Q1", "Q2"],
      );
    });

    test("question under an option links both ways", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
      ]);

      // when
      const graph = build(log);

      // then
      const option = optionNode(graph.nodes, "Q1a");
      const question = questionNode(graph.nodes, "Q2");
      assert.equal(question.parent, option);
      assert.deepEqual(option.children, [question]);
    });

    test("question under a question links both ways", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
      ]);

      // when
      const graph = build(log);

      // then
      const parent = questionNode(graph.nodes, "Q1");
      const child = questionNode(graph.nodes, "Q2");
      assert.equal(child.parent, parent);
      assert.deepEqual(parent.children, [child]);
      assert.deepEqual(optionNode(graph.nodes, "Q1a").children, []);
    });

    test("options attach to their question in order", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
      ]);

      // when
      const graph = build(log);

      // then
      const question = questionNode(graph.nodes, "Q1");
      assert.deepEqual(
        question.options.map((option) => option.id),
        ["Q1a", "Q1b"],
      );
      for (const option of question.options) assert.equal(option.question, question);
    });

    test("a question under an unselected option is off the frontier", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
          { type: "add-question", id: "Q2", text: "q2", origin: "Q1b" },
          { type: "select-option", origin: "Q1a" },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(open, []);
    });

    test("a question under the selected option is on the frontier", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
          { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
          { type: "select-option", origin: "Q1a" },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(
        open.map((question) => question.id),
        ["Q2"],
      );
    });

    test("frontier lists answer's children, then question's children, then the next root", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "add-question", id: "Q3", text: "q3", origin: "Q1" },
          { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
          { type: "add-question", id: "Q4", text: "q4" },
          { type: "select-option", origin: "Q1a" },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(
        open.map((question) => question.id),
        ["Q2", "Q3", "Q4"],
      );
    });

    test("an open question and its question-level follow-up are both on the frontier", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(
        open.map((question) => question.id),
        ["Q1", "Q2"],
      );
    });

    test("changing the answer swaps which branch is on the frontier", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
          { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
          { type: "add-question", id: "Q3", text: "q3", origin: "Q1b" },
          { type: "select-option", origin: "Q1a" },
          { type: "select-option", origin: "Q1b" },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(
        open.map((question) => question.id),
        ["Q3"],
      );
    });
  }

  return { build, frontier, tests };
})();

const AddQuestion = (() => {
  const options = {
    text: { type: "string" },
    origin: { type: "string" },
    option: { type: "string", multiple: true },
  } as const;

  function addQuestion(log: Log, text: string, origin?: string): string {
    if (origin !== undefined && !Log.has(log, origin)) {
      throw new DesignTreeError(`origin not found: ${origin}`);
    }

    const id = Log.nextId(log, "add-question", "Q");
    const event: Event = { type: "add-question", id, text };
    if (origin !== undefined) event.origin = origin;

    log.append(event);

    return id;
  }

  function run(
    log: Log,
    config: { text?: string; origin?: string; option?: string[] },
  ): QuestionData {
    const text = config.text;
    if (!text) throw new DesignTreeError("add-question requires --text");

    return Log.transaction(log, (staged) => {
      const id = addQuestion(staged, text, config.origin);
      const options = (config.option ?? []).map((optionText) => ({
        id: AddOption.add(staged, optionText, id),
        text: optionText,
      }));

      return { id, text, options };
    });
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

    test("question with an empty option throws and appends nothing", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => run(log, { text: "q", option: ["a", ""] });

      // then
      assert.throws(act, DesignTreeError);
      assert.deepEqual(log.read(), []);
    });

    test("question with options stores the question, then its options under it", () => {
      // given
      const log = Log.memoryLog();

      // when
      const question = run(log, { text: "q", option: ["a", "b"] });

      // then
      assert.deepEqual(question, {
        id: "Q1",
        text: "q",
        options: [
          { id: "Q1a", text: "a" },
          { id: "Q1b", text: "b" },
        ],
      });
      assert.deepEqual(log.read(), [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
      ]);
    });

    test("question with options in a non-empty log continues the ids", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const question = run(log, { text: "q2", option: ["b"] });

      // then
      assert.deepEqual(question, { id: "Q2", text: "q2", options: [{ id: "Q2a", text: "b" }] });
      assert.deepEqual(log.read(), [
        ...events,
        { type: "add-question", id: "Q2", text: "q2" },
        { type: "add-option", id: "Q2a", text: "b", origin: "Q2" },
      ]);
    });
  }

  return { options, run, tests };
})();

const AddOption = (() => {
  const options = {
    text: { type: "string" },
    origin: { type: "string" },
  } as const;

  function nextOptionId(log: Log, origin: string): string {
    const count = log
      .read()
      .filter((event) => event.type === "add-option" && event.origin === origin).length;
    if (count >= 26) throw new DesignTreeError(`question ${origin} already has 26 options`);

    return `${origin}${String.fromCharCode("a".charCodeAt(0) + count)}`;
  }

  function add(log: Log, text: string, origin: string): string {
    if (!text) throw new DesignTreeError("option requires a text");

    const question = Log.find(log, origin);
    if (question === undefined) throw new DesignTreeError(`origin not found: ${origin}`);
    if (question.type !== "add-question") {
      throw new DesignTreeError(`origin is not a question: ${origin}`);
    }

    const id = nextOptionId(log, origin);

    log.append({ type: "add-option", id, text, origin });

    return id;
  }

  function run(log: Log, config: { text?: string; origin?: string }): OptionData {
    if (!config.text) throw new DesignTreeError("add-option requires --text");
    if (!config.origin) throw new DesignTreeError("add-option requires --origin");

    const id = add(log, config.text, config.origin);

    return { id, text: config.text };
  }

  function tests() {
    test("option without a question throws and appends nothing", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => add(log, "a", "Q1");

      // then
      assert.throws(act, DesignTreeError);
      assert.deepEqual(log.read(), []);
    });

    test("option under an option throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => add(log, "b", "Q1a");

      // then
      assert.throws(act, DesignTreeError);
      assert.deepEqual(log.read(), events);
    });

    test("27th option under a question throws and appends nothing", () => {
      // given
      const letters = "abcdefghijklmnopqrstuvwxyz".split("");
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        ...letters.map((letter): Event => ({
          type: "add-option",
          id: `Q1${letter}`,
          text: letter,
          origin: "Q1",
        })),
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => add(log, "extra", "Q1");

      // then
      assert.throws(act, DesignTreeError);
      assert.deepEqual(log.read(), events);
    });

    test("option under a question is stored with its origin", () => {
      // given
      const question: Event = { type: "add-question", id: "Q1", text: "q" };
      const log = Log.memoryLog([question]);

      // when
      const id = add(log, "a", "Q1");

      // then
      assert.equal(id, "Q1a");
      assert.deepEqual(log.read(), [
        question,
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ]);
    });

    test("second option under the same question gets Q1b", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const id = add(log, "b", "Q1");

      // then
      assert.equal(id, "Q1b");
      assert.deepEqual(log.read(), [
        ...events,
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
      ]);
    });

    test("option letters restart per question", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const id = add(log, "b", "Q2");

      // then
      assert.equal(id, "Q2a");
      assert.deepEqual(log.read(), [
        ...events,
        { type: "add-option", id: "Q2a", text: "b", origin: "Q2" },
      ]);
    });
  }

  return { options, add, run, tests };
})();

const SelectOption = (() => {
  const options = {
    origin: { type: "string" },
  } as const;

  function select(log: Log, origin: string): SelectionData {
    const option = Log.find(log, origin);
    if (option === undefined) throw new DesignTreeError(`origin not found: ${origin}`);
    if (option.type !== "add-option") {
      throw new DesignTreeError(`origin is not an option: ${origin}`);
    }

    const question = Log.find(log, option.origin);
    if (question?.type !== "add-question") {
      throw new Error(`option ${option.id} has no question ${option.origin}`);
    }

    log.append({ type: "select-option", origin });

    return {
      question: { id: question.id, text: question.text },
      option: { id: option.id, text: option.text },
    };
  }

  function run(log: Log, config: { origin?: string }): SelectionData {
    if (!config.origin) throw new DesignTreeError("select-option requires --origin");

    return select(log, config.origin);
  }

  function tests() {
    test("selecting an unknown option throws and appends nothing", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => select(log, "Q1a");

      // then
      assert.throws(act, DesignTreeError);
      assert.deepEqual(log.read(), []);
    });

    test("selecting a question throws and appends nothing", () => {
      // given
      const question: Event = { type: "add-question", id: "Q1", text: "q" };
      const log = Log.memoryLog([question]);

      // when
      const act = () => select(log, "Q1");

      // then
      assert.throws(act, DesignTreeError);
      assert.deepEqual(log.read(), [question]);
    });

    test("selecting an option records it and returns the question with the option", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const selection = select(log, "Q1a");

      // then
      assert.deepEqual(selection, {
        question: { id: "Q1", text: "q" },
        option: { id: "Q1a", text: "a" },
      });
      assert.deepEqual(log.read(), [...events, { type: "select-option", origin: "Q1a" }]);
    });
  }

  return { options, run, tests };
})();

const AddFollowUp = (() => {
  const options = {
    text: { type: "string" },
    origin: { type: "string" },
  } as const;

  function add(log: Log, text: string, origin: string): string {
    if (!text) throw new DesignTreeError("follow-up requires a text");

    const parent = Log.find(log, origin);
    if (parent === undefined) throw new DesignTreeError(`origin not found: ${origin}`);
    if (parent.type !== "add-question" && parent.type !== "add-option") {
      throw new DesignTreeError(`origin is not a question or an option: ${origin}`);
    }

    const id = Log.nextId(log, "add-follow-up", "F");

    log.append({ type: "add-follow-up", id, text, origin });

    return id;
  }

  function run(log: Log, config: { text?: string; origin?: string }): FollowUpData {
    if (!config.text) throw new DesignTreeError("add-follow-up requires --text");
    if (!config.origin) throw new DesignTreeError("add-follow-up requires --origin");

    const id = add(log, config.text, config.origin);

    return { id, text: config.text };
  }

  function open(log: Log, id: string): FollowUpNode {
    const node = Graph.build(log).nodes.get(id);
    if (node === undefined) throw new DesignTreeError(`origin not found: ${id}`);
    if (node.kind !== "follow-up") throw new DesignTreeError(`origin is not a follow-up: ${id}`);
    if (node.status !== "open") throw new DesignTreeError(`follow-up ${id} is already ${node.status}`);

    return node;
  }

  function tests() {
    test("follow-up under an unknown origin throws and appends nothing", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => add(log, "f", "Q1");

      // then
      assert.throws(act, DesignTreeError);
      assert.deepEqual(log.read(), []);
    });

    test("follow-up under a follow-up throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => add(log, "f2", "F1");

      // then
      assert.throws(act, DesignTreeError);
      assert.deepEqual(log.read(), events);
    });

    test("follow-up under an option is stored with its origin", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const id = add(log, "f", "Q1a");

      // then
      assert.equal(id, "F1");
      assert.deepEqual(log.read(), [
        ...events,
        { type: "add-follow-up", id: "F1", text: "f", origin: "Q1a" },
      ]);
    });

    test("a dismissed follow-up is not open", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-follow-up", id: "F1", text: "f", origin: "Q1" },
        { type: "dismiss-follow-up", origin: "F1" },
      ]);

      // when
      const act = () => open(log, "F1");

      // then
      assert.throws(act, DesignTreeError);
    });
  }

  return { options, open, run, tests };
})();

const PromoteFollowUp = (() => {
  const options = {
    origin: { type: "string" },
    option: { type: "string", multiple: true },
  } as const;

  function run(log: Log, config: { origin?: string; option?: string[] }): QuestionData {
    const origin = config.origin;
    if (!origin) throw new DesignTreeError("promote-follow-up requires --origin");

    return Log.transaction(log, (staged) => {
      const followUp = AddFollowUp.open(staged, origin);
      const question = AddQuestion.run(staged, {
        text: followUp.text,
        origin: followUp.parent.id,
        option: config.option,
      });

      staged.append({ type: "promote-follow-up", origin, question: question.id });

      return question;
    });
  }

  function tests() {}

  return { options, run, tests };
})();

const DismissFollowUp = (() => {
  const options = {
    origin: { type: "string" },
  } as const;

  function run(log: Log, config: { origin?: string }): FollowUpData {
    if (!config.origin) throw new DesignTreeError("dismiss-follow-up requires --origin");

    const followUp = AddFollowUp.open(log, config.origin);

    log.append({ type: "dismiss-follow-up", origin: followUp.id });

    return { id: followUp.id, text: followUp.text };
  }

  function tests() {}

  return { options, run, tests };
})();

const Next = (() => {
  const options = {} as const;

  function run(log: Log): NextData | undefined {
    const node = Graph.frontier(Graph.build(log))[0];
    if (node === undefined) return undefined;

    if (node.kind === "follow-up") {
      return { kind: "follow-up", followUp: { id: node.id, text: node.text } };
    }

    return {
      kind: "question",
      question: {
        id: node.id,
        text: node.text,
        options: node.options.map((option) => ({ id: option.id, text: option.text })),
      },
    };
  }

  function tests() {
    test("next on an empty log is nothing", () => {
      // given
      const log = Log.memoryLog();

      // when
      const question = run(log);

      // then
      assert.equal(question, undefined);
    });

    test("next is the first open question with its options", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2" },
      ]);

      // when
      const question = run(log);

      // then
      assert.deepEqual(question, {
        kind: "question",
        question: {
          id: "Q1",
          text: "q1",
          options: [
            { id: "Q1a", text: "a" },
            { id: "Q1b", text: "b" },
          ],
        },
      });
    });
  }

  return { options, run, tests };
})();

const Xml = (() => {
  function escapeXml(text: string): string {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  function option(data: OptionData): string {
    return `<option><id>${data.id}</id><text>${escapeXml(data.text)}</text></option>`;
  }

  function question(data: QuestionData): string {
    const options = data.options.map((each) => `    ${option(each)}\n`).join("");

    return [
      "<question>",
      `  <id>${data.id}</id>`,
      `  <text>${escapeXml(data.text)}</text>`,
      data.options.length === 0 ? "  <options></options>" : `  <options>\n${options}  </options>`,
      "</question>",
    ].join("\n");
  }

  function selection(data: SelectionData): string {
    return [
      "<selection>",
      `  <question><id>${data.question.id}</id><text>${escapeXml(data.question.text)}</text></question>`,
      `  ${option(data.option)}`,
      "</selection>",
    ].join("\n");
  }

  function followUp(data: FollowUpData): string {
    return `<follow-up><id>${data.id}</id><text>${escapeXml(data.text)}</text></follow-up>`;
  }

  function next(data: NextData | undefined): string {
    if (data === undefined) return "<next></next>";
    if (data.kind === "follow-up") return `<next>\n  ${followUp(data.followUp)}\n</next>`;

    const body = question(data.question)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");

    return `<next>\n${body}\n</next>`;
  }

  function tests() {
    test("option text is escaped", () => {
      // given
      const data: OptionData = { id: "Q1a", text: "a < b > c & d" };

      // when
      const xml = option(data);

      // then
      assert.equal(xml, "<option><id>Q1a</id><text>a &lt; b &gt; c &amp; d</text></option>");
    });

    test("question without options renders empty options", () => {
      // given
      const data: QuestionData = { id: "Q1", text: "q", options: [] };

      // when
      const xml = question(data);

      // then
      assert.equal(
        xml,
        ["<question>", "  <id>Q1</id>", "  <text>q</text>", "  <options></options>", "</question>"].join("\n"),
      );
    });

    test("question with options renders them nested in order", () => {
      // given
      const data: QuestionData = {
        id: "Q1",
        text: "q",
        options: [
          { id: "Q1a", text: "a" },
          { id: "Q1b", text: "b" },
        ],
      };

      // when
      const xml = question(data);

      // then
      assert.equal(
        xml,
        [
          "<question>",
          "  <id>Q1</id>",
          "  <text>q</text>",
          "  <options>",
          "    <option><id>Q1a</id><text>a</text></option>",
          "    <option><id>Q1b</id><text>b</text></option>",
          "  </options>",
          "</question>",
        ].join("\n"),
      );
    });

    test("question text is escaped", () => {
      // given
      const data: QuestionData = { id: "Q1", text: "a < b > c & d", options: [] };

      // when
      const xml = question(data);

      // then
      assert.equal(xml.split("\n")[2], "  <text>a &lt; b &gt; c &amp; d</text>");
    });

    test("next without a question renders an empty next", () => {
      // given
      const data = undefined;

      // when
      const xml = next(data);

      // then
      assert.equal(xml, "<next></next>");
    });

    test("next with a question wraps the question block", () => {
      // given
      const data: QuestionData = { id: "Q1", text: "q", options: [{ id: "Q1a", text: "a" }] };

      // when
      const xml = next({ kind: "question", question: data });

      // then
      const inner = question(data)
        .split("\n")
        .map((line) => `  ${line}`);
      assert.deepEqual(xml.split("\n"), ["<next>", ...inner, "</next>"]);
    });
  }

  return { option, question, selection, followUp, next, tests };
})();

const Cli = (() => {
  const cliOptions = {
    op: { type: "string" },
    query: { type: "string" },
    test: { type: "boolean" },
  } as const;

  const testOptions = {} as const;

  type Mode = { kind: "test" } | { kind: "op"; op: string } | { kind: "query"; query: string };

  function readMode(): Mode {
    const { op, query, test } = parseArgs({ options: cliOptions, strict: false }).values;

    const given = [op, query, test].filter((value) => value !== undefined);
    if (given.length > 1) {
      throw new DesignTreeError("--op, --query and --test are mutually exclusive");
    }

    if (test !== undefined) return { kind: "test" };

    if (query !== undefined) {
      if (typeof query !== "string") throw new DesignTreeError("--query requires a value");

      return { kind: "query", query };
    }

    if (op === undefined) throw new DesignTreeError("missing --op, --query or --test");
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
    Log.tests();
    Graph.tests();
    AddQuestion.tests();
    AddOption.tests();
    SelectOption.tests();
    AddFollowUp.tests();
    PromoteFollowUp.tests();
    DismissFollowUp.tests();
    Next.tests();
    Xml.tests();
  }

  function main() {
    const mode = readMode();

    if (mode.kind === "test") {
      readModeConfig(testOptions);
      runTests();
      return;
    }

    const log = Log.fileLog("designtree.jsonl");

    if (mode.kind === "query") {
      runQuery(log, mode.query);
      return;
    }

    runOp(log, mode.op);
  }

  function runQuery(log: Log, query: string) {
    switch (query) {
      case "next": {
        readModeConfig(Next.options);
        console.log(Xml.next(Next.run(log)));
        break;
      }

      default:
        throw new DesignTreeError(`unknown query: ${query}`);
    }
  }

  function runOp(log: Log, op: string) {
    switch (op) {
      case "add-question": {
        const config = readModeConfig(AddQuestion.options);
        console.log(Xml.question(AddQuestion.run(log, config)));
        break;
      }

      case "add-option": {
        const config = readModeConfig(AddOption.options);
        console.log(Xml.option(AddOption.run(log, config)));
        break;
      }

      case "select-option": {
        const config = readModeConfig(SelectOption.options);
        console.log(Xml.selection(SelectOption.run(log, config)));
        break;
      }

      case "add-follow-up": {
        const config = readModeConfig(AddFollowUp.options);
        console.log(Xml.followUp(AddFollowUp.run(log, config)));
        break;
      }

      case "promote-follow-up": {
        const config = readModeConfig(PromoteFollowUp.options);
        console.log(Xml.question(PromoteFollowUp.run(log, config)));
        break;
      }

      case "dismiss-follow-up": {
        const config = readModeConfig(DismissFollowUp.options);
        console.log(Xml.followUp(DismissFollowUp.run(log, config)));
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
