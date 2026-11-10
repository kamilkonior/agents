const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs: typeof import("node:fs") = require("node:fs");
const { tmpdir }: typeof import("node:os") = require("node:os");
const { dirname, join }: typeof import("node:path") = require("node:path");
const { test }: typeof import("node:test") = require("node:test");
const { parseArgs }: typeof import("node:util") = require("node:util");

const { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } = fs;

type ParseArgsOptionsConfig = import("node:util").ParseArgsOptionsConfig;

type ExclusionReason = "not-applicable" | "deferred";

type Event =
  | { type: "add-question"; id: string; text: string; origin?: string }
  | { type: "add-option"; id: string; text: string; origin: string }
  | { type: "select-option"; targets: string[]; rationale?: string }
  | { type: "clear-selection"; target: string }
  | { type: "add-follow-up"; id: string; text: string; origin?: string }
  | { type: "promote-follow-up"; target: string }
  | { type: "exclude"; target: string; reason: ExclusionReason; note?: string }
  | { type: "restore"; target: string }
  | { type: "supersede-question"; target: string; question: string }
  | { type: "supersede-option"; target: string; option: string }
  | { type: "focus"; target: string }
  | { type: "tag"; target: string; tags: string[] }
  | { type: "untag"; target: string; tags: string[] };

type IdEvent = Extract<Event, { id: string }>;

type Log = {
  read(): Event[];
  append(...events: Event[]): void;
};

type OptionData = { id: string; text: string };

type QuestionData = { id: string; text: string; options: OptionData[] };

type SelectionData = { question: { id: string; text: string }; options: OptionData[] };

type FollowUpData = { id: string; text: string };

type ItemData =
  | { kind: "question"; question: QuestionData }
  | { kind: "option"; option: OptionData }
  | { kind: "follow-up"; followUp: FollowUpData };


type ItemState = "open" | "settled" | "off-path" | "deferred" | "not-applicable" | "frozen";

type NodeState = ItemState | "unset";

type TreeEntryOption = OptionData & {
  selected?: true;
  state?: ExclusionReason | "frozen";
  supersedes?: string;
  supersededBy?: string;
  note?: string;
  children: TreeEntry[];
};

type TreeEntry =
  | {
      kind: "question";
      state: ItemState;
      id: string;
      text: string;
      note?: string;
      supersedes?: string;
      supersededBy?: string;
      options: TreeEntryOption[];
      rationale?: string;
      children: TreeEntry[];
    }
  | { kind: "follow-up"; state: ItemState; id: string; text: string; note?: string; children: TreeEntry[] };

type OpenItem =
  | { kind: "open-question"; id: string; text: string; options: OptionData[] }
  | { kind: "follow-up"; id: string; text: string };

type StatusItem =
  | { kind: "option"; state: "deferred"; id: string; text: string; note?: string }
  | { kind: "follow-up"; state: "open"; id: string; text: string }
  | { kind: "follow-up"; state: "deferred"; id: string; text: string; note?: string }
  | { kind: "question"; state: "deferred"; id: string; text: string; note?: string }
  | { kind: "question"; state: "open"; id: string; text: string; options: OptionData[]; children: StatusItem[] }
  | {
      kind: "question";
      state: "settled";
      id: string;
      text: string;
      decided: (OptionData & { children: StatusItem[] })[];
      children: StatusItem[];
      rationale?: string;
    };

type Hiding = { state: ItemState; by: string };

type TaggedData = {
  item: { kind: "question"; question: QuestionData } | { kind: "follow-up"; followUp: FollowUpData };
  tags: string[];
};

type HiddenOption = OptionData & { state: ExclusionReason | "frozen"; note?: string; supersededBy?: string };

type ListedItem = TaggedData & {
  state: ItemState;
  selected?: OptionData[];
  rationale?: string;
  note?: string;
  hiddenBy?: string;
  supersedes?: string;
  supersededBy?: string;
  trail?: TrailStep[];
  hiddenOptions?: HiddenOption[];
};

type PromoteData = { question: QuestionData; promoted: FollowUpData };
type SupersedeData = { question: QuestionData; superseded: TreeEntry[] };

type SupersedeOptionData = { option: OptionData; superseded: TreeEntryOption };

type TrailStep = { kind: "question" | "option" | "follow-up"; id: string; text: string };

type NextData = (
  | { kind: "question"; question: QuestionData }
  | { kind: "follow-up"; followUp: FollowUpData }
) & { trail?: TrailStep[] };

type QuestionNode = {
  kind: "question";
  id: string;
  text: string;
  state: NodeState;
  parent?: OptionNode | QuestionNode | FollowUpNode;
  options: OptionNode[];
  children: QuestionNode[];
  followUps: FollowUpNode[];
  selected: OptionNode[];
  rationale?: string;
  supersededBy?: QuestionNode;
  supersedes?: QuestionNode;
  hiddenBy?: string;
};

type OptionNode = {
  kind: "option";
  id: string;
  text: string;
  state: NodeState;
  hiddenBy?: string;
  question: QuestionNode;
  supersededBy?: OptionNode;
  supersedes?: OptionNode;
  children: QuestionNode[];
  followUps: FollowUpNode[];
};

type FollowUpNode = {
  kind: "follow-up";
  id: string;
  text: string;
  state: NodeState;
  parent?: OptionNode | QuestionNode | FollowUpNode;
  status: "open" | "promoted";
  hiddenBy?: string;
  children: QuestionNode[];
  followUps: FollowUpNode[];
};

type Graph = {
  nodes: Map<string, QuestionNode | OptionNode | FollowUpNode>;
  roots: QuestionNode[];
  rootFollowUps: FollowUpNode[];
  exclusions: Map<string, { reason: ExclusionReason; note?: string }>;
  tags: Map<string, Set<string>>;
  focus?: { node: QuestionNode | FollowUpNode; ended: boolean };
  walkOrder: (QuestionNode | FollowUpNode)[];
};

class DecisionTreeError extends Error {}

const Log = (() => {
  function parseLine(line: string, number: number, path: string): Event {
    try {
      return JSON.parse(line);
    } catch {
      throw new DecisionTreeError(`log line ${number} is not valid JSON: ${path}`);
    }
  }

  function fileLog(path: string): Log {
    return {
      read() {
        if (!existsSync(path)) return [];

        return readFileSync(path, "utf8")
          .split("\n")
          .flatMap((line, index) => (line === "" ? [] : [parseLine(line, index + 1, path)]));
      },

      append(...events) {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, events.map((event) => JSON.stringify(event) + "\n").join(""));
      },
    };
  }

  function memoryLog(events: Event[] = []): Log {
    return {
      read() {
        return [...events];
      },

      append(...added) {
        events.push(...added);
      },
    };
  }

  function sleep(milliseconds: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }

  const lockLimits = { waitMs: 5_000, abandonedMs: 30_000 };

  function isAbandoned(lock: string, abandonedMs: number): boolean {
    const stats = statSync(lock, { throwIfNoEntry: false });

    return stats !== undefined && Date.now() - stats.mtimeMs > abandonedMs;
  }

  function acquire(lock: string, limits: typeof lockLimits): void {
    const deadline = Date.now() + limits.waitMs;

    while (true) {
      try {
        closeSync(openSync(lock, "wx"));
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      if (isAbandoned(lock, limits.abandonedMs)) {
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new DecisionTreeError(`log is locked by another writer: ${lock}`);

      sleep(10);
    }
  }

  function locked<T>(path: string, work: () => T, limits = lockLimits): T {
    const lock = `${path}.lock`;
    mkdirSync(dirname(path), { recursive: true });

    acquire(lock, limits);

    try {
      return work();
    } finally {
      rmSync(lock, { force: true });
    }
  }

  function nextId(log: Log, type: IdEvent["type"], prefix: string): string {
    const numbers = log
      .read()
      .filter((event): event is IdEvent => event.type === type)
      .map((event) => Number(event.id.slice(prefix.length)));

    return `${prefix}${Math.max(0, ...numbers) + 1}`;
  }

  function transaction<T>(log: Log, work: (staged: Log) => T): T {
    const existing = log.read();
    const staged = memoryLog([...existing]);

    const result = work(staged);

    log.append(...staged.read().slice(existing.length));

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

    test("transaction writes its events in a single append", () => {
      // given
      const question: Event = { type: "add-question", id: "Q1", text: "q" };
      const option: Event = { type: "add-option", id: "Q1a", text: "a", origin: "Q1" };
      const appends: Event[][] = [];
      const log: Log = {
        read: () => [],
        append: (...events) => appends.push(events),
      };

      // when
      transaction(log, (staged) => {
        staged.append(question);
        staged.append(option);
      });

      // then
      assert.deepEqual(appends, [[question, option]]);
    });

    test("a lock held by another writer throws and does not run the work", (t) => {
      // given
      const dir = mkdtempSync(join(tmpdir(), "decision-tree-"));
      t.after(() => rmSync(dir, { recursive: true }));
      const path = join(dir, "decision-tree.jsonl");
      appendFileSync(`${path}.lock`, "");
      let ran = false;

      // when
      const act = () =>
        locked(
          path,
          () => {
            ran = true;
          },
          { waitMs: 0, abandonedMs: 60_000 },
        );

      // then
      assert.throws(
        act,
        (error) =>
          error instanceof DecisionTreeError && error.message === `log is locked by another writer: ${path}.lock`,
      );
      assert.equal(ran, false);
    });

    test("an abandoned lock is taken over and removed afterwards", (t) => {
      // given
      const dir = mkdtempSync(join(tmpdir(), "decision-tree-"));
      t.after(() => rmSync(dir, { recursive: true }));
      const path = join(dir, "decision-tree.jsonl");
      appendFileSync(`${path}.lock`, "");

      // when
      const result = locked(path, () => "done", { waitMs: 0, abandonedMs: -1 });

      // then
      assert.equal(result, "done");
      assert.equal(existsSync(`${path}.lock`), false);
    });

    test("the lock is released when the work throws", (t) => {
      // given
      const dir = mkdtempSync(join(tmpdir(), "decision-tree-"));
      t.after(() => rmSync(dir, { recursive: true }));
      const path = join(dir, "decision-tree.jsonl");

      // when
      const act = () =>
        locked(path, () => {
          throw new DecisionTreeError("failed");
        });

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "failed");
      assert.equal(existsSync(`${path}.lock`), false);
    });

    test("file log with a malformed line throws, naming the line", (t) => {
      // given
      const dir = mkdtempSync(join(tmpdir(), "decision-tree-"));
      t.after(() => rmSync(dir, { recursive: true }));
      const path = join(dir, "decision-tree.jsonl");
      appendFileSync(path, '{"type":"add-question","id":"Q1","text":"q"}\n{"type":"add-opt\n');

      // when
      const act = () => fileLog(path).read();

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === `log line 2 is not valid JSON: ${path}`,
      );
    });

    test("file log without a file reads as empty", (t) => {
      // given
      const dir = mkdtempSync(join(tmpdir(), "decision-tree-"));
      t.after(() => rmSync(dir, { recursive: true }));
      const path = join(dir, "decision-tree.jsonl");

      // when
      const events = fileLog(path).read();

      // then
      assert.deepEqual(events, []);
      assert.equal(existsSync(path), false);
    });

    test("file log reads back what it appended", (t) => {
      // given
      const dir = mkdtempSync(join(tmpdir(), "decision-tree-"));
      t.after(() => rmSync(dir, { recursive: true }));
      const path = join(dir, "decision-tree.jsonl");
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

  return { fileLog, memoryLog, locked, nextId, transaction, tests };
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

  function parentNode(nodes: Graph["nodes"], id: string): OptionNode | QuestionNode | FollowUpNode {
    const node = nodes.get(id);
    if (node === undefined) throw new Error(`log has no node ${id}`);

    return node;
  }

  function supersededNode(nodes: Graph["nodes"], id: string): QuestionNode | OptionNode {
    const node = nodes.get(id);
    if (node === undefined || node.kind === "follow-up") throw new Error(`log has no question or option ${id}`);

    return node;
  }

  function rejectFrozen(graph: Graph, node: QuestionNode | OptionNode | FollowUpNode): void {
    if (node.state !== "frozen") return;

    const superseded = supersededNode(graph.nodes, node.hiddenBy ?? node.id);
    const replacement = superseded.supersededBy?.id;
    if (superseded === node) {
      throw new DecisionTreeError(`${node.id} is frozen, as it was superseded by ${replacement}`);
    }
    throw new DecisionTreeError(
      `${node.id} is frozen, as its ancestor ${superseded.id} was superseded by ${replacement}`,
    );
  }

  function optionHiding(graph: Graph, option: OptionNode): "frozen" | ExclusionReason | undefined {
    if (option.supersededBy !== undefined) return "frozen";

    return graph.exclusions.get(option.id)?.reason;
  }

  function isLiveOption(graph: Graph, option: OptionNode): boolean {
    return optionHiding(graph, option) === undefined;
  }

  function liveOptions(graph: Graph, question: QuestionNode): OptionData[] {
    return question.options
      .filter((option) => isLiveOption(graph, option))
      .map((option) => ({ id: option.id, text: option.text }));
  }

  function build(log: Log): Graph {
    const nodes: Graph["nodes"] = new Map();
    const roots: QuestionNode[] = [];
    const rootFollowUps: FollowUpNode[] = [];
    const exclusions: Graph["exclusions"] = new Map();
    const graph: Graph = { nodes, roots, rootFollowUps, exclusions, tags: new Map(), walkOrder: [] };

    for (const event of log.read()) {
      switch (event.type) {
        case "add-question": {
          const node: QuestionNode = {
            kind: "question",
            id: event.id,
            text: event.text,
            state: "unset",
            options: [],
            selected: [],
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
            state: "unset",
            question,
            children: [],
            followUps: [],
          };
          nodes.set(node.id, node);
          question.options.push(node);
          break;
        }

        case "select-option": {
          if (event.targets === undefined) throw new DecisionTreeError("select-option event has no targets");

          const options = event.targets.map((id) => optionNode(nodes, id));
          options[0].question.selected = options;
          options[0].question.rationale = event.rationale;
          break;
        }

        case "clear-selection": {
          const question = questionNode(nodes, event.target);
          question.selected = [];
          question.rationale = undefined;
          break;
        }

        case "add-follow-up": {
          const node: FollowUpNode = {
            kind: "follow-up",
            id: event.id,
            text: event.text,
            state: "unset",
            status: "open",
            children: [],
            followUps: [],
          };
          nodes.set(node.id, node);

          if (event.origin === undefined) {
            rootFollowUps.push(node);
            break;
          }

          const parent = parentNode(nodes, event.origin);
          node.parent = parent;
          parent.followUps.push(node);
          break;
        }

        case "promote-follow-up": {
          followUpNode(nodes, event.target).status = "promoted";
          break;
        }

        case "exclude": {
          const note = event.note === undefined ? {} : { note: event.note };
          const exclusion = { reason: event.reason, ...note };
          exclusions.set(parentNode(nodes, event.target).id, exclusion);
          break;
        }

        case "restore": {
          exclusions.delete(parentNode(nodes, event.target).id);
          break;
        }

        case "supersede-question": {
          const old = questionNode(nodes, event.target);
          const replacement = questionNode(nodes, event.question);
          const siblings = old.parent === undefined ? roots : old.parent.children;
          if (!siblings.includes(replacement)) {
            throw new Error(`question ${replacement.id} does not hang where ${old.id} hangs`);
          }

          siblings.splice(siblings.indexOf(replacement), 1);
          siblings.splice(siblings.indexOf(old), 1, replacement);
          old.supersededBy = replacement;
          replacement.supersedes = old;
          const tags = graph.tags.get(old.id);
          if (tags !== undefined) graph.tags.set(replacement.id, new Set(tags));
          if (graph.focus?.node === old && !graph.focus.ended) graph.focus.node = replacement;
          break;
        }

        case "supersede-option": {
          const old = optionNode(nodes, event.target);
          const replacement = optionNode(nodes, event.option);
          old.supersededBy = replacement;
          replacement.supersedes = old;
          break;
        }

        case "tag": {
          const tags = graph.tags.get(event.target) ?? new Set<string>();
          event.tags.forEach((tag) => tags.add(tag));
          graph.tags.set(parentNode(nodes, event.target).id, tags);
          break;
        }

        case "untag": {
          event.tags.forEach((tag) => graph.tags.get(event.target)?.delete(tag));
          break;
        }

        case "focus": {
          const node = parentNode(nodes, event.target);
          if (node.kind === "option") throw new Error(`focus target ${node.id} is an option`);

          graph.focus = { node, ended: false };
          break;
        }

        default: {
          const unknown: never = event;
          throw new DecisionTreeError(`unknown event type: ${(unknown as { type: string }).type}`);
        }
      }

      if (graph.focus !== undefined && !graph.focus.ended) {
        assignStates(graph);
        if (openWithin(graph, graph.focus.node).length === 0) graph.focus.ended = true;
      }
    }

    assignStates(graph);
    assertStatesAssigned(graph);

    return graph;
  }

  function assignStates(graph: Graph): void {
    graph.walkOrder = [];

    graph.roots.forEach((question) => assignQuestion(graph, question, undefined));
    graph.rootFollowUps.forEach((followUp) => assignFollowUp(graph, followUp, undefined));

    for (const node of graph.nodes.values()) {
      if (node.kind === "question" && node.supersededBy !== undefined) assignQuestion(graph, node, undefined);
    }
  }

  function hidingOf(
    graph: Graph,
    node: QuestionNode | OptionNode | FollowUpNode,
    inherited: Hiding | undefined,
  ): Hiding | undefined {
    if (node.kind !== "follow-up" && node.supersededBy !== undefined) return { state: "frozen", by: node.id };
    if (inherited?.state === "frozen") return inherited;

    const exclusion = graph.exclusions.get(node.id);

    return exclusion === undefined ? inherited : { state: exclusion.reason, by: node.id };
  }

  function offPathBelow(hiding: Hiding | undefined, by: string): Hiding {
    return hiding ?? { state: "off-path", by };
  }

  function assignQuestion(graph: Graph, question: QuestionNode, inherited: Hiding | undefined): void {
    const hiding = hidingOf(graph, question, inherited);
    const selected = liveSelected(graph, question);

    if (hiding !== undefined && hiding.by !== question.id) question.hiddenBy = hiding.by;
    question.state = hiding?.state ?? (selected.length === 0 ? "open" : "settled");
    if (hiding === undefined) graph.walkOrder.push(question);

    for (const option of question.options) {
      const onPath = selected.includes(option);
      const optionHiding = hidingOf(graph, option, hiding);
      const below = onPath ? optionHiding : offPathBelow(optionHiding, option.id);

      if (optionHiding !== undefined && optionHiding.by !== option.id) option.hiddenBy = optionHiding.by;
      option.state = optionHiding?.state ?? (selected.length === 0 ? "open" : onPath ? "settled" : "off-path");
      option.children.forEach((child) => assignQuestion(graph, child, below));
      option.followUps.forEach((followUp) => assignFollowUp(graph, followUp, below));
    }

    question.children.forEach((child) => assignQuestion(graph, child, hiding));
    question.followUps.forEach((followUp) => assignFollowUp(graph, followUp, hiding));
  }

  function assignFollowUp(graph: Graph, followUp: FollowUpNode, inherited: Hiding | undefined): void {
    const hiding = hidingOf(graph, followUp, inherited);
    const below = followUp.status === "open" ? offPathBelow(hiding, followUp.id) : hiding;

    if (hiding !== undefined && hiding.by !== followUp.id) followUp.hiddenBy = hiding.by;
    followUp.state = hiding?.state ?? (followUp.status === "open" ? "open" : "settled");
    if (hiding === undefined) graph.walkOrder.push(followUp);

    followUp.children.forEach((child) => assignQuestion(graph, child, below));
    followUp.followUps.forEach((nested) => assignFollowUp(graph, nested, below));
  }

  function assignedState(node: QuestionNode | OptionNode | FollowUpNode): ItemState {
    if (node.state === "unset") throw new Error(`node ${node.id} has no state`);

    return node.state;
  }

  function assertStatesAssigned(graph: Graph): void {
    for (const node of graph.nodes.values()) {
      assignedState(node);
    }
  }

  function isWithin(node: QuestionNode | FollowUpNode, ancestor: QuestionNode | FollowUpNode): boolean {
    let current: QuestionNode | OptionNode | FollowUpNode | undefined = node;
    while (current !== undefined) {
      if (current.id === ancestor.id) return true;

      current = current.kind === "option" ? current.question : current.parent;
    }

    return false;
  }

  function openItem(graph: Graph, node: QuestionNode | FollowUpNode): OpenItem {
    if (node.kind === "follow-up") return { kind: "follow-up", id: node.id, text: node.text };

    return { kind: "open-question", id: node.id, text: node.text, options: liveOptions(graph, node) };
  }

  function openWithin(graph: Graph, ancestor?: QuestionNode | FollowUpNode): OpenItem[] {
    return graph.walkOrder
      .filter((node) => node.state === "open" && (ancestor === undefined || isWithin(node, ancestor)))
      .map((node) => openItem(graph, node));
  }

  function noteOf(graph: Graph, node: QuestionNode | OptionNode | FollowUpNode): { note?: string } {
    const note = graph.exclusions.get(node.id)?.note;

    return note === undefined ? {} : { note };
  }

  function childItems(graph: Graph, node: QuestionNode | OptionNode | FollowUpNode): StatusItem[] {
    return [
      ...node.children.flatMap((child) => statusItems(graph, child)),
      ...node.followUps.flatMap((followUp) => followUpItems(graph, followUp)),
    ];
  }

  function statusItems(graph: Graph, question: QuestionNode): StatusItem[] {
    if (question.state === "not-applicable") return [];

    if (question.state === "deferred") {
      return [{ kind: "question", state: "deferred", id: question.id, text: question.text, ...noteOf(graph, question) }];
    }

    const deferredOptions = question.options
      .filter((option) => option.state === "deferred")
      .map((option) => ({
        kind: "option" as const,
        state: "deferred" as const,
        id: option.id,
        text: option.text,
        ...noteOf(graph, option),
      }));
    const children = [...childItems(graph, question), ...deferredOptions];

    if (question.state === "settled") {
      const decided = liveSelected(graph, question).map((option) => ({
        id: option.id,
        text: option.text,
        children: childItems(graph, option),
      }));

      const item: StatusItem = { kind: "question", state: "settled", id: question.id, text: question.text, decided, children };
      if (question.rationale !== undefined) item.rationale = question.rationale;

      return [item];
    }

    if (question.state !== "open") throw new Error(`status reached a ${question.state} item: ${question.id}`);

    return [
      {
        kind: "question",
        state: "open",
        id: question.id,
        text: question.text,
        options: liveOptions(graph, question),
        children,
      },
    ];
  }

  function followUpItems(graph: Graph, followUp: FollowUpNode): StatusItem[] {
    if (followUp.state === "not-applicable") return [];
    if (followUp.state === "settled") return childItems(graph, followUp);

    if (followUp.state === "deferred") {
      return [{ kind: "follow-up", state: "deferred", id: followUp.id, text: followUp.text, ...noteOf(graph, followUp) }];
    }

    if (followUp.state !== "open") throw new Error(`status reached a ${followUp.state} item: ${followUp.id}`);

    return [{ kind: "follow-up", state: "open", id: followUp.id, text: followUp.text }];
  }

  function shownInStatus(node: QuestionNode | FollowUpNode): boolean {
    if (node.state === "deferred") return node.hiddenBy === undefined;

    return node.state === "open" || node.state === "settled";
  }

  function status(log: Log, target?: string): StatusItem[] {
    const graph = build(log);

    if (target !== undefined) {
      const node = targetNode(graph, target);
      if (!shownInStatus(node)) return [];

      return node.kind === "question" ? statusItems(graph, node) : followUpItems(graph, node);
    }

    return [
      ...graph.roots.flatMap((question) => statusItems(graph, question)),
      ...graph.rootFollowUps.flatMap((followUp) => followUpItems(graph, followUp)),
    ];
  }

  function childEntries(graph: Graph, node: QuestionNode | OptionNode | FollowUpNode): TreeEntry[] {
    return [
      ...node.children.flatMap((child) => questionEntries(graph, child)),
      ...node.followUps.map((followUp) => followUpEntry(graph, followUp)),
    ];
  }

  function supersedeLinks(node: QuestionNode | OptionNode): { supersedes?: string; supersededBy?: string } {
    return {
      ...(node.supersedes === undefined ? {} : { supersedes: node.supersedes.id }),
      ...(node.supersededBy === undefined ? {} : { supersededBy: node.supersededBy.id }),
    };
  }

  function questionEntries(graph: Graph, question: QuestionNode): TreeEntry[] {
    const selected = liveSelected(graph, question);
    const live = question.options
      .filter((option) => isLiveOption(graph, option))
      .map((option) => ({
        id: option.id,
        text: option.text,
        ...(selected.includes(option) ? { selected: true as const } : {}),
        ...supersedeLinks(option),
        children: childEntries(graph, option),
      }));
    const hidden = question.options.flatMap((option): TreeEntryOption[] => {
      const state = optionHiding(graph, option);
      if (state === undefined) return [];

      const children = childEntries(graph, option);

      return [{ id: option.id, text: option.text, state, ...noteOf(graph, option), ...supersedeLinks(option), children }];
    });
    const options = [...live, ...hidden];

    const superseded = question.supersedes === undefined ? [] : questionEntries(graph, question.supersedes);

    return [
      {
        kind: "question",
        state: assignedState(question),
        id: question.id,
        text: question.text,
        ...noteOf(graph, question),
        ...supersedeLinks(question),
        options,
        ...(selected.length > 0 && question.rationale !== undefined ? { rationale: question.rationale } : {}),
        children: childEntries(graph, question),
      },
      ...superseded,
    ];
  }

  function followUpEntry(graph: Graph, followUp: FollowUpNode): TreeEntry {
    return {
      kind: "follow-up",
      state: assignedState(followUp),
      id: followUp.id,
      text: followUp.text,
      ...noteOf(graph, followUp),
      children: childEntries(graph, followUp),
    };
  }

  function buildTree(log: Log, target?: string): TreeEntry[] {
    const graph = build(log);

    if (target !== undefined) {
      const node = targetNode(graph, target);

      return node.kind === "question" ? questionEntries(graph, node).slice(0, 1) : [followUpEntry(graph, node)];
    }

    return [
      ...graph.roots.flatMap((question) => questionEntries(graph, question)),
      ...graph.rootFollowUps.map((followUp) => followUpEntry(graph, followUp)),
    ];
  }

  function filterTree(entries: TreeEntry[], states: ItemState[]): TreeEntry[] {
    return entries.flatMap((entry) => {
      const children = filterTree(entry.children, states);
      const options =
        entry.kind === "question"
          ? entry.options.map((option) => ({ ...option, children: filterTree(option.children, states) }))
          : [];
      const holdsMatch = children.length > 0 || options.some((option) => option.children.length > 0);
      if (!states.includes(entry.state) && !holdsMatch) return [];

      return [entry.kind === "question" ? { ...entry, options, children } : { ...entry, children }];
    });
  }

  function firstQuestionEntry(log: Log): Extract<TreeEntry, { kind: "question" }> {
    const [item] = buildTree(log);
    if (item?.kind !== "question") throw new Error("the first entry of the built tree is not a question");

    return item;
  }

  function trail(log: Log, id: string): TrailStep[] {
    const steps: TrailStep[] = [];

    let current: QuestionNode | OptionNode | FollowUpNode | undefined = parentNode(build(log).nodes, id);
    while (current !== undefined) {
      current = current.kind === "option" ? current.question : current.parent;
      if (current !== undefined) steps.unshift({ kind: current.kind, id: current.id, text: current.text });
    }

    return steps;
  }

  function hasOpen(log: Log, node: QuestionNode | FollowUpNode): boolean {
    return openWithin(build(log), node).length > 0;
  }

  function frontier(graph: Graph): OpenItem[] {
    const focused = graph.focus !== undefined && !graph.focus.ended ? graph.focus.node : undefined;

    return openWithin(graph, focused);
  }

  function taggedData(graph: Graph, node: QuestionNode | FollowUpNode): TaggedData {
    const tags = [...(graph.tags.get(node.id) ?? [])];

    if (node.kind === "follow-up") {
      return { item: { kind: "follow-up", followUp: { id: node.id, text: node.text } }, tags };
    }

    const question = { id: node.id, text: node.text, options: liveOptions(graph, node) };

    return { item: { kind: "question", question }, tags };
  }

  function taggedItem(log: Log, id: string): TaggedData {
    const graph = build(log);

    const node = parentNode(graph.nodes, id);
    if (node.kind === "option") throw new Error(`option ${id} cannot be tagged`);

    return taggedData(graph, node);
  }

  function liveSelected(graph: Graph, node: QuestionNode): OptionNode[] {
    if (node.selected.some((option) => option.supersededBy !== undefined)) return [];

    return node.options.filter((option) => node.selected.includes(option) && !graph.exclusions.has(option.id));
  }

  function rejectOffPath(log: Log, node: QuestionNode | FollowUpNode): void {
    const graph = build(log);

    const current = parentNode(graph.nodes, node.id);
    if (current.kind === "option") throw new Error(`option ${node.id} has no path of its own`);
    if (graph.walkOrder.includes(current)) return;

    throw new DecisionTreeError(`${node.id} is off-path, hidden by ${current.hiddenBy}`);
  }

  function hiddenOptions(graph: Graph, question: QuestionNode): HiddenOption[] {
    return question.options.flatMap((option): HiddenOption[] => {
      const state = optionHiding(graph, option);
      if (state === undefined) return [];

      const supersededBy = option.supersededBy === undefined ? {} : { supersededBy: option.supersededBy.id };

      return [{ id: option.id, text: option.text, state, ...noteOf(graph, option), ...supersededBy }];
    });
  }

  function targetNode(graph: Graph, target: string): QuestionNode | FollowUpNode {
    const wanted = graph.nodes.get(target);
    if (wanted === undefined) throw new DecisionTreeError(`target not found: ${target}`);
    if (wanted.kind === "option") throw new DecisionTreeError(`target is not a question or follow-up: ${target}`);

    return wanted;
  }

  function listed(log: Log, tag: string | undefined, states: ItemState[], target?: string): ListedItem[] {
    const graph = build(log);

    if (target !== undefined) targetNode(graph, target);

    const nodes = [...new Set([...graph.walkOrder, ...graph.nodes.values()])];

    return nodes.flatMap((node) => {
      if (node.kind === "option") return [];
      if (tag !== undefined && !graph.tags.get(node.id)?.has(tag)) return [];
      if (target !== undefined && node.id !== target) return [];

      const state = assignedState(node);
      if (!states.includes(state)) return [];

      const selected = node.kind === "question" ? liveSelected(graph, node) : [];
      const selectedData = selected.length === 0 ? {} : { selected: selected.map(({ id, text }) => ({ id, text })) };
      const rationale = node.kind === "question" && selected.length > 0 ? node.rationale : undefined;
      const rationaleData = rationale === undefined ? {} : { rationale };

      const note = graph.exclusions.get(node.id)?.note;
      const noteData = note === undefined ? {} : { note };
      const causeData = node.hiddenBy === undefined ? {} : { hiddenBy: node.hiddenBy };
      const linkData = node.kind === "question" ? supersedeLinks(node) : {};
      const hidden = node.kind === "question" ? hiddenOptions(graph, node) : [];
      const hiddenData = hidden.length === 0 ? {} : { hiddenOptions: hidden };

      return [{ ...taggedData(graph, node), state, ...selectedData, ...rationaleData, ...noteData, ...causeData, ...linkData, ...hiddenData }];
    });
  }

  function isExcluded(node: QuestionNode | OptionNode | FollowUpNode): boolean {
    return node.state === "deferred" || node.state === "not-applicable";
  }

  function liveNode(log: Log, id: string, role: "origin" | "target"): QuestionNode | OptionNode | FollowUpNode {
    const graph = build(log);

    const node = graph.nodes.get(id);
    if (node === undefined) throw new DecisionTreeError(`${role} not found: ${id}`);
    rejectFrozen(graph, node);
    if (isExcluded(node)) throw new DecisionTreeError(`${role} is excluded: ${id}`);

    return node;
  }

  function excludedNode(log: Log, id: string): QuestionNode | OptionNode | FollowUpNode {
    const graph = build(log);

    const node = graph.nodes.get(id);
    if (node === undefined) throw new DecisionTreeError(`target not found: ${id}`);
    rejectFrozen(graph, node);

    if (!isExcluded(node)) throw new DecisionTreeError(`target is not excluded: ${id}`);
    if (node.hiddenBy !== undefined) {
      throw new DecisionTreeError(`${id} cannot be restored, as its ancestor ${node.hiddenBy} is excluded`);
    }

    return node;
  }

  function itemData(log: Log, node: QuestionNode | OptionNode | FollowUpNode): ItemData {
    switch (node.kind) {
      case "question": {
        const options = liveOptions(build(log), node);

        return { kind: "question", question: { id: node.id, text: node.text, options } };
      }

      case "option":
        return { kind: "option", option: { id: node.id, text: node.text } };

      case "follow-up":
        return { kind: "follow-up", followUp: { id: node.id, text: node.text } };
    }
  }

  function tests() {
    test("a node left unset fails the state check", () => {
      // given
      const graph = build(Log.memoryLog([{ type: "add-question", id: "Q1", text: "q" }]));
      questionNode(graph.nodes, "Q1").state = "unset";

      // when
      const act = () => assertStatesAssigned(graph);

      // then
      assert.throws(act, (error) => error instanceof Error && error.message === "node Q1 has no state");
    });

    test("a question with no selection and its options are open", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ]);

      // when
      const graph = build(log);

      // then
      assert.deepEqual([graph.nodes.get("Q1")?.state, graph.nodes.get("Q1a")?.state], ["open", "open"]);
    });

    test("a selected option and its question are settled and an unchosen option is off-path", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
      ]);

      // when
      const graph = build(log);

      // then
      assert.deepEqual(
        ["Q1", "Q1a", "Q1b"].map((id) => graph.nodes.get(id)?.state),
        ["settled", "settled", "off-path"],
      );
    });

    test("a question under an unchosen option is off-path, hidden by that option", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1b" },
      ]);

      // when
      const graph = build(log);

      // then
      const question = questionNode(graph.nodes, "Q2");
      assert.deepEqual([question.state, question.hiddenBy], ["off-path", "Q1b"]);
    });

    test("an off-path question is hidden by its outermost unchosen option", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1b" },
        { type: "add-option", id: "Q2a", text: "c", origin: "Q2" },
        { type: "add-question", id: "Q3", text: "q3", origin: "Q2a" },
      ]);

      // when
      const graph = build(log);

      // then
      assert.equal(questionNode(graph.nodes, "Q3").hiddenBy, "Q1b");
    });

    test("once the outer option is selected, the next unchosen option is the blocker", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1b" },
        { type: "add-option", id: "Q2a", text: "c", origin: "Q2" },
        { type: "add-question", id: "Q3", text: "q3", origin: "Q2a" },
        { type: "select-option", targets: ["Q1b"] },
      ]);

      // when
      const graph = build(log);

      // then
      assert.equal(questionNode(graph.nodes, "Q3").hiddenBy, "Q2a");
    });

    test("a question under an open follow-up in an off-path branch is hidden by the outer option", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-follow-up", id: "F1", text: "f", origin: "Q1b" },
        { type: "add-question", id: "Q2", text: "q2", origin: "F1" },
      ]);

      // when
      const graph = build(log);

      // then
      assert.equal(questionNode(graph.nodes, "Q2").hiddenBy, "Q1b");
    });

    test("an excluded question has its reason as its state and hides what is under it", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
        { type: "exclude", target: "Q1", reason: "deferred" },
      ]);

      // when
      const graph = build(log);

      // then
      const excluded = questionNode(graph.nodes, "Q1");
      const child = questionNode(graph.nodes, "Q2");
      assert.deepEqual(
        [excluded.state, excluded.hiddenBy, child.state, child.hiddenBy],
        ["deferred", undefined, "deferred", "Q1"],
      );
    });

    test("an exclusion above an unchosen option wins over off-path", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "exclude", target: "Q1", reason: "deferred" },
      ]);

      // when
      const graph = build(log);

      // then
      const question = questionNode(graph.nodes, "Q2");
      assert.deepEqual([question.state, question.hiddenBy], ["deferred", "Q1"]);
    });

    test("a superseded question and what is under it are frozen", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
        { type: "add-question", id: "Q3", text: "q3" },
        { type: "supersede-question", target: "Q1", question: "Q3" },
      ]);

      // when
      const graph = build(log);

      // then
      const superseded = questionNode(graph.nodes, "Q1");
      const child = questionNode(graph.nodes, "Q2");
      assert.deepEqual(
        [superseded.state, superseded.hiddenBy, child.state, child.hiddenBy],
        ["frozen", undefined, "frozen", "Q1"],
      );
    });

    test("a superseded option and what is under it are frozen", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "supersede-option", target: "Q1a", option: "Q1b" },
      ]);

      // when
      const graph = build(log);

      // then
      const superseded = optionNode(graph.nodes, "Q1a");
      const child = questionNode(graph.nodes, "Q2");
      const replacement = optionNode(graph.nodes, "Q1b");
      assert.deepEqual(
        [superseded.state, superseded.hiddenBy, child.state, child.hiddenBy, replacement.state],
        ["frozen", undefined, "frozen", "Q1a", "open"],
      );
    });

    test("superseding a selected option reopens its question", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a", "Q1b"], rationale: "both" },
        { type: "add-option", id: "Q1c", text: "c", origin: "Q1" },
        { type: "supersede-option", target: "Q1a", option: "Q1c" },
      ]);

      // when
      const graph = build(log);

      // then
      const question = questionNode(graph.nodes, "Q1");
      const stillSelected = optionNode(graph.nodes, "Q1b");
      assert.deepEqual([question.state, stillSelected.state], ["open", "open"]);
    });

    test("superseding an unselected option keeps its question's selection", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"], rationale: "why" },
        { type: "add-option", id: "Q1c", text: "c", origin: "Q1" },
        { type: "supersede-option", target: "Q1b", option: "Q1c" },
      ]);

      // when
      const graph = build(log);

      // then
      const question = questionNode(graph.nodes, "Q1");
      const selected = optionNode(graph.nodes, "Q1a");
      assert.deepEqual([question.state, selected.state], ["settled", "settled"]);
    });

    test("a question under an open follow-up is off-path, hidden by the follow-up", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-follow-up", id: "F1", text: "f" },
        { type: "add-question", id: "Q1", text: "q", origin: "F1" },
      ]);

      // when
      const graph = build(log);

      // then
      const question = questionNode(graph.nodes, "Q1");
      assert.deepEqual([question.state, question.hiddenBy], ["off-path", "F1"]);
    });

    test("an open follow-up is open and a promoted one is settled", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-follow-up", id: "F1", text: "f1" },
        { type: "add-follow-up", id: "F2", text: "f2" },
        { type: "promote-follow-up", target: "F2" },
      ]);

      // when
      const graph = build(log);

      // then
      assert.deepEqual([graph.nodes.get("F1")?.state, graph.nodes.get("F2")?.state], ["open", "settled"]);
    });

    test("an excluded option has its reason as its state and hides what is under it", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "exclude", target: "Q1a", reason: "deferred" },
      ]);

      // when
      const graph = build(log);

      // then
      const child = questionNode(graph.nodes, "Q2");
      assert.deepEqual([graph.nodes.get("Q1a")?.state, child.state, child.hiddenBy], ["deferred", "deferred", "Q1a"]);
    });

    test("the walk order leaves out off-path and excluded questions", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1b" },
        { type: "add-question", id: "Q3", text: "q3" },
        { type: "exclude", target: "Q3", reason: "deferred" },
      ]);

      // when
      const graph = build(log);

      // then
      assert.deepEqual(
        graph.walkOrder.map((node) => node.id),
        ["Q1"],
      );
    });

    test("the walk order goes answer first, then the question's own, then the roots", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-follow-up", id: "F3", text: "root follow-up" },
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q4", text: "second root" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-follow-up", id: "F2", text: "question follow-up", origin: "Q1" },
        { type: "add-question", id: "Q3", text: "question child", origin: "Q1" },
        { type: "add-follow-up", id: "F1", text: "answer follow-up", origin: "Q1a" },
        { type: "add-question", id: "Q2", text: "answer child", origin: "Q1a" },
      ]);

      // when
      const graph = build(log);

      // then
      assert.deepEqual(
        graph.walkOrder.map((node) => node.id),
        ["Q1", "Q2", "F1", "Q3", "F2", "Q4", "F3"],
      );
    });

    test("the walk order has a promoted follow-up before what came from it", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-follow-up", id: "F1", text: "f" },
        { type: "add-question", id: "Q1", text: "q", origin: "F1" },
        { type: "promote-follow-up", target: "F1" },
      ]);

      // when
      const graph = build(log);

      // then
      assert.deepEqual(
        graph.walkOrder.map((node) => node.id),
        ["F1", "Q1"],
      );
    });

    test("a focus ends when its question leaves the current path", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "add-question", id: "Q3", text: "q3" },
        { type: "focus", target: "Q2" },
        { type: "select-option", targets: ["Q1b"] },
      ]);

      // when
      const graph = build(log);

      // then
      assert.equal(graph.focus?.ended, true);
      assert.deepEqual(
        frontier(graph).map((item) => item.id),
        ["Q3"],
      );
    });

    test("an option under an excluded question is hidden by that question", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "exclude", target: "Q1", reason: "deferred" },
      ]);

      // when
      const graph = build(log);

      // then
      const option = optionNode(graph.nodes, "Q1a");
      assert.deepEqual([option.state, option.hiddenBy], ["deferred", "Q1"]);
    });

    test("an item both excluded and frozen is refused as frozen", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
        { type: "exclude", target: "Q2", reason: "deferred" },
        { type: "add-question", id: "Q3", text: "q3" },
        { type: "supersede-question", target: "Q1", question: "Q3" },
      ]);

      // when
      const act = () => liveNode(log, "Q2", "target");

      // then
      assert.throws(
        act,
        (error) =>
          error instanceof DecisionTreeError &&
          error.message === "Q2 is frozen, as its ancestor Q1 was superseded by Q3",
      );
    });

    test("the built tree of an empty log has no items", () => {
      // given
      const log = Log.memoryLog();

      // when
      const items = buildTree(log);

      // then
      assert.deepEqual(items, []);
    });

    test("the built tree nests a question under the selected option that holds it", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
      ]);

      // when
      const items = buildTree(log);

      // then
      assert.deepEqual(items, [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q1",
          options: [
            {
              id: "Q1a",
              text: "a",
              selected: true,
              children: [{ kind: "question", state: "open", id: "Q2", text: "q2", options: [], children: [] }],
            },
          ],
          children: [],
        },
      ]);
    });

    test("the built tree keeps a question-level child in the question's children", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
      ]);

      // when
      const items = buildTree(log);

      // then
      assert.deepEqual(items, [
        {
          kind: "question",
          state: "open",
          id: "Q1",
          text: "q1",
          options: [],
          children: [{ kind: "question", state: "open", id: "Q2", text: "q2", options: [], children: [] }],
        },
      ]);
    });

    test("the built tree lists every live option and marks only the chosen one", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1b"] },
      ]);

      // when
      const question = firstQuestionEntry(log);

      // then
      assert.deepEqual(question.options, [
        { id: "Q1a", text: "a", children: [] },
        { id: "Q1b", text: "b", selected: true, children: [] },
      ]);
    });

    test("the built tree holds an off-path question inside its unchosen option", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1b" },
      ]);

      // when
      const question = firstQuestionEntry(log);

      // then
      assert.deepEqual(question.options[1].children, [
        { kind: "question", state: "off-path", id: "Q2", text: "q2", options: [], children: [] },
      ]);
    });

    test("the built tree gives two selected options their own children", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a", "Q1b"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "add-question", id: "Q3", text: "q3", origin: "Q1b" },
      ]);

      // when
      const question = firstQuestionEntry(log);

      // then
      assert.deepEqual(
        question.options.map((option) => option.children.map((child) => child.id)),
        [["Q2"], ["Q3"]],
      );
    });

    test("the built tree shows a promoted follow-up as a settled step holding its question", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-follow-up", id: "F1", text: "f" },
        { type: "add-question", id: "Q1", text: "q", origin: "F1" },
        { type: "promote-follow-up", target: "F1" },
      ]);

      // when
      const items = buildTree(log);

      // then
      assert.deepEqual(items, [
        {
          kind: "follow-up",
          state: "settled",
          id: "F1",
          text: "f",
          children: [{ kind: "question", state: "open", id: "Q1", text: "q", options: [], children: [] }],
        },
      ]);
    });

    test("the built tree places follow-ups after the questions at their level", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-follow-up", id: "F1", text: "answer follow-up", origin: "Q1a" },
        { type: "add-question", id: "Q2", text: "answer child", origin: "Q1a" },
        { type: "add-follow-up", id: "F2", text: "question follow-up", origin: "Q1" },
        { type: "add-question", id: "Q3", text: "question child", origin: "Q1" },
      ]);

      // when
      const question = firstQuestionEntry(log);

      // then
      assert.deepEqual(
        question.options[0].children.map((child) => child.id),
        ["Q2", "F1"],
      );
      assert.deepEqual(
        question.children.map((child) => child.id),
        ["Q3", "F2"],
      );
    });

    test("the built tree keeps a deferred question in place with its note and child", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
        { type: "exclude", target: "Q1", reason: "deferred", note: "why" },
      ]);

      // when
      const items = buildTree(log);

      // then
      assert.deepEqual(items, [
        {
          kind: "question",
          state: "deferred",
          id: "Q1",
          text: "q1",
          note: "why",
          options: [],
          children: [{ kind: "question", state: "deferred", id: "Q2", text: "q2", options: [], children: [] }],
        },
      ]);
    });

    test("the built tree lists an excluded option after the live ones, with its state and note", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "exclude", target: "Q1a", reason: "deferred", note: "why" },
      ]);

      // when
      const question = firstQuestionEntry(log);

      // then
      assert.deepEqual(question.options, [
        { id: "Q1b", text: "b", children: [] },
        { id: "Q1a", text: "a", state: "deferred", note: "why", children: [] },
      ]);
    });

    test("the built tree links a superseded option and its replacement, and lists the frozen one last", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "add-option", id: "Q1c", text: "c", origin: "Q1" },
        { type: "supersede-option", target: "Q1a", option: "Q1c" },
      ]);

      // when
      const question = firstQuestionEntry(log);

      // then
      assert.deepEqual(question.options, [
        { id: "Q1b", text: "b", children: [] },
        { id: "Q1c", text: "c", supersedes: "Q1a", children: [] },
        {
          id: "Q1a",
          text: "a",
          state: "frozen",
          supersededBy: "Q1c",
          children: [{ kind: "question", state: "frozen", id: "Q2", text: "q2", options: [], children: [] }],
        },
      ]);
    });

    test("the built tree leaves out the rationale once every selected option is excluded", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"], rationale: "why" },
        { type: "exclude", target: "Q1a", reason: "not-applicable" },
      ]);

      // when
      const question = firstQuestionEntry(log);

      // then
      assert.equal(question.rationale, undefined);
    });

    test("the built tree carries the rationale of a question's selection", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"], rationale: "why" },
      ]);

      // when
      const question = firstQuestionEntry(log);

      // then
      assert.equal(question.rationale, "why");
    });

    test("the built tree puts a superseded question right after its replacement", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "old" },
        { type: "add-question", id: "Q2", text: "kid", origin: "Q1" },
        { type: "add-question", id: "Q3", text: "other root" },
        { type: "add-question", id: "Q4", text: "new" },
        { type: "supersede-question", target: "Q1", question: "Q4" },
      ]);

      // when
      const items = buildTree(log);

      // then
      assert.deepEqual(
        items.map((item) => [item.id, item.state]),
        [
          ["Q4", "open"],
          ["Q1", "frozen"],
          ["Q3", "open"],
        ],
      );
      assert.deepEqual(
        items[1].children.map((child) => [child.id, child.state]),
        [["Q2", "frozen"]],
      );
    });

    test("the built tree links a superseded question and its replacement", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "old" },
        { type: "add-question", id: "Q2", text: "new" },
        { type: "supersede-question", target: "Q1", question: "Q2" },
      ]);

      // when
      const items = buildTree(log);

      // then
      assert.deepEqual(items, [
        { kind: "question", state: "open", id: "Q2", text: "new", supersedes: "Q1", options: [], children: [] },
        { kind: "question", state: "frozen", id: "Q1", text: "old", supersededBy: "Q2", options: [], children: [] },
      ]);
    });

    test("the built tree lists a question superseded twice newest first", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "first" },
        { type: "add-question", id: "Q2", text: "second" },
        { type: "supersede-question", target: "Q1", question: "Q2" },
        { type: "add-question", id: "Q3", text: "third" },
        { type: "supersede-question", target: "Q2", question: "Q3" },
      ]);

      // when
      const items = buildTree(log);

      // then
      assert.deepEqual(
        items.map((item) => [item.id, item.state]),
        [
          ["Q3", "open"],
          ["Q2", "frozen"],
          ["Q1", "frozen"],
        ],
      );
    });

    test("filtering drops an entry whose state was not asked for", () => {
      // given
      const entries: TreeEntry[] = [
        { kind: "question", state: "settled", id: "Q1", text: "q", options: [], children: [] },
      ];

      // when
      const kept = filterTree(entries, ["open"]);

      // then
      assert.deepEqual(kept, []);
    });

    test("filtering keeps a settled question that holds an open child", () => {
      // given
      const open: TreeEntry = { kind: "question", state: "open", id: "Q2", text: "q2", options: [], children: [] };
      const entries: TreeEntry[] = [
        { kind: "question", state: "settled", id: "Q1", text: "q1", options: [], children: [open] },
      ];

      // when
      const kept = filterTree(entries, ["open"]);

      // then
      assert.deepEqual(kept, entries);
    });

    test("filtering keeps the path through a selected option to an open child", () => {
      // given
      const open: TreeEntry = { kind: "question", state: "open", id: "Q2", text: "q2", options: [], children: [] };
      const entries: TreeEntry[] = [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q1",
          options: [{ id: "Q1a", text: "a", selected: true, children: [open] }],
          children: [],
        },
      ];

      // when
      const kept = filterTree(entries, ["open"]);

      // then
      assert.deepEqual(kept, entries);
    });

    test("filtering ignores an excluded option's own state", () => {
      // given
      const entries: TreeEntry[] = [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q",
          options: [{ id: "Q1a", text: "a", state: "deferred", children: [] }],
          children: [],
        },
      ];

      // when
      const kept = filterTree(entries, ["deferred"]);

      // then
      assert.deepEqual(kept, []);
    });

    test("filtering keeps an option but drops an off-path child under it", () => {
      // given
      const offPath: TreeEntry = {
        kind: "question",
        state: "off-path",
        id: "Q2",
        text: "q2",
        options: [],
        children: [],
      };
      const entries: TreeEntry[] = [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q1",
          options: [{ id: "Q1a", text: "a", children: [offPath] }],
          children: [],
        },
      ];

      // when
      const kept = filterTree(entries, ["settled"]);

      // then
      assert.deepEqual(kept, [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q1",
          options: [{ id: "Q1a", text: "a", children: [] }],
          children: [],
        },
      ]);
    });

    test("filtering keeps a promoted follow-up that holds an open question", () => {
      // given
      const open: TreeEntry = { kind: "question", state: "open", id: "Q1", text: "q", options: [], children: [] };
      const entries: TreeEntry[] = [{ kind: "follow-up", state: "settled", id: "F1", text: "f", children: [open] }];

      // when
      const kept = filterTree(entries, ["open"]);

      // then
      assert.deepEqual(kept, entries);
    });

    test("filtering by deferred keeps a deferred question and the settled one around it", () => {
      // given
      const deferred: TreeEntry = {
        kind: "question",
        state: "deferred",
        id: "Q2",
        text: "q2",
        note: "why",
        options: [],
        children: [],
      };
      const entries: TreeEntry[] = [
        { kind: "question", state: "settled", id: "Q1", text: "q1", options: [], children: [deferred] },
      ];

      // when
      const kept = filterTree(entries, ["deferred"]);

      // then
      assert.deepEqual(kept, entries);
    });

    test("filtering by frozen keeps the frozen question and drops its open replacement", () => {
      // given
      const entries: TreeEntry[] = [
        { kind: "question", state: "open", id: "Q2", text: "new", options: [], children: [] },
        { kind: "question", state: "frozen", id: "Q1", text: "old", options: [], children: [] },
      ];

      // when
      const kept = filterTree(entries, ["frozen"]);

      // then
      assert.deepEqual(
        kept.map((entry) => entry.id),
        ["Q1"],
      );
    });

    test("filtering by several states keeps entries matching any of them", () => {
      // given
      const entry = (id: string, state: ItemState): TreeEntry => ({
        kind: "question",
        state,
        id,
        text: id,
        options: [],
        children: [],
      });
      const entries = [entry("Q1", "open"), entry("Q2", "settled"), entry("Q3", "deferred")];

      // when
      const kept = filterTree(entries, ["open", "deferred"]);

      // then
      assert.deepEqual(
        kept.map((each) => each.id),
        ["Q1", "Q3"],
      );
    });

    test("an unknown event type throws", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "dismiss-follow-up", target: "F1" } as unknown as Event,
      ]);

      // when
      const act = () => build(log);

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "unknown event type: dismiss-follow-up",
      );
    });

    test("a select-option event without targets throws", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", target: "Q1a" } as unknown as Event,
      ]);

      // when
      const act = () => build(log);

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "select-option event has no targets",
      );
    });

    test("the latest selection is the question's answer", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "select-option", targets: ["Q1b"] },
      ]);

      // when
      const graph = build(log);

      // then
      assert.equal(questionNode(graph.nodes, "Q1").selected[0]?.id, "Q1b");
    });

    test("clearing a selection reopens its question", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"], rationale: "why" },
        { type: "clear-selection", target: "Q1" },
      ]);

      // when
      const graph = build(log);

      // then
      const question = questionNode(graph.nodes, "Q1");
      const cleared = optionNode(graph.nodes, "Q1a");
      assert.deepEqual([question.state, cleared.state], ["open", "open"]);
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
          { type: "select-option", targets: ["Q1a"] },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(open, []);
    });

    test("an open question on the frontier leaves out a superseded option", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
          { type: "supersede-option", target: "Q1a", option: "Q1b" },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(open, [
        { kind: "open-question", id: "Q1", text: "q1", options: [{ id: "Q1b", text: "b" }] },
      ]);
    });

    test("a question under the selected option is on the frontier", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
          { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
          { type: "select-option", targets: ["Q1a"] },
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
          { type: "select-option", targets: ["Q1a"] },
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
          { type: "select-option", targets: ["Q1a"] },
          { type: "select-option", targets: ["Q1b"] },
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

    test("closed follow-ups are off the frontier", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "select-option", targets: ["Q1a"] },
          { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1" },
          { type: "add-follow-up", id: "F2", text: "f2", origin: "Q1" },
          { type: "promote-follow-up", target: "F1" },
          { type: "exclude", target: "F2", reason: "not-applicable" },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(open, []);
    });

    test("a follow-up under an unselected option is off the frontier", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
          { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1b" },
          { type: "select-option", targets: ["Q1a"] },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(open, []);
    });

    test("follow-ups come up on backtrack from where they hang", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "add-follow-up", id: "F2", text: "f2", origin: "Q1" },
          { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1a" },
          { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
          { type: "add-question", id: "Q3", text: "q3", origin: "Q1" },
          { type: "add-question", id: "Q4", text: "q4" },
          { type: "select-option", targets: ["Q1a"] },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(
        open.map((node) => node.id),
        ["Q2", "F1", "Q3", "F2", "Q4"],
      );
    });

    test("an open follow-up hides what hangs under it", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "select-option", targets: ["Q1a"] },
          { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1" },
          { type: "add-follow-up", id: "F2", text: "f2", origin: "F1" },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(
        open.map((node) => node.id),
        ["F1"],
      );
    });

    test("a promoted follow-up opens: its question first, then its follow-ups", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "select-option", targets: ["Q1a"] },
          { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1" },
          { type: "add-follow-up", id: "F2", text: "f2", origin: "F1" },
          { type: "add-question", id: "Q2", text: "f1", origin: "F1" },
          { type: "promote-follow-up", target: "F1" },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(
        open.map((node) => node.id),
        ["Q2", "F2"],
      );
    });

    test("an excluded follow-up hides what hangs under it", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "select-option", targets: ["Q1a"] },
          { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1" },
          { type: "add-follow-up", id: "F2", text: "f2", origin: "F1" },
          { type: "exclude", target: "F1", reason: "not-applicable" },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(open, []);
    });

    test("root follow-ups come up after all roots", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-follow-up", id: "F1", text: "f1" },
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-question", id: "Q2", text: "q2" },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(
        open.map((node) => node.id),
        ["Q1", "Q2", "F1"],
      );
    });

    test("a focus puts only its subtree's open items on the frontier", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-question", id: "Q2", text: "q2" },
          { type: "focus", target: "Q2" },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(
        open.map((node) => node.id),
        ["Q2"],
      );
    });

    test("an exhausted focus gives the frontier back to the normal walk", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-question", id: "Q2", text: "q2" },
          { type: "add-option", id: "Q2a", text: "a", origin: "Q2" },
          { type: "focus", target: "Q2" },
          { type: "select-option", targets: ["Q2a"] },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(
        open.map((node) => node.id),
        ["Q1"],
      );
    });

    test("an active focus moves to the question that supersedes its question", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-question", id: "Q2", text: "q2" },
          { type: "focus", target: "Q2" },
          { type: "add-question", id: "Q3", text: "q3" },
          { type: "supersede-question", target: "Q2", question: "Q3" },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(
        open.map((node) => node.id),
        ["Q3"],
      );
    });

    test("an ended focus does not move to the question that supersedes its question", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-question", id: "Q2", text: "q2" },
          { type: "add-option", id: "Q2a", text: "a", origin: "Q2" },
          { type: "focus", target: "Q2" },
          { type: "select-option", targets: ["Q2a"] },
          { type: "add-question", id: "Q3", text: "q3" },
          { type: "supersede-question", target: "Q2", question: "Q3" },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(
        open.map((node) => node.id),
        ["Q1", "Q3"],
      );
    });

    test("an ended focus does not return when new work appears under it", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-question", id: "Q2", text: "q2" },
          { type: "add-option", id: "Q2a", text: "a", origin: "Q2" },
          { type: "focus", target: "Q2" },
          { type: "select-option", targets: ["Q2a"] },
          { type: "add-follow-up", id: "F1", text: "f1", origin: "Q2" },
        ]),
      );

      // when
      const open = frontier(graph);

      // then
      assert.deepEqual(
        open.map((node) => node.id),
        ["Q1", "F1"],
      );
    });

    test("the tag query returns only open on-path items with that tag", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "settled" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "open", origin: "Q1a" },
        { type: "add-question", id: "Q3", text: "off-path", origin: "Q1b" },
        { type: "add-question", id: "Q4", text: "other tag" },
        { type: "tag", target: "Q1", tags: ["t"] },
        { type: "tag", target: "Q2", tags: ["t"] },
        { type: "tag", target: "Q3", tags: ["t"] },
        { type: "tag", target: "Q4", tags: ["u"] },
      ]);

      // when
      const items = listed(log, "t", ["open"]);

      // then
      assert.deepEqual(items, [
        { item: { kind: "question", question: { id: "Q2", text: "open", options: [] } }, tags: ["t"], state: "open" },
      ]);
    });

    test("the tag query is not limited by an active focus", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2" },
        { type: "tag", target: "Q1", tags: ["t"] },
        { type: "focus", target: "Q2" },
      ]);

      // when
      const items = listed(log, "t", ["open"]);

      // then
      assert.deepEqual(items, [
        { item: { kind: "question", question: { id: "Q1", text: "q1", options: [] } }, tags: ["t"], state: "open" },
      ]);
    });

    test("the tag query reports each item's state", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "settled" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "off-path", origin: "Q1b" },
        { type: "add-question", id: "Q3", text: "deferred" },
        { type: "add-question", id: "Q4", text: "not-applicable" },
        { type: "add-question", id: "Q5", text: "frozen" },
        { type: "add-question", id: "Q6", text: "replacement" },
        { type: "supersede-question", target: "Q5", question: "Q6" },
        { type: "exclude", target: "Q3", reason: "deferred" },
        { type: "exclude", target: "Q4", reason: "not-applicable" },
        { type: "tag", target: "Q1", tags: ["t"] },
        { type: "tag", target: "Q2", tags: ["t"] },
        { type: "tag", target: "Q3", tags: ["t"] },
        { type: "tag", target: "Q4", tags: ["t"] },
        { type: "tag", target: "Q5", tags: ["t"] },
      ]);

      // when
      const items = listed(log, "t", ["settled", "off-path", "deferred", "not-applicable", "frozen"]);

      // then
      assert.deepEqual(
        items.map((each) => [each.item.kind === "question" ? each.item.question.id : "", each.state]),
        [
          ["Q1", "settled"],
          ["Q2", "off-path"],
          ["Q3", "deferred"],
          ["Q4", "not-applicable"],
          ["Q5", "frozen"],
        ],
      );
    });

    test("a settled tagged question carries what was selected", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "tag", target: "Q1", tags: ["t"] },
      ]);

      // when
      const items = listed(log, "t", ["settled"]);

      // then
      assert.deepEqual(
        items.map((each) => each.selected),
        [[{ id: "Q1a", text: "a" }]],
      );
    });

    test("a promoted follow-up counts as settled in the tag query", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-follow-up", id: "F1", text: "f" },
        { type: "add-question", id: "Q1", text: "f", origin: "F1" },
        { type: "promote-follow-up", target: "F1" },
        { type: "tag", target: "F1", tags: ["t"] },
      ]);

      // when
      const items = listed(log, "t", ["settled"]);

      // then
      assert.deepEqual(items, [
        { item: { kind: "follow-up", followUp: { id: "F1", text: "f" } }, tags: ["t"], state: "settled" },
      ]);
    });

    test("an excluded tagged item carries its note", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "tag", target: "Q1", tags: ["t"] },
        { type: "exclude", target: "Q1", reason: "not-applicable", note: "why" },
      ]);

      // when
      const items = listed(log, "t", ["not-applicable"]);

      // then
      assert.deepEqual(
        items.map((each) => each.note),
        ["why"],
      );
    });

    test("a listed question leaves out the rationale once every selected option is excluded", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"], rationale: "why" },
        { type: "exclude", target: "Q1a", reason: "not-applicable" },
      ]);

      // when
      const items = listed(log, undefined, ["open"]);

      // then
      assert.deepEqual(
        items.map((each) => each.rationale),
        [undefined],
      );
    });

    test("a listed question carries the rationale of its selection", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"], rationale: "why" },
      ]);

      // when
      const items = listed(log, undefined, ["settled"]);

      // then
      assert.deepEqual(
        items.map((each) => each.rationale),
        ["why"],
      );
    });

    test("a tagged item under an excluded ancestor is hidden by it and has no note of its own", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
        { type: "tag", target: "Q2", tags: ["t"] },
        { type: "exclude", target: "Q1", reason: "deferred", note: "why" },
      ]);

      // when
      const items = listed(log, "t", ["deferred"]);

      // then
      assert.deepEqual(
        items.map((each) => [each.hiddenBy, each.note]),
        [["Q1", undefined]],
      );
    });

    test("a tagged item under a superseded question is hidden by it", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
        { type: "tag", target: "Q2", tags: ["t"] },
        { type: "add-question", id: "Q3", text: "q3" },
        { type: "supersede-question", target: "Q1", question: "Q3" },
      ]);

      // when
      const items = listed(log, "t", ["frozen"]);

      // then
      assert.deepEqual(
        items.map((each) => each.hiddenBy),
        ["Q1"],
      );
    });

    test("a listed superseded question and its replacement link to each other", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "old" },
        { type: "add-question", id: "Q2", text: "new" },
        { type: "supersede-question", target: "Q1", question: "Q2" },
      ]);

      // when
      const items = listed(log, undefined, ["open", "frozen"]);

      // then
      assert.deepEqual(
        items.map((each) => [each.state, each.supersedes, each.supersededBy]),
        [
          ["open", "Q1", undefined],
          ["frozen", undefined, "Q2"],
        ],
      );
    });

    test("an off-path tagged item is hidden by the unselected option above it", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1b" },
        { type: "tag", target: "Q2", tags: ["t"] },
      ]);

      // when
      const items = listed(log, "t", ["off-path"]);

      // then
      assert.deepEqual(
        items.map((each) => each.hiddenBy),
        ["Q1b"],
      );
    });

    test("a tagged item under an open follow-up is hidden by that follow-up", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-follow-up", id: "F1", text: "f" },
        { type: "add-question", id: "Q1", text: "q", origin: "F1" },
        { type: "tag", target: "Q1", tags: ["t"] },
      ]);

      // when
      const items = listed(log, "t", ["off-path"]);

      // then
      assert.deepEqual(
        items.map((each) => each.hiddenBy),
        ["F1"],
      );
    });

    test("an item excluded directly is not hidden by anything else", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "tag", target: "Q1", tags: ["t"] },
        { type: "exclude", target: "Q1", reason: "deferred" },
      ]);

      // when
      const items = listed(log, "t", ["deferred"]);

      // then
      assert.deepEqual(
        items.map((each) => each.hiddenBy),
        [undefined],
      );
    });

    test("a trail lists the ancestors from the root down, with the options on the way", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
      ]);

      // when
      const steps = trail(log, "Q2");

      // then
      assert.deepEqual(steps, [
        { kind: "question", id: "Q1", text: "q1" },
        { kind: "option", id: "Q1a", text: "a" },
      ]);
    });

    test("a root item has an empty trail", () => {
      // given
      const log = Log.memoryLog([{ type: "add-question", id: "Q1", text: "q1" }]);

      // when
      const steps = trail(log, "Q1");

      // then
      assert.deepEqual(steps, []);
    });

    test("a superseding question keeps the old question's tags", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "tag", target: "Q1", tags: ["t"] },
        { type: "add-question", id: "Q2", text: "q2" },
        { type: "supersede-question", target: "Q1", question: "Q2" },
      ]);

      // when
      const items = listed(log, "t", ["open"]);

      // then
      assert.deepEqual(items, [
        {
          item: { kind: "question", question: { id: "Q2", text: "q2", options: [] } },
          tags: ["t"],
          state: "open",
          supersedes: "Q1",
        },
      ]);
    });

    test("looking up an unknown id throws not found for its role", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => liveNode(log, "Q9", "target");

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "target not found: Q9");
    });

    test("looking up an excluded item throws excluded for its role", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "exclude", target: "Q1", reason: "deferred" },
      ]);

      // when
      const act = () => liveNode(log, "Q1", "origin");

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "origin is excluded: Q1");
    });

    test("looking up an item under an excluded option throws excluded", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "exclude", target: "Q1a", reason: "not-applicable" },
      ]);

      // when
      const act = () => liveNode(log, "Q2", "target");

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "target is excluded: Q2");
    });

    test("looking up a live item returns its node", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ]);

      // when
      const node = liveNode(log, "Q1a", "target");

      // then
      assert.equal(node.kind, "option");
      assert.equal(node.id, "Q1a");
      assert.equal(node.text, "a");
      assert.equal(node.kind === "option" ? node.question.id : undefined, "Q1");
    });

    test("looking up an unknown id to restore throws not found", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => excludedNode(log, "Q9");

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "target not found: Q9");
    });

    test("looking up a live item to restore throws not excluded", () => {
      // given
      const log = Log.memoryLog([{ type: "add-question", id: "Q1", text: "q" }]);

      // when
      const act = () => excludedNode(log, "Q1");

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "target is not excluded: Q1");
    });

    test("looking up an item hidden by an excluded ancestor to restore throws", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "exclude", target: "Q1a", reason: "not-applicable" },
      ]);

      // when
      const act = () => excludedNode(log, "Q2");

      // then
      assert.throws(
        act,
        (error) =>
          error instanceof DecisionTreeError && error.message === "Q2 cannot be restored, as its ancestor Q1a is excluded",
      );
    });

    test("looking up an excluded item to restore returns its node", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "exclude", target: "Q1a", reason: "deferred" },
      ]);

      // when
      const node = excludedNode(log, "Q1a");

      // then
      assert.equal(node.kind, "option");
      assert.equal(node.id, "Q1a");
    });

    test("looking up a superseded question throws frozen", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2" },
        { type: "supersede-question", target: "Q1", question: "Q2" },
      ]);

      // when
      const act = () => liveNode(log, "Q1", "target");

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "Q1 is frozen, as it was superseded by Q2",
      );
    });

    test("looking up an item under a superseded question throws frozen", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2" },
        { type: "supersede-question", target: "Q1", question: "Q2" },
      ]);

      // when
      const act = () => liveNode(log, "Q1a", "target");

      // then
      assert.throws(
        act,
        (error) =>
          error instanceof DecisionTreeError &&
          error.message === "Q1a is frozen, as its ancestor Q1 was superseded by Q2",
      );
    });

    test("looking up a superseded option throws frozen", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "supersede-option", target: "Q1a", option: "Q1b" },
      ]);

      // when
      const act = () => liveNode(log, "Q1a", "target");

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "Q1a is frozen, as it was superseded by Q1b",
      );
    });

    test("looking up an item under a superseded option throws frozen", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "supersede-option", target: "Q1a", option: "Q1b" },
      ]);

      // when
      const act = () => liveNode(log, "Q2", "target");

      // then
      assert.throws(
        act,
        (error) =>
          error instanceof DecisionTreeError &&
          error.message === "Q2 is frozen, as its ancestor Q1a was superseded by Q1b",
      );
    });

    test("looking up a frozen excluded item to restore throws frozen", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "exclude", target: "Q1a", reason: "deferred" },
        { type: "add-question", id: "Q2", text: "q2" },
        { type: "supersede-question", target: "Q1", question: "Q2" },
      ]);

      // when
      const act = () => excludedNode(log, "Q1a");

      // then
      assert.throws(
        act,
        (error) =>
          error instanceof DecisionTreeError &&
          error.message === "Q1a is frozen, as its ancestor Q1 was superseded by Q2",
      );
    });
  }

  return {
    buildTree,
    filterTree,
    status,
    frontier: (log: Log) => frontier(build(log)),
    hasOpen,
    rejectOffPath,
    trail,
    liveNode,
    excludedNode,
    itemData,
    taggedItem,
    listed,
    tests,
  };
})();

const AddQuestion = (() => {
  const options = {
    text: { type: "string" },
    origin: { type: "string" },
    option: { type: "string", multiple: true },
  } as const;

  function addQuestion(log: Log, text: string, origin?: string): string {
    if (origin !== undefined) Graph.liveNode(log, origin, "origin");

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
    if (!text) throw new DecisionTreeError("add-question requires --text");

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
      assert.throws(act, DecisionTreeError);
      assert.deepEqual(log.read(), []);
    });

    test("question with an empty option throws and appends nothing", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => run(log, { text: "q", option: ["a", ""] });

      // then
      assert.throws(act, DecisionTreeError);
      assert.deepEqual(log.read(), []);
    });

    test("question without options is stored with no options", () => {
      // given
      const log = Log.memoryLog();

      // when
      const question = run(log, { text: "q" });

      // then
      assert.deepEqual(question, { id: "Q1", text: "q", options: [] });
      assert.deepEqual(log.read(), [{ type: "add-question", id: "Q1", text: "q" }]);
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
      const question = run(log, { text: "q2", option: ["b", "c"] });

      // then
      assert.deepEqual(question, {
        id: "Q2",
        text: "q2",
        options: [
          { id: "Q2a", text: "b" },
          { id: "Q2b", text: "c" },
        ],
      });
      assert.deepEqual(log.read(), [
        ...events,
        { type: "add-question", id: "Q2", text: "q2" },
        { type: "add-option", id: "Q2a", text: "b", origin: "Q2" },
        { type: "add-option", id: "Q2b", text: "c", origin: "Q2" },
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
    if (count >= 26) throw new DecisionTreeError(`question ${origin} already has 26 options`);

    return `${origin}${String.fromCharCode("a".charCodeAt(0) + count)}`;
  }

  function add(log: Log, text: string, origin: string): string {
    if (!text) throw new DecisionTreeError("option requires a text");

    const question = Graph.liveNode(log, origin, "origin");
    if (question.kind !== "question") {
      throw new DecisionTreeError(`origin is not a question: ${origin}`);
    }

    const id = nextOptionId(log, origin);

    log.append({ type: "add-option", id, text, origin });

    return id;
  }

  function run(log: Log, config: { text?: string; origin?: string }): OptionData {
    if (!config.text) throw new DecisionTreeError("add-option requires --text");
    if (!config.origin) throw new DecisionTreeError("add-option requires --origin");

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
      assert.throws(act, DecisionTreeError);
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
      assert.throws(act, DecisionTreeError);
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
      assert.throws(act, DecisionTreeError);
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
    target: { type: "string", multiple: true },
    rationale: { type: "string" },
  } as const;

  function liveOption(log: Log, target: string): OptionNode {
    const option = Graph.liveNode(log, target, "target");
    if (option.kind !== "option") {
      throw new DecisionTreeError(`target is not an option: ${target}`);
    }

    return option;
  }

  function select(log: Log, targets: string[], rationale?: string): SelectionData {
    const repeated = targets.find((target, index) => targets.indexOf(target) !== index);
    if (repeated !== undefined) throw new DecisionTreeError(`target is repeated: ${repeated}`);

    const selected = targets.map((target) => liveOption(log, target));
    const question = selected[0].question;
    const stray = selected.find((option) => option.question.id !== question.id);
    if (stray !== undefined) throw new DecisionTreeError(`target is not an option of ${question.id}: ${stray.id}`);

    Graph.rejectOffPath(log, question);

    const event: Event = { type: "select-option", targets };
    if (rationale !== undefined) event.rationale = rationale;

    log.append(event);

    return {
      question: { id: question.id, text: question.text },
      options: selected.map((option) => ({ id: option.id, text: option.text })),
    };
  }

  function run(log: Log, config: { target?: string[]; rationale?: string }): SelectionData {
    if (!config.target) throw new DecisionTreeError("select-option requires --target");

    return select(log, config.target, config.rationale);
  }

  function tests() {
    test("selecting without a target throws and appends nothing", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => run(log, {});

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "select-option requires --target",
      );
      assert.deepEqual(log.read(), []);
    });

    test("selecting the same option twice throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => select(log, ["Q1a", "Q1a"]);

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "target is repeated: Q1a");
      assert.deepEqual(log.read(), events);
    });

    test("selecting options of two questions throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2" },
        { type: "add-option", id: "Q2a", text: "b", origin: "Q2" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => select(log, ["Q1a", "Q2a"]);

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "target is not an option of Q1: Q2a",
      );
      assert.deepEqual(log.read(), events);
    });

    test("selecting an option of an off-path question throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1b" },
        { type: "add-option", id: "Q2a", text: "x", origin: "Q2" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => select(log, ["Q2a"]);

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "Q2 is off-path, hidden by Q1b",
      );
      assert.deepEqual(log.read(), events);
    });

    test("selecting an unknown option throws and appends nothing", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => select(log, ["Q1a"]);

      // then
      assert.throws(act, DecisionTreeError);
      assert.deepEqual(log.read(), []);
    });

    test("selecting a question throws and appends nothing", () => {
      // given
      const question: Event = { type: "add-question", id: "Q1", text: "q" };
      const log = Log.memoryLog([question]);

      // when
      const act = () => select(log, ["Q1"]);

      // then
      assert.throws(act, DecisionTreeError);
      assert.deepEqual(log.read(), [question]);
    });

    test("selecting several options records them in one event and returns them all", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const selection = select(log, ["Q1a", "Q1b"]);

      // then
      assert.deepEqual(selection, {
        question: { id: "Q1", text: "q" },
        options: [
          { id: "Q1a", text: "a" },
          { id: "Q1b", text: "b" },
        ],
      });
      assert.deepEqual(log.read(), [...events, { type: "select-option", targets: ["Q1a", "Q1b"] }]);
    });

    test("selecting an option records it and returns the question with the option", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const selection = select(log, ["Q1a"]);

      // then
      assert.deepEqual(selection, {
        question: { id: "Q1", text: "q" },
        options: [{ id: "Q1a", text: "a" }],
      });
      assert.deepEqual(log.read(), [...events, { type: "select-option", targets: ["Q1a"] }]);
    });

    test("selecting with a rationale records why on the selection", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      run(log, { target: ["Q1a"], rationale: "why" });

      // then
      assert.deepEqual(log.read(), [...events, { type: "select-option", targets: ["Q1a"], rationale: "why" }]);
    });
  }

  return { options, run, tests };
})();

const AddFollowUp = (() => {
  const options = {
    text: { type: "string" },
    origin: { type: "string" },
  } as const;

  function add(log: Log, text: string, origin?: string): string {
    if (!text) throw new DecisionTreeError("follow-up requires a text");

    if (origin !== undefined) Graph.liveNode(log, origin, "origin");

    const id = Log.nextId(log, "add-follow-up", "F");
    const event: Event = { type: "add-follow-up", id, text };
    if (origin !== undefined) event.origin = origin;

    log.append(event);

    return id;
  }

  function run(log: Log, config: { text?: string; origin?: string }): FollowUpData {
    if (!config.text) throw new DecisionTreeError("add-follow-up requires --text");

    const id = add(log, config.text, config.origin);

    return { id, text: config.text };
  }

  function open(log: Log, id: string): FollowUpNode {
    const node = Graph.liveNode(log, id, "target");
    if (node.kind !== "follow-up") throw new DecisionTreeError(`target is not a follow-up: ${id}`);
    if (node.status !== "open") throw new DecisionTreeError(`follow-up ${id} is already ${node.status}`);

    return node;
  }

  function tests() {
    test("follow-up under an unknown origin throws and appends nothing", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => add(log, "f", "Q1");

      // then
      assert.throws(act, DecisionTreeError);
      assert.deepEqual(log.read(), []);
    });

    test("follow-up under an excluded follow-up throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1" },
        { type: "exclude", target: "F1", reason: "not-applicable" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => add(log, "f2", "F1");

      // then
      assert.throws(act, DecisionTreeError);
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

    test("follow-up under an open follow-up is stored with its origin", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const id = add(log, "f2", "F1");

      // then
      assert.equal(id, "F2");
      assert.deepEqual(log.read(), [
        ...events,
        { type: "add-follow-up", id: "F2", text: "f2", origin: "F1" },
      ]);
    });

    test("follow-up without an origin is stored without an origin field", () => {
      // given
      const log = Log.memoryLog();

      // when
      const id = add(log, "f");

      // then
      assert.equal(id, "F1");
      assert.deepEqual(log.read(), [{ type: "add-follow-up", id: "F1", text: "f" }]);
    });

    test("an excluded follow-up is not open", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-follow-up", id: "F1", text: "f", origin: "Q1" },
        { type: "exclude", target: "F1", reason: "not-applicable" },
      ]);

      // when
      const act = () => open(log, "F1");

      // then
      assert.throws(act, DecisionTreeError);
    });
  }

  return { options, open, run, tests };
})();

const PromoteFollowUp = (() => {
  const options = {
    target: { type: "string" },
    text: { type: "string" },
    option: { type: "string", multiple: true },
  } as const;

  function run(log: Log, config: { target?: string; text?: string; option?: string[] }): PromoteData {
    const target = config.target;
    if (!target) throw new DecisionTreeError("promote-follow-up requires --target");

    return Log.transaction(log, (staged) => {
      const followUp = AddFollowUp.open(staged, target);
      const question = AddQuestion.run(staged, {
        text: config.text ?? followUp.text,
        origin: followUp.id,
        option: config.option,
      });

      staged.append({ type: "promote-follow-up", target });

      return { question, promoted: { id: followUp.id, text: followUp.text } };
    });
  }

  function tests() {
    test("promoting without a target throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-follow-up", id: "F1", text: "f", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { option: ["x", "y"] });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "promote-follow-up requires --target",
      );
      assert.deepEqual(log.read(), events);
    });

    test("promoting with an empty option throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-follow-up", id: "F1", text: "f", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "F1", option: ["a", ""] });

      // then
      assert.throws(act, DecisionTreeError);
      assert.deepEqual(log.read(), events);
    });

    test("promoting a follow-up creates its question under it", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-follow-up", id: "F1", text: "f", origin: "Q1a" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const promotion = run(log, { target: "F1", option: ["x", "y"] });

      // then
      assert.deepEqual(promotion, {
        question: {
          id: "Q2",
          text: "f",
          options: [
            { id: "Q2a", text: "x" },
            { id: "Q2b", text: "y" },
          ],
        },
        promoted: { id: "F1", text: "f" },
      });
      assert.deepEqual(log.read(), [
        ...events,
        { type: "add-question", id: "Q2", text: "f", origin: "F1" },
        { type: "add-option", id: "Q2a", text: "x", origin: "Q2" },
        { type: "add-option", id: "Q2b", text: "y", origin: "Q2" },
        { type: "promote-follow-up", target: "F1" },
      ]);
    });

    test("promoting with a text words the question that way and leaves the follow-up as it was", () => {
      // given
      const events: Event[] = [{ type: "add-follow-up", id: "F1", text: "f" }];
      const log = Log.memoryLog([...events]);

      // when
      const promotion = run(log, { target: "F1", text: "better" });

      // then
      assert.deepEqual(promotion, {
        question: { id: "Q1", text: "better", options: [] },
        promoted: { id: "F1", text: "f" },
      });
      assert.deepEqual(log.read(), [
        ...events,
        { type: "add-question", id: "Q1", text: "better", origin: "F1" },
        { type: "promote-follow-up", target: "F1" },
      ]);
    });
  }

  return { options, run, tests };
})();

const Exclude = (() => {
  const options = {
    target: { type: "string" },
    reason: { type: "string" },
    note: { type: "string" },
  } as const;

  const reasons: ExclusionReason[] = ["not-applicable", "deferred"];

  function run(log: Log, config: { target?: string; reason?: string; note?: string }): ItemData {
    const { target, reason, note } = config;
    if (!target) throw new DecisionTreeError("exclude requires --target");
    if (!reason) throw new DecisionTreeError("exclude requires --reason");
    if (note === "") throw new DecisionTreeError("exclude --note requires a text");

    const exclusionReason = reasons.find((each) => each === reason);
    if (exclusionReason === undefined) {
      throw new DecisionTreeError(`reason must be ${reasons.join(" or ")}: ${reason}`);
    }

    const node = Graph.liveNode(log, target, "target");

    const excluded = Graph.itemData(log, node);

    const event: Event = { type: "exclude", target, reason: exclusionReason };
    if (note !== undefined) event.note = note;

    log.append(event);

    return excluded;
  }

  function tests() {
    test("excluding without a target throws and appends nothing", () => {
      // given
      const events: Event[] = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { reason: "deferred" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "exclude requires --target",
      );
      assert.deepEqual(log.read(), events);
    });

    test("excluding without a reason throws and appends nothing", () => {
      // given
      const events: Event[] = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q1" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "exclude requires --reason",
      );
      assert.deepEqual(log.read(), events);
    });

    test("excluding with an empty note throws and appends nothing", () => {
      // given
      const events: Event[] = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q1", reason: "deferred", note: "" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "exclude --note requires a text",
      );
      assert.deepEqual(log.read(), events);
    });

    test("excluding with an unknown reason throws and appends nothing", () => {
      // given
      const events: Event[] = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q1", reason: "later" });

      // then
      assert.throws(
        act,
        (error) =>
          error instanceof DecisionTreeError && error.message === "reason must be not-applicable or deferred: later",
      );
      assert.deepEqual(log.read(), events);
    });

    test("excluding an unknown target throws and appends nothing", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => run(log, { target: "Q9", reason: "deferred" });

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "target not found: Q9");
      assert.deepEqual(log.read(), []);
    });

    test("excluding an option records the exclusion and returns the option", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const excluded = run(log, { target: "Q1a", reason: "deferred" });

      // then
      assert.deepEqual(excluded, { kind: "option", option: { id: "Q1a", text: "a" } });
      assert.deepEqual(log.read(), [...events, { type: "exclude", target: "Q1a", reason: "deferred" }]);
    });

    test("excluding with a note records the note", () => {
      // given
      const events: Event[] = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      run(log, { target: "Q1", reason: "not-applicable", note: "why" });

      // then
      assert.deepEqual(log.read(), [
        ...events,
        { type: "exclude", target: "Q1", reason: "not-applicable", note: "why" },
      ]);
    });

    test("excluding a question returns it with its options that are not excluded", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "add-option", id: "Q1c", text: "c", origin: "Q1" },
        { type: "exclude", target: "Q1b", reason: "not-applicable" },
      ]);

      // when
      const excluded = run(log, { target: "Q1", reason: "not-applicable" });

      // then
      assert.deepEqual(excluded, {
        kind: "question",
        question: {
          id: "Q1",
          text: "q",
          options: [
            { id: "Q1a", text: "a" },
            { id: "Q1c", text: "c" },
          ],
        },
      });
    });

    test("excluding a follow-up returns the follow-up", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-follow-up", id: "F1", text: "f", origin: "Q1" },
      ]);

      // when
      const excluded = run(log, { target: "F1", reason: "deferred" });

      // then
      assert.deepEqual(excluded, { kind: "follow-up", followUp: { id: "F1", text: "f" } });
    });
  }

  return { options, run, tests };
})();

const Restore = (() => {
  const options = {
    target: { type: "string" },
  } as const;

  function run(log: Log, config: { target?: string }): ItemData {
    const target = config.target;
    if (!target) throw new DecisionTreeError("restore requires --target");

    const node = Graph.excludedNode(log, target);

    const restored = Graph.itemData(log, node);

    log.append({ type: "restore", target });

    return restored;
  }

  function tests() {
    test("restoring without a target throws and appends nothing", () => {
      // given
      const events: Event[] = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, {});

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "restore requires --target",
      );
      assert.deepEqual(log.read(), events);
    });

    test("restoring an option records the restore and returns the option", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "exclude", target: "Q1a", reason: "deferred" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const restored = run(log, { target: "Q1a" });

      // then
      assert.deepEqual(restored, { kind: "option", option: { id: "Q1a", text: "a" } });
      assert.deepEqual(log.read(), [...events, { type: "restore", target: "Q1a" }]);
    });
  }

  return { options, run, tests };
})();

const SupersedeQuestion = (() => {
  const options = {
    target: { type: "string" },
    text: { type: "string" },
    option: { type: "string", multiple: true },
  } as const;

  function run(log: Log, config: { target?: string; text?: string; option?: string[] }): SupersedeData {
    const { target, text } = config;
    if (!target) throw new DecisionTreeError("supersede-question requires --target");
    if (!text) throw new DecisionTreeError("supersede-question requires --text");

    const old = Graph.liveNode(log, target, "target");
    if (old.kind !== "question") throw new DecisionTreeError(`target is not a question: ${target}`);

    const superseded = Graph.buildTree(log, target);

    return Log.transaction(log, (staged) => {
      const question = AddQuestion.run(staged, { text, origin: old.parent?.id, option: config.option });

      staged.append({ type: "supersede-question", target, question: question.id });

      return { question, superseded };
    });
  }

  function tests() {
    test("superseding without a target throws and appends nothing", () => {
      // given
      const events: Event[] = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { text: "q2" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "supersede-question requires --target",
      );
      assert.deepEqual(log.read(), events);
    });

    test("superseding without a text throws and appends nothing", () => {
      // given
      const events: Event[] = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q1" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "supersede-question requires --text",
      );
      assert.deepEqual(log.read(), events);
    });

    test("superseding an option throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q1a", text: "q2" });

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "target is not a question: Q1a");
      assert.deepEqual(log.read(), events);
    });

    test("superseding a question adds one without options where the old one hung", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const supersede = run(log, { target: "Q2", text: "q3" });

      // then
      assert.deepEqual(supersede.question, { id: "Q3", text: "q3", options: [] });
      assert.deepEqual(log.read(), [
        ...events,
        { type: "add-question", id: "Q3", text: "q3", origin: "Q1a" },
        { type: "supersede-question", target: "Q2", question: "Q3" },
      ]);
    });

    test("superseding with options gives them to the new question before recording the supersede", () => {
      // given
      const events: Event[] = [{ type: "add-question", id: "Q1", text: "q1" }];
      const log = Log.memoryLog([...events]);

      // when
      const supersede = run(log, { target: "Q1", text: "q2", option: ["x", "y"] });

      // then
      assert.deepEqual(supersede.question, {
        id: "Q2",
        text: "q2",
        options: [
          { id: "Q2a", text: "x" },
          { id: "Q2b", text: "y" },
        ],
      });
      assert.deepEqual(log.read(), [
        ...events,
        { type: "add-question", id: "Q2", text: "q2" },
        { type: "add-option", id: "Q2a", text: "x", origin: "Q2" },
        { type: "add-option", id: "Q2b", text: "y", origin: "Q2" },
        { type: "supersede-question", target: "Q1", question: "Q2" },
      ]);
    });

    test("superseding a question returns the old subtree with every option and the selected one marked", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "add-option", id: "Q2a", text: "x", origin: "Q2" },
      ]);

      // when
      const supersede = run(log, { target: "Q1", text: "q3" });

      // then
      assert.deepEqual(supersede.superseded, [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q1",
          options: [
            {
              id: "Q1a",
              text: "a",
              selected: true,
              children: [
                {
                  kind: "question",
                  state: "open",
                  id: "Q2",
                  text: "q2",
                  options: [{ id: "Q2a", text: "x", children: [] }],
                  children: [],
                },
              ],
            },
            { id: "Q1b", text: "b", children: [] },
          ],
          children: [],
        },
      ]);
    });
  }

  return { options, run, tests };
})();

const SupersedeOption = (() => {
  const options = {
    target: { type: "string" },
    text: { type: "string" },
  } as const;

  function run(log: Log, config: { target?: string; text?: string }): SupersedeOptionData {
    const { target, text } = config;
    if (!target) throw new DecisionTreeError("supersede-option requires --target");
    if (!text) throw new DecisionTreeError("supersede-option requires --text");

    const old = Graph.liveNode(log, target, "target");
    if (old.kind !== "option") throw new DecisionTreeError(`target is not an option: ${target}`);

    const superseded = Graph.buildTree(log, old.question.id)
      .flatMap((entry) => (entry.kind === "question" ? entry.options : []))
      .find((option) => option.id === target);
    if (superseded === undefined) throw new Error(`tree of ${old.question.id} has no option ${target}`);

    return Log.transaction(log, (staged) => {
      const option = AddOption.run(staged, { text, origin: old.question.id });

      staged.append({ type: "supersede-option", target, option: option.id });

      return { option, superseded };
    });
  }

  function tests() {
    test("superseding an option without a target throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { text: "b" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "supersede-option requires --target",
      );
      assert.deepEqual(log.read(), events);
    });

    test("superseding an option without a text throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q1a" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "supersede-option requires --text",
      );
      assert.deepEqual(log.read(), events);
    });

    test("superseding a question as an option throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q1", text: "b" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "target is not an option: Q1",
      );
      assert.deepEqual(log.read(), events);
    });

    test("superseding an option adds one with the next letter before recording the supersede", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const supersede = run(log, { target: "Q1a", text: "c" });

      // then
      assert.deepEqual(supersede.option, { id: "Q1c", text: "c" });
      assert.deepEqual(log.read(), [
        ...events,
        { type: "add-option", id: "Q1c", text: "c", origin: "Q1" },
        { type: "supersede-option", target: "Q1a", option: "Q1c" },
      ]);
    });

    test("superseding an option returns it as it stood, selected and with what is under it", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "select-option", targets: ["Q1a"] },
      ]);

      // when
      const supersede = run(log, { target: "Q1a", text: "c" });

      // then
      assert.deepEqual(supersede.superseded, {
        id: "Q1a",
        text: "a",
        selected: true,
        children: [{ kind: "question", state: "open", id: "Q2", text: "q2", options: [], children: [] }],
      });
    });
  }

  return { options, run, tests };
})();

const Focus = (() => {
  const options = {
    target: { type: "string" },
  } as const;

  function run(log: Log, config: { target?: string }): ItemData {
    const target = config.target;
    if (!target) throw new DecisionTreeError("focus requires --target");

    const node = Graph.liveNode(log, target, "target");
    if (node.kind === "option") throw new DecisionTreeError(`target is not a question or follow-up: ${target}`);
    Graph.rejectOffPath(log, node);
    if (!Graph.hasOpen(log, node)) throw new DecisionTreeError(`nothing open under ${target}`);

    log.append({ type: "focus", target });

    return Graph.itemData(log, node);
  }

  function tests() {
    test("focusing without a target throws and appends nothing", () => {
      // given
      const events: Event[] = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, {});

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "focus requires --target",
      );
      assert.deepEqual(log.read(), events);
    });

    test("focusing an item with nothing open throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q1" });

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "nothing open under Q1");
      assert.deepEqual(log.read(), events);
    });

    test("focusing an off-path question throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1b" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q2" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "Q2 is off-path, hidden by Q1b",
      );
      assert.deepEqual(log.read(), events);
    });

    test("focusing a question under an open follow-up names that follow-up", () => {
      // given
      const events: Event[] = [
        { type: "add-follow-up", id: "F1", text: "f" },
        { type: "add-question", id: "Q1", text: "q", origin: "F1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q1" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "Q1 is off-path, hidden by F1",
      );
      assert.deepEqual(log.read(), events);
    });

    test("focusing an option throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q1a" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "target is not a question or follow-up: Q1a",
      );
      assert.deepEqual(log.read(), events);
    });

    test("focusing a question records the focus and returns the question", () => {
      // given
      const events: Event[] = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      const focused = run(log, { target: "Q1" });

      // then
      assert.deepEqual(focused, { kind: "question", question: { id: "Q1", text: "q", options: [] } });
      assert.deepEqual(log.read(), [...events, { type: "focus", target: "Q1" }]);
    });
  }

  return { options, run, tests };
})();

const Tag = (() => {
  const options = {
    target: { type: "string" },
    tag: { type: "string", multiple: true },
  } as const;

  function checked(log: Log, op: string, config: { target?: string; tag?: string[] }) {
    const { target, tag: tags } = config;
    if (!target) throw new DecisionTreeError(`${op} requires --target`);
    if (!tags) throw new DecisionTreeError(`${op} requires --tag`);
    if (tags.includes("")) throw new DecisionTreeError(`${op} --tag requires a text`);

    const node = Graph.liveNode(log, target, "target");
    if (node.kind === "option") throw new DecisionTreeError(`target is not a question or follow-up: ${target}`);

    return { target, tags };
  }

  function run(log: Log, config: { target?: string; tag?: string[] }): TaggedData {
    const { target, tags } = checked(log, "tag", config);

    log.append({ type: "tag", target, tags });

    return Graph.taggedItem(log, target);
  }

  function tests() {
    test("tagging without a tag throws and appends nothing", () => {
      // given
      const events: Event[] = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q1" });

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "tag requires --tag");
      assert.deepEqual(log.read(), events);
    });

    test("tagging an option throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q1a", tag: ["t"] });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "target is not a question or follow-up: Q1a",
      );
      assert.deepEqual(log.read(), events);
    });

    test("tagging records the tags in one event and returns the item with them", () => {
      // given
      const events: Event[] = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      const tagged = run(log, { target: "Q1", tag: ["a", "b"] });

      // then
      assert.deepEqual(tagged, {
        item: { kind: "question", question: { id: "Q1", text: "q", options: [] } },
        tags: ["a", "b"],
      });
      assert.deepEqual(log.read(), [...events, { type: "tag", target: "Q1", tags: ["a", "b"] }]);
    });
  }

  return { options, checked, run, tests };
})();

const Untag = (() => {
  const options = Tag.options;

  function run(log: Log, config: { target?: string; tag?: string[] }): TaggedData {
    const { target, tags } = Tag.checked(log, "untag", config);

    const missing = tags.find((tag) => !Graph.taggedItem(log, target).tags.includes(tag));
    if (missing !== undefined) throw new DecisionTreeError(`${target} has no tag: ${missing}`);

    log.append({ type: "untag", target, tags });

    return Graph.taggedItem(log, target);
  }

  function tests() {
    test("removing a tag the item does not have throws and appends nothing", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "tag", target: "Q1", tags: ["a"] },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q1", tag: ["b"] });

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "Q1 has no tag: b");
      assert.deepEqual(log.read(), events);
    });

    test("removing a tag records it and returns the item without it", () => {
      // given
      const events: Event[] = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "tag", target: "Q1", tags: ["a", "b"] },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const untagged = run(log, { target: "Q1", tag: ["a"] });

      // then
      assert.deepEqual(untagged, {
        item: { kind: "question", question: { id: "Q1", text: "q", options: [] } },
        tags: ["b"],
      });
      assert.deepEqual(log.read(), [...events, { type: "untag", target: "Q1", tags: ["a"] }]);
    });
  }

  return { options, run, tests };
})();

const Items = (() => {
  const options = {
    tag: { type: "string" },
    state: { type: "string", multiple: true },
    target: { type: "string" },
    trail: { type: "boolean" },
    limit: { type: "string" },
  } as const;

  const states: ItemState[] = ["open", "settled", "off-path", "deferred", "not-applicable", "frozen"];

  function chosenStates(given: string[] = ["open"]): ItemState[] {
    const unknown = given.find((state) => state !== "all" && !states.some((each) => each === state));
    if (unknown !== undefined) {
      throw new DecisionTreeError(`state must be ${states.join(", ")} or all: ${unknown}`);
    }

    return given.includes("all") ? states : states.filter((state) => given.includes(state));
  }

  function run(log: Log, config: { tag?: string; state?: string[]; target?: string; trail?: boolean; limit?: string }): ListedItem[] {
    if (config.tag === "") throw new DecisionTreeError("items --tag requires a text");
    if (config.trail && config.target === undefined) throw new DecisionTreeError("items --trail requires --target");
    if (config.limit !== undefined && !/^[1-9][0-9]*$/.test(config.limit)) {
      throw new DecisionTreeError(`items --limit must be a positive integer: ${config.limit}`);
    }

    const given = config.state ?? (config.target === undefined ? undefined : ["all"]);

    const found = Graph.listed(log, config.tag, chosenStates(given), config.target);
    const listed = config.limit === undefined ? found : found.slice(0, Number(config.limit));
    if (!config.trail || config.target === undefined) return listed;

    const steps = Graph.trail(log, config.target);

    return steps.length === 0 ? listed : listed.map((item) => ({ ...item, trail: steps }));
  }

  function tests() {
    test("a limit that is not a positive integer throws", () => {
      // given
      const log = Log.memoryLog();

      for (const limit of ["0", "2.5", "abc"]) {
        // when
        const act = () => run(log, { limit });

        // then
        assert.throws(
          act,
          (error) =>
            error instanceof DecisionTreeError && error.message === `items --limit must be a positive integer: ${limit}`,
        );
      }
    });

    test("a limit keeps the first items in walk order", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2" },
        { type: "add-question", id: "Q3", text: "q3" },
      ]);

      // when
      const items = run(log, { limit: "2" });

      // then
      assert.deepEqual(
        items.map((each) => (each.item.kind === "question" ? each.item.question.id : "")),
        ["Q1", "Q2"],
      );
    });

    test("a limit above the number of items returns them all", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2" },
      ]);

      // when
      const items = run(log, { limit: "5" });

      // then
      assert.equal(items.length, 2);
    });

    test("a limit applies after the state filter", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "settled" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "open" },
      ]);

      // when
      const items = run(log, { state: ["open"], limit: "1" });

      // then
      assert.deepEqual(
        items.map((each) => (each.item.kind === "question" ? each.item.question.id : "")),
        ["Q2"],
      );
    });

    test("a question carries its excluded options with their state and note", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "exclude", target: "Q1b", reason: "deferred", note: "why" },
      ]);

      // when
      const items = run(log, {});

      // then
      assert.deepEqual(items[0].hiddenOptions, [{ id: "Q1b", text: "b", state: "deferred", note: "why" }]);
    });

    test("a question carries its superseded option as frozen, linked to its replacement", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "add-option", id: "Q1c", text: "c", origin: "Q1" },
        { type: "supersede-option", target: "Q1a", option: "Q1c" },
      ]);

      // when
      const items = run(log, {});

      // then
      assert.deepEqual(items[0].hiddenOptions, [{ id: "Q1a", text: "a", state: "frozen", supersededBy: "Q1c" }]);
    });

    test("a trail without a target throws", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => run(log, { trail: true });

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "items --trail requires --target");
    });

    test("a nested target with a trail carries its path from the root", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
      ]);

      // when
      const items = run(log, { target: "Q2", trail: true });

      // then
      assert.deepEqual(items[0].trail, [
        { kind: "question", id: "Q1", text: "q1" },
        { kind: "option", id: "Q1a", text: "a" },
      ]);
    });

    test("a target with a trail is still limited by the states asked for", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
      ]);

      // when
      const items = run(log, { target: "Q2", trail: true, state: ["settled"] });

      // then
      assert.deepEqual(items, []);
    });

    test("an off-path target with a trail shows the unchosen option in its path", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1b" },
      ]);

      // when
      const items = run(log, { target: "Q2", trail: true });

      // then
      assert.deepEqual(items[0].trail, [
        { kind: "question", id: "Q1", text: "q1" },
        { kind: "option", id: "Q1b", text: "b" },
      ]);
    });

    test("a root target with a trail has no trail field", () => {
      // given
      const log = Log.memoryLog([{ type: "add-question", id: "Q1", text: "q" }]);

      // when
      const items = run(log, { target: "Q1", trail: true });

      // then
      assert.equal("trail" in items[0], false);
    });

    test("a nested target without the flag has no trail field", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
      ]);

      // when
      const items = run(log, { target: "Q2" });

      // then
      assert.equal("trail" in items[0], false);
    });

    test("querying with state all returns items in every state", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "open" },
        { type: "add-question", id: "Q2", text: "settled" },
        { type: "add-option", id: "Q2a", text: "a", origin: "Q2" },
        { type: "select-option", targets: ["Q2a"] },
        { type: "tag", target: "Q1", tags: ["t"] },
        { type: "tag", target: "Q2", tags: ["t"] },
      ]);

      // when
      const items = run(log, { tag: "t", state: ["all"] });

      // then
      assert.deepEqual(
        items.map((each) => each.state),
        ["open", "settled"],
      );
    });

    test("querying with an empty tag throws", () => {
      // given
      const log = Log.memoryLog([{ type: "add-question", id: "Q1", text: "q" }]);

      // when
      const act = () => run(log, { tag: "" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "items --tag requires a text",
      );
    });

    test("querying an unknown target throws", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => run(log, { target: "Q9" });

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "target not found: Q9");
    });

    test("querying an option as target throws", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ]);

      // when
      const act = () => run(log, { target: "Q1a" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "target is not a question or follow-up: Q1a",
      );
    });

    test("querying a target finds it in any state", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-question", id: "Q2", text: "other" },
        { type: "exclude", target: "Q1", reason: "deferred" },
      ]);

      // when
      const items = run(log, { target: "Q1" });

      // then
      assert.deepEqual(
        items.map((each) => each.state),
        ["deferred"],
      );
    });

    test("an explicit state still filters a target", () => {
      // given
      const log = Log.memoryLog([{ type: "add-question", id: "Q1", text: "q" }]);

      // when
      const items = run(log, { target: "Q1", state: ["deferred"] });

      // then
      assert.deepEqual(items, []);
    });

    test("querying with an unknown state throws", () => {
      // given
      const log = Log.memoryLog([{ type: "add-question", id: "Q1", text: "q" }]);

      // when
      const act = () => run(log, { tag: "t", state: ["hidden"] });

      // then
      assert.throws(
        act,
        (error) =>
          error instanceof DecisionTreeError &&
          error.message === "state must be open, settled, off-path, deferred, not-applicable, frozen or all: hidden",
      );
    });

    test("querying without a tag returns tagged and untagged items", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "tagged" },
        { type: "add-question", id: "Q2", text: "untagged" },
        { type: "tag", target: "Q1", tags: ["t"] },
      ]);

      // when
      const items = run(log, {});

      // then
      assert.deepEqual(
        items.map((each) => (each.item.kind === "question" ? each.item.question.id : "")),
        ["Q1", "Q2"],
      );
    });
  }

  return { options, run, chosenStates, tests };
})();

const Next = (() => {
  const options = {
    trail: { type: "boolean" },
  } as const;

  function run(log: Log, config: { trail?: boolean } = {}): NextData | undefined {
    const node = Graph.frontier(log)[0];
    if (node === undefined) return undefined;

    const steps = config.trail ? Graph.trail(log, node.id) : [];
    const trail = steps.length === 0 ? {} : { trail: steps };

    if (node.kind === "follow-up") {
      return { kind: "follow-up", followUp: { id: node.id, text: node.text }, ...trail };
    }

    return { kind: "question", question: { id: node.id, text: node.text, options: node.options }, ...trail };
  }

  function tests() {
    test("next carries a trail only when asked", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
      ]);

      // when
      const without = run(log);
      const withTrail = run(log, { trail: true });

      // then
      assert.equal(without?.trail, undefined);
      assert.deepEqual(withTrail?.trail, [
        { kind: "question", id: "Q1", text: "q1" },
        { kind: "option", id: "Q1a", text: "a" },
      ]);
    });

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

    test("next is a follow-up when one comes first", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1a" },
      ]);

      // when
      const item = run(log);

      // then
      assert.deepEqual(item, { kind: "follow-up", followUp: { id: "F1", text: "f1" } });
    });
  }

  return { options, run, tests };
})();

const Tree = (() => {
  const options = {
    state: { type: "string", multiple: true },
    target: { type: "string" },
  } as const;

  function run(log: Log, config: { state?: string[]; target?: string }): TreeEntry[] {
    const states = Items.chosenStates(config.state);

    return Graph.filterTree(Graph.buildTree(log, config.target), states);
  }

  function tests() {
    test("an unknown state throws", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => run(log, { state: ["nope"] });

      // then
      assert.throws(
        act,
        (error) =>
          error instanceof DecisionTreeError &&
          error.message === "state must be open, settled, off-path, deferred, not-applicable, frozen or all: nope",
      );
    });

    test("an unknown target throws", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => run(log, { target: "Q9" });

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "target not found: Q9");
    });

    test("an option as the target throws", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ]);

      // when
      const act = () => run(log, { target: "Q1a" });

      // then
      assert.throws(
        act,
        (error) =>
          error instanceof DecisionTreeError && error.message === "target is not a question or follow-up: Q1a",
      );
    });

    test("with no state the tree shows only open items", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "settled" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "open" },
      ]);

      // when
      const entries = run(log, {});

      // then
      assert.deepEqual(
        entries.map((entry) => entry.id),
        ["Q2"],
      );
    });

    test("a target limits the tree to its subtree and stays as the ancestor", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "add-option", id: "Q2a", text: "b", origin: "Q2" },
        { type: "select-option", targets: ["Q2a"] },
        { type: "add-question", id: "Q3", text: "q3", origin: "Q2a" },
        { type: "add-question", id: "Q4", text: "elsewhere" },
      ]);

      // when
      const entries = run(log, { target: "Q2" });

      // then
      assert.deepEqual(entries, [
        {
          kind: "question",
          state: "settled",
          id: "Q2",
          text: "q2",
          options: [
            {
              id: "Q2a",
              text: "b",
              selected: true,
              children: [{ kind: "question", state: "open", id: "Q3", text: "q3", options: [], children: [] }],
            },
          ],
          children: [],
        },
      ]);
    });

    test("a target with nothing open inside has no items by default", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
      ]);

      // when
      const entries = run(log, { target: "Q1" });

      // then
      assert.deepEqual(entries, []);
    });

    test("an off-path target appears when its state is asked for", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1b" },
      ]);

      // when
      const entries = run(log, { target: "Q2", state: ["off-path"] });

      // then
      assert.deepEqual(
        entries.map((entry) => [entry.id, entry.state]),
        [["Q2", "off-path"]],
      );
    });

    test("state all shows every state, frozen included", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "old" },
        { type: "add-question", id: "Q2", text: "new" },
        { type: "supersede-question", target: "Q1", question: "Q2" },
        { type: "add-question", id: "Q3", text: "later" },
        { type: "exclude", target: "Q3", reason: "deferred" },
        { type: "add-question", id: "Q4", text: "dropped" },
        { type: "exclude", target: "Q4", reason: "not-applicable" },
      ]);

      // when
      const entries = run(log, { state: ["all"] });

      // then
      assert.deepEqual(
        entries.map((entry) => [entry.id, entry.state]),
        [
          ["Q2", "open"],
          ["Q1", "frozen"],
          ["Q3", "deferred"],
          ["Q4", "not-applicable"],
        ],
      );
    });
  }

  return { options, run, tests };
})();

const Status = (() => {
  const options = {
    target: { type: "string" },
  } as const;

  function run(log: Log, config: { target?: string } = {}): StatusItem[] {
    return Graph.status(log, config.target);
  }

  function tests() {
    test("status of an empty log has no items", () => {
      // given
      const log = Log.memoryLog();

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, []);
    });

    test("an unknown target throws", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => run(log, { target: "Q9" });

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "target not found: Q9");
    });

    test("an option as the target throws", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
      ]);

      // when
      const act = () => run(log, { target: "Q1a" });

      // then
      assert.throws(
        act,
        (error) =>
          error instanceof DecisionTreeError && error.message === "target is not a question or follow-up: Q1a",
      );
    });

    test("an off-path target has no items", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1b" },
      ]);

      // when
      const items = run(log, { target: "Q2" });

      // then
      assert.deepEqual(items, []);
    });

    test("a child of a deferred question as the target has no items", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
        { type: "exclude", target: "Q1", reason: "deferred" },
      ]);

      // when
      const items = run(log, { target: "Q2" });

      // then
      assert.deepEqual(items, []);
    });

    test("a frozen target has no items", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "old" },
        { type: "add-question", id: "Q2", text: "new" },
        { type: "supersede-question", target: "Q1", question: "Q2" },
      ]);

      // when
      const items = run(log, { target: "Q1" });

      // then
      assert.deepEqual(items, []);
    });

    test("a nested target renders only itself and what is under it", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "add-option", id: "Q2a", text: "b", origin: "Q2" },
        { type: "select-option", targets: ["Q2a"] },
        { type: "add-question", id: "Q3", text: "q3", origin: "Q2a" },
      ]);

      // when
      const items = run(log, { target: "Q2" });

      // then
      assert.deepEqual(items, [
        {
          kind: "question",
          state: "settled",
          id: "Q2",
          text: "q2",
          decided: [
            {
              id: "Q2a",
              text: "b",
              children: [{ kind: "question", state: "open", id: "Q3", text: "q3", options: [], children: [] }],
            },
          ],
          children: [],
        },
      ]);
    });

    test("a target deferred directly appears with its note", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "exclude", target: "Q1", reason: "deferred", note: "why" },
      ]);

      // when
      const items = run(log, { target: "Q1" });

      // then
      assert.deepEqual(items, [{ kind: "question", state: "deferred", id: "Q1", text: "q", note: "why" }]);
    });

    test("a promoted follow-up as the target renders what came from it", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-follow-up", id: "F1", text: "f" },
        { type: "add-question", id: "Q1", text: "q", origin: "F1" },
        { type: "promote-follow-up", target: "F1" },
      ]);

      // when
      const items = run(log, { target: "F1" });

      // then
      assert.deepEqual(items, [{ kind: "question", state: "open", id: "Q1", text: "q", options: [], children: [] }]);
    });

    test("an open question has state open and its live options", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "exclude", target: "Q1b", reason: "not-applicable" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, [
        { kind: "question", state: "open", id: "Q1", text: "q", options: [{ id: "Q1a", text: "a" }], children: [] },
      ]);
    });

    test("a not-applicable question is left out", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "dropped" },
        { type: "exclude", target: "Q1", reason: "not-applicable" },
        { type: "add-question", id: "Q2", text: "live" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(
        items.map((item) => item.id),
        ["Q2"],
      );
    });

    test("a settled question has state settled and only its selected options as decided", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1b"] },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q",
          decided: [{ id: "Q1b", text: "b", children: [] }],
          children: [],
        },
      ]);
    });

    test("a settled question carries the rationale of its selection", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"], rationale: "why" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q",
          decided: [{ id: "Q1a", text: "a", children: [] }],
          children: [],
          rationale: "why",
        },
      ]);
    });

    test("a later selection without a rationale drops the rationale of the earlier one", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"], rationale: "why" },
        { type: "select-option", targets: ["Q1b"] },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q",
          decided: [{ id: "Q1b", text: "b", children: [] }],
          children: [],
        },
      ]);
    });

    test("a child hung under the selected option sits inside that decided option", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q1",
          decided: [
            {
              id: "Q1a",
              text: "a",
              children: [{ kind: "question", state: "open", id: "Q2", text: "q2", options: [], children: [] }],
            },
          ],
          children: [],
        },
      ]);
    });

    test("a question under an unchosen option is left out", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "chosen", origin: "Q1a" },
        { type: "add-question", id: "Q3", text: "unchosen", origin: "Q1b" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(
        items.flatMap((item) => (item.state === "settled" ? item.decided.flatMap((option) => option.children) : [])).map(
          (child) => child.id,
        ),
        ["Q2"],
      );
    });

    test("a child hung under a settled question sits outside the decided option", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q1",
          decided: [{ id: "Q1a", text: "a", children: [] }],
          children: [{ kind: "question", state: "open", id: "Q2", text: "q2", options: [], children: [] }],
        },
      ]);
    });

    test("a child hung under an open question sits in its children", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, [
        {
          kind: "question",
          state: "open",
          id: "Q1",
          text: "q1",
          options: [],
          children: [{ kind: "question", state: "open", id: "Q2", text: "q2", options: [], children: [] }],
        },
      ]);
    });

    test("a deferred question has state deferred and its note, with no options", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "exclude", target: "Q1", reason: "deferred", note: "why" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, [{ kind: "question", state: "deferred", id: "Q1", text: "q", note: "why" }]);
    });

    test("a child of a deferred question is left out", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
        { type: "exclude", target: "Q1", reason: "deferred" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, [{ kind: "question", state: "deferred", id: "Q1", text: "q1" }]);
    });

    test("an open follow-up has state open and no body", () => {
      // given
      const log = Log.memoryLog([{ type: "add-follow-up", id: "F1", text: "f" }]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, [{ kind: "follow-up", state: "open", id: "F1", text: "f" }]);
    });

    test("follow-ups sit where they hang, after the questions at their level", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-follow-up", id: "F1", text: "answer follow-up", origin: "Q1a" },
        { type: "add-question", id: "Q2", text: "answer child", origin: "Q1a" },
        { type: "add-follow-up", id: "F2", text: "question follow-up", origin: "Q1" },
        { type: "add-question", id: "Q3", text: "question child", origin: "Q1" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q1",
          decided: [
            {
              id: "Q1a",
              text: "a",
              children: [
                { kind: "question", state: "open", id: "Q2", text: "answer child", options: [], children: [] },
                { kind: "follow-up", state: "open", id: "F1", text: "answer follow-up" },
              ],
            },
          ],
          children: [
            { kind: "question", state: "open", id: "Q3", text: "question child", options: [], children: [] },
            { kind: "follow-up", state: "open", id: "F2", text: "question follow-up" },
          ],
        },
      ]);
    });

    test("a promoted follow-up is invisible and its question takes its place", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-follow-up", id: "F1", text: "f" },
        { type: "add-question", id: "Q1", text: "q", origin: "F1" },
        { type: "promote-follow-up", target: "F1" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, [{ kind: "question", state: "open", id: "Q1", text: "q", options: [], children: [] }]);
    });

    test("a deferred follow-up has state deferred and its note", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-follow-up", id: "F1", text: "f" },
        { type: "exclude", target: "F1", reason: "deferred", note: "why" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, [{ kind: "follow-up", state: "deferred", id: "F1", text: "f", note: "why" }]);
    });

    test("a not-applicable follow-up is left out", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-follow-up", id: "F1", text: "dropped" },
        { type: "exclude", target: "F1", reason: "not-applicable" },
        { type: "add-follow-up", id: "F2", text: "live" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(
        items.map((item) => item.id),
        ["F2"],
      );
    });

    test("a deferred option sits under its question, after its live children", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "exclude", target: "Q1b", reason: "deferred", note: "why" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q1",
          decided: [{ id: "Q1a", text: "a", children: [] }],
          children: [
            { kind: "question", state: "open", id: "Q2", text: "q2", options: [], children: [] },
            { kind: "option", state: "deferred", id: "Q1b", text: "b", note: "why" },
          ],
        },
      ]);
    });

    test("a superseded question is left out and its replacement appears", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "old" },
        { type: "add-question", id: "Q2", text: "new" },
        { type: "supersede-question", target: "Q1", question: "Q2" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(
        items.map((item) => item.id),
        ["Q2"],
      );
    });

    test("a deferred question under the selected option sits in place inside it", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", targets: ["Q1a"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "exclude", target: "Q2", reason: "deferred", note: "why" },
      ]);

      // when
      const items = run(log);

      // then
      assert.deepEqual(items, [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q1",
          decided: [
            {
              id: "Q1a",
              text: "a",
              children: [{ kind: "question", state: "deferred", id: "Q2", text: "q2", note: "why" }],
            },
          ],
          children: [],
        },
      ]);
    });

    test("two selected options each hold their own child", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", targets: ["Q1a", "Q1b"] },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "add-question", id: "Q3", text: "q3", origin: "Q1b" },
      ]);

      // when
      const items = run(log);

      // then
      const question = { kind: "question", state: "open", options: [], children: [] };
      assert.deepEqual(items, [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q1",
          decided: [
            { id: "Q1a", text: "a", children: [{ ...question, id: "Q2", text: "q2" }] },
            { id: "Q1b", text: "b", children: [{ ...question, id: "Q3", text: "q3" }] },
          ],
          children: [],
        },
      ]);
    });
  }

  return { options, run, tests };
})();

const Xml = (() => {
  function escapeXml(text: string): string {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  function markedOption(data: OptionData, selected: boolean): string {
    return selected ? option(data).replace("<option>", '<option selected="true">') : option(data);
  }

  function hiddenOption(data: HiddenOption): string {
    const note = data.note === undefined ? "" : `<note>${escapeXml(data.note)}</note>`;

    return `<option state="${data.state}"><id>${data.id}</id><text>${escapeXml(data.text)}</text>${note}</option>`;
  }

  function trailLines(steps: TrailStep[] | undefined): string[] {
    if (steps === undefined) return [];

    return [
      "  <trail>",
      ...steps.map((step) => `    <${step.kind}><id>${step.id}</id><text>${escapeXml(step.text)}</text></${step.kind}>`),
      "  </trail>",
    ];
  }

  function option(data: OptionData): string {
    return `<option><id>${data.id}</id><text>${escapeXml(data.text)}</text></option>`;
  }

  function optionsLines(options: OptionData[]): string[] {
    if (options.length === 0) return ["  <options></options>"];

    return ["  <options>", ...options.map((each) => `    ${option(each)}`), "  </options>"];
  }

  function question(data: QuestionData): string {
    return [
      "<question>",
      `  <id>${data.id}</id>`,
      `  <text>${escapeXml(data.text)}</text>`,
      ...optionsLines(data.options),
      "</question>",
    ].join("\n");
  }

  function selection(data: SelectionData): string {
    return [
      "<selection>",
      `  <question><id>${data.question.id}</id><text>${escapeXml(data.question.text)}</text></question>`,
      ...data.options.map((each) => `  ${option(each)}`),
      "</selection>",
    ].join("\n");
  }

  function followUp(data: FollowUpData): string {
    return `<follow-up><id>${data.id}</id><text>${escapeXml(data.text)}</text></follow-up>`;
  }

  function item(data: ItemData): string {
    switch (data.kind) {
      case "question":
        return question(data.question);
      case "option":
        return option(data.option);
      case "follow-up":
        return followUp(data.followUp);
    }
  }

  function next(data: NextData | undefined): string {
    if (data === undefined) return "<next></next>";

    const trail = trailLines(data.trail);
    const body =
      data.kind === "follow-up"
        ? [`  ${followUp(data.followUp)}`]
        : question(data.question)
            .split("\n")
            .map((line) => `  ${line}`);

    return ["<next>", ...trail, ...body, "</next>"].join("\n");
  }

  function decidedLines(data: OptionData & { children: StatusItem[] }): string[] {
    if (data.children.length === 0) return [option(data)];

    return [
      "<option>",
      `  <id>${data.id}</id>`,
      `  <text>${escapeXml(data.text)}</text>`,
      ...data.children.flatMap(statusLines).map((line) => `  ${line}`),
      "</option>",
    ];
  }

  function statusLines(item: StatusItem): string[] {
    if (item.state === "deferred") {
      const note = item.note === undefined ? [] : [`  <note>${escapeXml(item.note)}</note>`];

      return [
        `<${item.kind} state="deferred">`,
        `  <id>${item.id}</id>`,
        `  <text>${escapeXml(item.text)}</text>`,
        ...note,
        `</${item.kind}>`,
      ];
    }

    if (item.kind === "follow-up") {
      return ['<follow-up state="open">', `  <id>${item.id}</id>`, `  <text>${escapeXml(item.text)}</text>`, "</follow-up>"];
    }

    const children = item.children.flatMap(statusLines).map((line) => `  ${line}`);

    if (item.state === "settled") {
      return [
        '<question state="settled">',
        `  <id>${item.id}</id>`,
        `  <text>${escapeXml(item.text)}</text>`,
        "  <decided>",
        ...item.decided.flatMap(decidedLines).map((line) => `    ${line}`),
        ...(item.rationale === undefined ? [] : [`    <rationale>${escapeXml(item.rationale)}</rationale>`]),
        "  </decided>",
        ...children,
        "</question>",
      ];
    }

    return [
      '<question state="open">',
      `  <id>${item.id}</id>`,
      `  <text>${escapeXml(item.text)}</text>`,
      ...optionsLines(item.options),
      ...children,
      "</question>",
    ];
  }

  function status(items: StatusItem[]): string {
    if (items.length === 0) return "<status></status>";

    return ["<status>", ...items.flatMap(statusLines).map((line) => `  ${line}`), "</status>"].join("\n");
  }

  function noteLines(note: string | undefined): string[] {
    return note === undefined ? [] : [`  <note>${escapeXml(note)}</note>`];
  }

  function linkTags(links: { supersedes?: string; supersededBy?: string }): string[] {
    return [
      ...(links.supersedes === undefined ? [] : [`<supersedes><id>${links.supersedes}</id></supersedes>`]),
      ...(links.supersededBy === undefined ? [] : [`<superseded-by><id>${links.supersededBy}</id></superseded-by>`]),
    ];
  }

  function treeOptionLines(entry: TreeEntryOption): string[] {
    const { id, text, state, note } = entry;

    if (entry.children.length === 0) {
      const line =
        state === undefined ? markedOption(entry, entry.selected === true) : hiddenOption({ id, text, state, note });

      return [line.replace("</option>", `${linkTags(entry).join("")}</option>`)];
    }

    const marker = state !== undefined ? ` state="${state}"` : entry.selected === true ? ' selected="true"' : "";

    return [
      `<option${marker}>`,
      `  <id>${entry.id}</id>`,
      `  <text>${escapeXml(entry.text)}</text>`,
      ...noteLines(note),
      ...linkTags(entry).map((line) => `  ${line}`),
      ...entry.children.flatMap(treeLines).map((line) => `  ${line}`),
      "</option>",
    ];
  }

  function treeLines(entry: TreeEntry): string[] {
    if (entry.kind === "follow-up") {
      return [
        `<follow-up state="${entry.state}">`,
        `  <id>${entry.id}</id>`,
        `  <text>${escapeXml(entry.text)}</text>`,
        ...noteLines(entry.note),
        ...entry.children.flatMap(treeLines).map((line) => `  ${line}`),
        "</follow-up>",
      ];
    }

    const options = entry.options.flatMap(treeOptionLines).map((line) => `    ${line}`);
    const optionsBlock = options.length === 0 ? optionsLines([]) : ["  <options>", ...options, "  </options>"];

    return [
      `<question state="${entry.state}">`,
      `  <id>${entry.id}</id>`,
      `  <text>${escapeXml(entry.text)}</text>`,
      ...noteLines(entry.note),
      ...optionsBlock,
      ...(entry.rationale === undefined ? [] : [`  <rationale>${escapeXml(entry.rationale)}</rationale>`]),
      ...entry.children.flatMap(treeLines).map((line) => `  ${line}`),
      "</question>",
    ];
  }

  function tree(entries: TreeEntry[]): string {
    if (entries.length === 0) return "<tree></tree>";

    return ["<tree>", ...entries.flatMap(treeLines).map((line) => `  ${line}`), "</tree>"].join("\n");
  }

  function promote(data: PromoteData): string {
    const replacement = question(data.question)
      .split("\n")
      .map((line) => `  ${line}`);

    return ["<promote>", ...replacement, "  <promoted>", `    ${followUp(data.promoted)}`, "  </promoted>", "</promote>"].join(
      "\n",
    );
  }

  function supersede(data: SupersedeData): string {
    const replacement = question(data.question)
      .split("\n")
      .map((line) => `  ${line}`);
    const superseded = data.superseded.flatMap(treeLines).map((line) => `    ${line}`);

    return ["<supersede>", ...replacement, "  <superseded>", ...superseded, "  </superseded>", "</supersede>"].join(
      "\n",
    );
  }

  function supersedeOption(data: SupersedeOptionData): string {
    const superseded = treeOptionLines(data.superseded).map((line) => `    ${line}`);

    return [
      "<supersede>",
      `  ${option(data.option)}`,
      "  <superseded>",
      ...superseded,
      "  </superseded>",
      "</supersede>",
    ].join("\n");
  }

  function tests() {
    test("items renders a trail after the tags, escaped and in order", () => {
      // given
      const list: ListedItem[] = [
        {
          item: { kind: "question", question: { id: "Q2", text: "q2", options: [] } },
          tags: [],
          state: "off-path",
          trail: [
            { kind: "question", id: "Q1", text: "a < b" },
            { kind: "option", id: "Q1a", text: "a" },
          ],
        },
      ];

      // when
      const xml = items(list);

      // then
      assert.equal(
        xml,
        [
          "<items>",
          '  <question state="off-path">',
          "    <id>Q2</id>",
          "    <text>q2</text>",
          "    <options></options>",
          "    <tags></tags>",
          "    <trail>",
          "      <question><id>Q1</id><text>a &lt; b</text></question>",
          "      <option><id>Q1a</id><text>a</text></option>",
          "    </trail>",
          "  </question>",
          "</items>",
        ].join("\n"),
      );
    });

    test("items renders a follow-up's trail after its tags", () => {
      // given
      const list: ListedItem[] = [
        {
          item: { kind: "follow-up", followUp: { id: "F1", text: "f" } },
          tags: [],
          state: "open",
          trail: [{ kind: "question", id: "Q1", text: "q" }],
        },
      ];

      // when
      const xml = items(list);

      // then
      assert.equal(
        xml,
        [
          "<items>",
          '  <follow-up state="open">',
          "    <id>F1</id>",
          "    <text>f</text>",
          "    <tags></tags>",
          "    <trail>",
          "      <question><id>Q1</id><text>q</text></question>",
          "    </trail>",
          "  </follow-up>",
          "</items>",
        ].join("\n"),
      );
    });

    test("items renders excluded options after the live ones, with state and escaped note", () => {
      // given
      const list: ListedItem[] = [
        {
          item: { kind: "question", question: { id: "Q1", text: "q", options: [{ id: "Q1a", text: "a" }] } },
          tags: [],
          state: "open",
          hiddenOptions: [{ id: "Q1b", text: "b", state: "deferred", note: "a < b" }],
        },
      ];

      // when
      const xml = items(list);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<items>",
        '  <question state="open">',
        "    <id>Q1</id>",
        "    <text>q</text>",
        "    <options>",
        "      <option><id>Q1a</id><text>a</text></option>",
        '      <option state="deferred"><id>Q1b</id><text>b</text><note>a &lt; b</note></option>',
        "    </options>",
        "    <tags></tags>",
        "  </question>",
        "</items>",
      ]);
    });

    test("the built tree renders no entries as an empty element", () => {
      // given
      const entries: TreeEntry[] = [];

      // when
      const xml = tree(entries);

      // then
      assert.equal(xml, "<tree></tree>");
    });

    test("the built tree renders an open question with its state and options", () => {
      // given
      const entries: TreeEntry[] = [
        {
          kind: "question",
          state: "open",
          id: "Q1",
          text: "q",
          options: [
            { id: "Q1a", text: "a", children: [] },
            { id: "Q1b", text: "b", selected: true, children: [] },
          ],
          children: [],
        },
      ];

      // when
      const xml = tree(entries);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<tree>",
        '  <question state="open">',
        "    <id>Q1</id>",
        "    <text>q</text>",
        "    <options>",
        "      <option><id>Q1a</id><text>a</text></option>",
        '      <option selected="true"><id>Q1b</id><text>b</text></option>',
        "    </options>",
        "  </question>",
        "</tree>",
      ]);
    });

    test("the built tree nests an option's child inside it and the question's own after the options", () => {
      // given
      const child = (id: string): TreeEntry => ({
        kind: "question",
        state: "open",
        id,
        text: id,
        options: [],
        children: [],
      });
      const entries: TreeEntry[] = [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q",
          options: [{ id: "Q1a", text: "a", selected: true, children: [child("Q2")] }],
          children: [child("Q3")],
        },
      ];

      // when
      const xml = tree(entries);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<tree>",
        '  <question state="settled">',
        "    <id>Q1</id>",
        "    <text>q</text>",
        "    <options>",
        '      <option selected="true">',
        "        <id>Q1a</id>",
        "        <text>a</text>",
        '        <question state="open">',
        "          <id>Q2</id>",
        "          <text>Q2</text>",
        "          <options></options>",
        "        </question>",
        "      </option>",
        "    </options>",
        '    <question state="open">',
        "      <id>Q3</id>",
        "      <text>Q3</text>",
        "      <options></options>",
        "    </question>",
        "  </question>",
        "</tree>",
      ]);
    });

    test("the built tree marks excluded options with their state and note", () => {
      // given
      const child: TreeEntry = { kind: "question", state: "deferred", id: "Q2", text: "q2", options: [], children: [] };
      const entries: TreeEntry[] = [
        {
          kind: "question",
          state: "open",
          id: "Q1",
          text: "q",
          options: [
            { id: "Q1a", text: "a", state: "deferred", note: "why", children: [child] },
            { id: "Q1b", text: "b", state: "not-applicable", children: [] },
          ],
          children: [],
        },
      ];

      // when
      const xml = tree(entries);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<tree>",
        '  <question state="open">',
        "    <id>Q1</id>",
        "    <text>q</text>",
        "    <options>",
        '      <option state="deferred">',
        "        <id>Q1a</id>",
        "        <text>a</text>",
        "        <note>why</note>",
        '        <question state="deferred">',
        "          <id>Q2</id>",
        "          <text>q2</text>",
        "          <options></options>",
        "        </question>",
        "      </option>",
        '      <option state="not-applicable"><id>Q1b</id><text>b</text></option>',
        "    </options>",
        "  </question>",
        "</tree>",
      ]);
    });

    test("the built tree renders the links between a superseded option and its replacement", () => {
      // given
      const child: TreeEntry = { kind: "question", state: "frozen", id: "Q2", text: "q2", options: [], children: [] };
      const entries: TreeEntry[] = [
        {
          kind: "question",
          state: "open",
          id: "Q1",
          text: "q",
          options: [
            { id: "Q1c", text: "c", supersedes: "Q1a", children: [] },
            { id: "Q1a", text: "a", state: "frozen", supersededBy: "Q1c", children: [child] },
          ],
          children: [],
        },
      ];

      // when
      const xml = tree(entries);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<tree>",
        '  <question state="open">',
        "    <id>Q1</id>",
        "    <text>q</text>",
        "    <options>",
        "      <option><id>Q1c</id><text>c</text><supersedes><id>Q1a</id></supersedes></option>",
        '      <option state="frozen">',
        "        <id>Q1a</id>",
        "        <text>a</text>",
        "        <superseded-by><id>Q1c</id></superseded-by>",
        '        <question state="frozen">',
        "          <id>Q2</id>",
        "          <text>q2</text>",
        "          <options></options>",
        "        </question>",
        "      </option>",
        "    </options>",
        "  </question>",
        "</tree>",
      ]);
    });

    test("the built tree renders the link on a superseded option with nothing under it", () => {
      // given
      const entries: TreeEntry[] = [
        {
          kind: "question",
          state: "open",
          id: "Q1",
          text: "q",
          options: [
            { id: "Q1b", text: "b", supersedes: "Q1a", children: [] },
            { id: "Q1a", text: "a", state: "frozen", supersededBy: "Q1b", children: [] },
          ],
          children: [],
        },
      ];

      // when
      const xml = tree(entries);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<tree>",
        '  <question state="open">',
        "    <id>Q1</id>",
        "    <text>q</text>",
        "    <options>",
        "      <option><id>Q1b</id><text>b</text><supersedes><id>Q1a</id></supersedes></option>",
        '      <option state="frozen"><id>Q1a</id><text>a</text><superseded-by><id>Q1b</id></superseded-by></option>',
        "    </options>",
        "  </question>",
        "</tree>",
      ]);
    });

    test("the built tree renders follow-ups with their state and what they hold", () => {
      // given
      const entries: TreeEntry[] = [
        { kind: "follow-up", state: "open", id: "F1", text: "open", children: [] },
        {
          kind: "follow-up",
          state: "settled",
          id: "F2",
          text: "promoted",
          children: [{ kind: "question", state: "open", id: "Q1", text: "q", options: [], children: [] }],
        },
      ];

      // when
      const xml = tree(entries);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<tree>",
        '  <follow-up state="open">',
        "    <id>F1</id>",
        "    <text>open</text>",
        "  </follow-up>",
        '  <follow-up state="settled">',
        "    <id>F2</id>",
        "    <text>promoted</text>",
        '    <question state="open">',
        "      <id>Q1</id>",
        "      <text>q</text>",
        "      <options></options>",
        "    </question>",
        "  </follow-up>",
        "</tree>",
      ]);
    });

    test("the built tree renders a note right after the text, only when there is one", () => {
      // given
      const entries: TreeEntry[] = [
        { kind: "question", state: "deferred", id: "Q1", text: "q", note: "why", options: [], children: [] },
        { kind: "follow-up", state: "deferred", id: "F1", text: "f", note: "later", children: [] },
        { kind: "follow-up", state: "deferred", id: "F2", text: "g", children: [] },
      ];

      // when
      const xml = tree(entries);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<tree>",
        '  <question state="deferred">',
        "    <id>Q1</id>",
        "    <text>q</text>",
        "    <note>why</note>",
        "    <options></options>",
        "  </question>",
        '  <follow-up state="deferred">',
        "    <id>F1</id>",
        "    <text>f</text>",
        "    <note>later</note>",
        "  </follow-up>",
        '  <follow-up state="deferred">',
        "    <id>F2</id>",
        "    <text>g</text>",
        "  </follow-up>",
        "</tree>",
      ]);
    });

    test("the built tree renders a rationale right after the options, before the question's children", () => {
      // given
      const entries: TreeEntry[] = [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q",
          options: [{ id: "Q1a", text: "a", selected: true, children: [] }],
          rationale: "a < b",
          children: [{ kind: "question", state: "open", id: "Q2", text: "q2", options: [], children: [] }],
        },
      ];

      // when
      const xml = tree(entries);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<tree>",
        '  <question state="settled">',
        "    <id>Q1</id>",
        "    <text>q</text>",
        "    <options>",
        '      <option selected="true"><id>Q1a</id><text>a</text></option>',
        "    </options>",
        "    <rationale>a &lt; b</rationale>",
        '    <question state="open">',
        "      <id>Q2</id>",
        "      <text>q2</text>",
        "      <options></options>",
        "    </question>",
        "  </question>",
        "</tree>",
      ]);
    });

    test("the built tree escapes every text it renders", () => {
      // given
      const text = "<&>";
      const followUp: TreeEntry = { kind: "follow-up", state: "deferred", id: "F1", text, note: text, children: [] };
      const entries: TreeEntry[] = [
        {
          kind: "question",
          state: "deferred",
          id: "Q1",
          text,
          note: text,
          options: [
            { id: "Q1a", text, state: "deferred", note: text, children: [followUp] },
            { id: "Q1b", text, children: [] },
            { id: "Q1c", text, state: "deferred", note: text, children: [] },
          ],
          children: [],
        },
      ];

      // when
      const xml = tree(entries);

      // then
      assert.equal(xml.includes(text), false);
      assert.equal(xml.split("&lt;&amp;&gt;").length - 1, 9);
    });

    test("status renders no items as an empty element", () => {
      // given
      const items: StatusItem[] = [];

      // when
      const xml = status(items);

      // then
      assert.equal(xml, "<status></status>");
    });

    test("status renders a decided option with no children on one line", () => {
      // given
      const items: StatusItem[] = [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q",
          decided: [{ id: "Q1a", text: "a", children: [] }],
          children: [],
        },
      ];

      // when
      const xml = status(items);

      // then
      assert.equal(
        xml,
        [
          "<status>",
          '  <question state="settled">',
          "    <id>Q1</id>",
          "    <text>q</text>",
          "    <decided>",
          "      <option><id>Q1a</id><text>a</text></option>",
          "    </decided>",
          "  </question>",
          "</status>",
        ].join("\n"),
      );
    });

    test("status renders a selection's rationale inside decided, after its options", () => {
      // given
      const items: StatusItem[] = [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q",
          decided: [{ id: "Q1a", text: "a", children: [] }],
          children: [],
          rationale: "a < b",
        },
      ];

      // when
      const xml = status(items);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<status>",
        '  <question state="settled">',
        "    <id>Q1</id>",
        "    <text>q</text>",
        "    <decided>",
        "      <option><id>Q1a</id><text>a</text></option>",
        "      <rationale>a &lt; b</rationale>",
        "    </decided>",
        "  </question>",
        "</status>",
      ]);
    });

    test("status renders an open follow-up with its state", () => {
      // given
      const items: StatusItem[] = [{ kind: "follow-up", state: "open", id: "F1", text: "f" }];

      // when
      const xml = status(items);

      // then
      assert.equal(
        xml,
        ["<status>", '  <follow-up state="open">', "    <id>F1</id>", "    <text>f</text>", "  </follow-up>", "</status>"].join(
          "\n",
        ),
      );
    });

    test("status renders deferred items with their state, and a note only when there is one", () => {
      // given
      const items: StatusItem[] = [
        { kind: "question", state: "deferred", id: "Q1", text: "q", note: "why" },
        { kind: "follow-up", state: "deferred", id: "F1", text: "f" },
        { kind: "option", state: "deferred", id: "Q2a", text: "a" },
      ];

      // when
      const xml = status(items);

      // then
      assert.equal(
        xml,
        [
          "<status>",
          '  <question state="deferred">',
          "    <id>Q1</id>",
          "    <text>q</text>",
          "    <note>why</note>",
          "  </question>",
          '  <follow-up state="deferred">',
          "    <id>F1</id>",
          "    <text>f</text>",
          "  </follow-up>",
          '  <option state="deferred">',
          "    <id>Q2a</id>",
          "    <text>a</text>",
          "  </option>",
          "</status>",
        ].join("\n"),
      );
    });

    test("status escapes every text it renders", () => {
      // given
      const text = "<&>";
      const open: StatusItem = {
        kind: "question",
        state: "open",
        id: "Q2",
        text,
        options: [{ id: "Q2a", text }],
        children: [],
      };
      const items: StatusItem[] = [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text,
          decided: [{ id: "Q1a", text, children: [open] }],
          children: [],
        },
        { kind: "follow-up", state: "open", id: "F1", text },
        { kind: "question", state: "deferred", id: "Q3", text, note: text },
      ];

      // when
      const xml = status(items);

      // then
      assert.equal(xml.includes(text), false);
      assert.equal(xml.split("&lt;&amp;&gt;").length - 1, 7);
    });

    test("status renders an open question with its state and options", () => {
      // given
      const items: StatusItem[] = [
        { kind: "question", state: "open", id: "Q1", text: "q", options: [{ id: "Q1a", text: "a" }], children: [] },
      ];

      // when
      const xml = status(items);

      // then
      assert.equal(
        xml,
        [
          "<status>",
          '  <question state="open">',
          "    <id>Q1</id>",
          "    <text>q</text>",
          "    <options>",
          "      <option><id>Q1a</id><text>a</text></option>",
          "    </options>",
          "  </question>",
          "</status>",
        ].join("\n"),
      );
    });

    test("status renders an answer's child inside the decided option and the question's own after it", () => {
      // given
      const child = (id: string): StatusItem => ({
        kind: "question",
        state: "open",
        id,
        text: id,
        options: [],
        children: [],
      });
      const items: StatusItem[] = [
        {
          kind: "question",
          state: "settled",
          id: "Q1",
          text: "q",
          decided: [{ id: "Q1a", text: "a", children: [child("Q2")] }],
          children: [child("Q3")],
        },
      ];

      // when
      const xml = status(items);

      // then
      assert.equal(
        xml,
        [
          "<status>",
          '  <question state="settled">',
          "    <id>Q1</id>",
          "    <text>q</text>",
          "    <decided>",
          "      <option>",
          "        <id>Q1a</id>",
          "        <text>a</text>",
          '        <question state="open">',
          "          <id>Q2</id>",
          "          <text>Q2</text>",
          "          <options></options>",
          "        </question>",
          "      </option>",
          "    </decided>",
          '    <question state="open">',
          "      <id>Q3</id>",
          "      <text>Q3</text>",
          "      <options></options>",
          "    </question>",
          "  </question>",
          "</status>",
        ].join("\n"),
      );
    });

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

    test("follow-up text is escaped", () => {
      // given
      const data: FollowUpData = { id: "F1", text: "a < b > c & d" };

      // when
      const xml = followUp(data);

      // then
      assert.equal(xml, "<follow-up><id>F1</id><text>a &lt; b &gt; c &amp; d</text></follow-up>");
    });

    test("next with a follow-up wraps the follow-up line", () => {
      // given
      const data: FollowUpData = { id: "F1", text: "f" };

      // when
      const xml = next({ kind: "follow-up", followUp: data });

      // then
      assert.deepEqual(xml.split("\n"), ["<next>", `  ${followUp(data)}`, "</next>"]);
    });

    test("a follow-up item renders as its follow-up line", () => {
      // given
      const data: FollowUpData = { id: "F1", text: "f" };

      // when
      const xml = item({ kind: "follow-up", followUp: data });

      // then
      assert.equal(xml, "<follow-up><id>F1</id><text>f</text></follow-up>");
    });

    test("promote renders the new question and the follow-up it came from", () => {
      // given
      const data: PromoteData = {
        question: { id: "Q2", text: "better", options: [{ id: "Q2a", text: "x" }] },
        promoted: { id: "F1", text: "f" },
      };

      // when
      const xml = promote(data);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<promote>",
        "  <question>",
        "    <id>Q2</id>",
        "    <text>better</text>",
        "    <options>",
        "      <option><id>Q2a</id><text>x</text></option>",
        "    </options>",
        "  </question>",
        "  <promoted>",
        "    <follow-up><id>F1</id><text>f</text></follow-up>",
        "  </promoted>",
        "</promote>",
      ]);
    });

    test("supersede renders the superseded question with every option, the selected one marked", () => {
      // given
      const data: SupersedeData = {
        question: { id: "Q3", text: "q3", options: [] },
        superseded: [
          {
            kind: "question",
            state: "settled",
            id: "Q1",
            text: "q1",
            options: [
              { id: "Q1a", text: "a", selected: true, children: [] },
              { id: "Q1b", text: "b", children: [] },
            ],
            children: [],
          },
        ],
      };

      // when
      const xml = supersede(data);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<supersede>",
        "  <question>",
        "    <id>Q3</id>",
        "    <text>q3</text>",
        "    <options></options>",
        "  </question>",
        "  <superseded>",
        '    <question state="settled">',
        "      <id>Q1</id>",
        "      <text>q1</text>",
        "      <options>",
        '        <option selected="true"><id>Q1a</id><text>a</text></option>',
        "        <option><id>Q1b</id><text>b</text></option>",
        "      </options>",
        "    </question>",
        "  </superseded>",
        "</supersede>",
      ]);
    });

    test("supersede of an option renders the new option, then the superseded one with what is under it", () => {
      // given
      const data: SupersedeOptionData = {
        option: { id: "Q1c", text: "c" },
        superseded: {
          id: "Q1a",
          text: "a",
          selected: true,
          children: [{ kind: "question", state: "open", id: "Q2", text: "q2", options: [], children: [] }],
        },
      };

      // when
      const xml = supersedeOption(data);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<supersede>",
        "  <option><id>Q1c</id><text>c</text></option>",
        "  <superseded>",
        '    <option selected="true">',
        "      <id>Q1a</id>",
        "      <text>a</text>",
        '      <question state="open">',
        "        <id>Q2</id>",
        "        <text>q2</text>",
        "        <options></options>",
        "      </question>",
        "    </option>",
        "  </superseded>",
        "</supersede>",
      ]);
    });

    test("tagged items render multi-line with their tags last, escaped", () => {
      // given
      const list: ListedItem[] = [
        {
          item: { kind: "question", question: { id: "Q1", text: "q", options: [] } },
          tags: ["a<b", "c"],
          state: "open",
        },
        { item: { kind: "follow-up", followUp: { id: "F1", text: "f" } }, tags: [], state: "open" },
      ];

      // when
      const xml = items(list);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<items>",
        '  <question state="open">',
        "    <id>Q1</id>",
        "    <text>q</text>",
        "    <options></options>",
        "    <tags><tag>a&lt;b</tag><tag>c</tag></tags>",
        "  </question>",
        '  <follow-up state="open">',
        "    <id>F1</id>",
        "    <text>f</text>",
        "    <tags></tags>",
        "  </follow-up>",
        "</items>",
      ]);
    });

    test("a settled tagged question renders its state, options, selection and tags", () => {
      // given
      const a = { id: "Q1a", text: "a" };
      const b = { id: "Q1b", text: "b" };
      const list: ListedItem[] = [
        {
          item: { kind: "question", question: { id: "Q1", text: "q", options: [a, b] } },
          tags: ["t"],
          state: "settled",
          selected: [a],
        },
      ];

      // when
      const xml = items(list);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<items>",
        '  <question state="settled">',
        "    <id>Q1</id>",
        "    <text>q</text>",
        "    <options>",
        '      <option selected="true"><id>Q1a</id><text>a</text></option>',
        "      <option><id>Q1b</id><text>b</text></option>",
        "    </options>",
        "    <tags><tag>t</tag></tags>",
        "  </question>",
        "</items>",
      ]);
    });

    test("a listed question renders its rationale, escaped, right after the options and before its note", () => {
      // given
      const a = { id: "Q1a", text: "a" };
      const list: ListedItem[] = [
        {
          item: { kind: "question", question: { id: "Q1", text: "q", options: [a] } },
          tags: [],
          state: "deferred",
          selected: [a],
          rationale: "a < b",
          note: "later",
        },
      ];

      // when
      const xml = items(list);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<items>",
        '  <question state="deferred">',
        "    <id>Q1</id>",
        "    <text>q</text>",
        "    <options>",
        '      <option selected="true"><id>Q1a</id><text>a</text></option>',
        "    </options>",
        "    <rationale>a &lt; b</rationale>",
        "    <note>later</note>",
        "    <tags></tags>",
        "  </question>",
        "</items>",
      ]);
    });

    test("a tagged item renders its note, escaped, before its tags", () => {
      // given
      const list: ListedItem[] = [
        {
          item: { kind: "follow-up", followUp: { id: "F1", text: "f" } },
          tags: ["t"],
          state: "deferred",
          note: "a < b",
        },
      ];

      // when
      const xml = items(list);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<items>",
        '  <follow-up state="deferred">',
        "    <id>F1</id>",
        "    <text>f</text>",
        "    <note>a &lt; b</note>",
        "    <tags><tag>t</tag></tags>",
        "  </follow-up>",
        "</items>",
      ]);
    });

    test("a tagged item renders what hides it before its tags", () => {
      // given
      const list: ListedItem[] = [
        {
          item: { kind: "follow-up", followUp: { id: "F1", text: "f" } },
          tags: ["t"],
          state: "frozen",
          hiddenBy: "Q1",
        },
      ];

      // when
      const xml = items(list);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<items>",
        '  <follow-up state="frozen">',
        "    <id>F1</id>",
        "    <text>f</text>",
        "    <hidden-by><id>Q1</id></hidden-by>",
        "    <tags><tag>t</tag></tags>",
        "  </follow-up>",
        "</items>",
      ]);
    });

    test("next renders the trail before the item, one line per step", () => {
      // given
      const data: NextData = {
        kind: "follow-up",
        followUp: { id: "F1", text: "f" },
        trail: [
          { kind: "question", id: "Q1", text: "a < b" },
          { kind: "option", id: "Q1a", text: "a" },
        ],
      };

      // when
      const xml = next(data);

      // then
      assert.deepEqual(xml.split("\n"), [
        "<next>",
        "  <trail>",
        "    <question><id>Q1</id><text>a &lt; b</text></question>",
        "    <option><id>Q1a</id><text>a</text></option>",
        "  </trail>",
        "  <follow-up><id>F1</id><text>f</text></follow-up>",
        "</next>",
      ]);
    });

  }

  function taggedLines(data: TaggedData & Partial<ListedItem>): string[] {
    const tags = data.tags.map((tag) => `<tag>${escapeXml(tag)}</tag>`).join("");
    const line = `  <tags>${tags}</tags>`;
    const state = data.state === undefined ? "" : ` state="${data.state}"`;
    const note = data.note === undefined ? [] : [`  <note>${escapeXml(data.note)}</note>`];
    const hidden = data.hiddenBy === undefined ? [] : [`  <hidden-by><id>${data.hiddenBy}</id></hidden-by>`];

    if (data.item.kind === "question") {
      const { id, text, options } = data.item.question;
      const selectedIds = (data.selected ?? []).map((each) => each.id);
      const optionLines = [
        ...options.map((each) => markedOption(each, selectedIds.includes(each.id))),
        ...(data.hiddenOptions ?? []).map(hiddenOption),
      ].map((line) => `    ${line}`);
      const optionsBlock = optionLines.length === 0 ? optionsLines([]) : ["  <options>", ...optionLines, "  </options>"];

      return [
        `<question${state}>`,
        `  <id>${id}</id>`,
        `  <text>${escapeXml(text)}</text>`,
        ...optionsBlock,
        ...(data.rationale === undefined ? [] : [`  <rationale>${escapeXml(data.rationale)}</rationale>`]),
        ...note,
        ...hidden,
        line,
        ...trailLines(data.trail),
        "</question>",
      ];
    }

    const { id, text } = data.item.followUp;

    return [
      `<follow-up${state}>`,
      `  <id>${id}</id>`,
      `  <text>${escapeXml(text)}</text>`,
      ...note,
      ...hidden,
      line,
      ...trailLines(data.trail),
      "</follow-up>",
    ];
  }

  function taggedItem(data: TaggedData): string {
    return taggedLines(data).join("\n");
  }

  function items(list: ListedItem[]): string {
    if (list.length === 0) return "<items></items>";

    return ["<items>", ...list.flatMap(taggedLines).map((line) => `  ${line}`), "</items>"].join("\n");
  }

  return {
    option,
    question,
    selection,
    followUp,
    item,
    next,
    tree,
    status,
    promote,
    supersede,
    supersedeOption,
    taggedItem,
    items,
    tests,
  };
})();

const Cli = (() => {
  const cliOptions = {
    op: { type: "string" },
    query: { type: "string" },
    test: { type: "boolean" },
    log: { type: "string" },
  } as const;

  const testOptions = {} as const;

  type Mode =
    | { kind: "test" }
    | { kind: "op"; op: string; log: string }
    | { kind: "query"; query: string; log: string };

  function readMode(args?: string[], env: NodeJS.ProcessEnv = process.env): Mode {
    const { op, query, test, log } = parseArgs({ options: cliOptions, strict: false, args }).values;

    const given = [op, query, test].filter((value) => value !== undefined);
    if (given.length > 1) {
      throw new DecisionTreeError("--op, --query and --test are mutually exclusive");
    }

    if (test !== undefined) {
      if (log !== undefined) throw new DecisionTreeError("--test does not take --log");

      return { kind: "test" };
    }

    if (op === undefined && query === undefined) {
      throw new DecisionTreeError("missing --op, --query or --test");
    }
    if (op !== undefined && typeof op !== "string") throw new DecisionTreeError("--op requires a value");
    if (query !== undefined && typeof query !== "string") {
      throw new DecisionTreeError("--query requires a value");
    }

    const logPath = log ?? (env.DECISION_TREE_LOG || undefined);
    if (logPath === undefined) throw new DecisionTreeError("missing --log or DECISION_TREE_LOG");
    if (typeof logPath !== "string") throw new DecisionTreeError("--log requires a value");

    if (typeof query === "string") return { kind: "query", query, log: logPath };

    return { kind: "op", op: op as string, log: logPath };
  }

  function readModeConfig<T extends ParseArgsOptionsConfig>(modeOptions: T, args?: string[]) {
    const options = { ...cliOptions, ...modeOptions };

    const parsed = (() => {
      try {
        return parseArgs({ options, tokens: true, args });
      } catch (error) {
        throw new DecisionTreeError((error as Error).message);
      }
    })();

    const seen = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== "option" || options[token.name]?.multiple) continue;
      if (seen.has(token.name)) throw new DecisionTreeError(`--${token.name} given more than once`);

      seen.add(token.name);
    }

    for (const [name, value] of Object.entries(parsed.values)) {
      const blank = [value].flat().some((each) => typeof each === "string" && each.trim() === "");
      if (blank) throw new DecisionTreeError(`--${name} must not be blank`);
    }

    return parsed.values;
  }

  function tests() {
    test("a command without a log path throws", () => {
      // given
      const args = ["--query", "next"];

      // when
      const act = () => readMode(args, {});

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "missing --log or DECISION_TREE_LOG",
      );
    });

    test("an empty DECISION_TREE_LOG counts as no log path", () => {
      // given
      const args = ["--query", "next"];

      // when
      const act = () => readMode(args, { DECISION_TREE_LOG: "" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "missing --log or DECISION_TREE_LOG",
      );
    });

    test("the log path comes from DECISION_TREE_LOG when there is no --log", () => {
      // given
      const args = ["--query", "next"];

      // when
      const mode = readMode(args, { DECISION_TREE_LOG: "a.jsonl" });

      // then
      assert.deepEqual(mode, { kind: "query", query: "next", log: "a.jsonl" });
    });

    test("--log wins over DECISION_TREE_LOG", () => {
      // given
      const args = ["--log", "b.jsonl", "--query", "next"];

      // when
      const mode = readMode(args, { DECISION_TREE_LOG: "a.jsonl" });

      // then
      assert.deepEqual(mode, { kind: "query", query: "next", log: "b.jsonl" });
    });

    test("a blank flag value throws", () => {
      // given
      const args = ["--text", "   "];

      // when
      const act = () => readModeConfig({ text: { type: "string" } } as const, args);

      // then
      assert.throws(act, (error) => error instanceof DecisionTreeError && error.message === "--text must not be blank");
    });

    test("a blank value among repeated flags throws", () => {
      // given
      const args = ["--option", "a", "--option", " "];

      // when
      const act = () => readModeConfig({ option: { type: "string", multiple: true } } as const, args);

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "--option must not be blank",
      );
    });

    test("a single-value flag given twice throws", () => {
      // given
      const args = ["--target", "Q1", "--target", "Q2"];

      // when
      const act = () => readModeConfig({ target: { type: "string" } } as const, args);

      // then
      assert.throws(
        act,
        (error) => error instanceof DecisionTreeError && error.message === "--target given more than once",
      );
    });

    test("a multiple flag given twice keeps both values", () => {
      // given
      const args = ["--target", "Q1", "--target", "Q2"];

      // when
      const config = readModeConfig({ target: { type: "string", multiple: true } } as const, args);

      // then
      assert.deepEqual(config.target, ["Q1", "Q2"]);
    });
  }

  function runTests() {
    tests();
    Log.tests();
    Graph.tests();
    AddQuestion.tests();
    AddOption.tests();
    SelectOption.tests();
    AddFollowUp.tests();
    PromoteFollowUp.tests();
    Exclude.tests();
    Restore.tests();
    SupersedeQuestion.tests();
    SupersedeOption.tests();
    Focus.tests();
    Tag.tests();
    Untag.tests();
    Items.tests();
    Next.tests();
    Tree.tests();
    Status.tests();
    Xml.tests();
  }

  function main() {
    const mode = readMode();

    if (mode.kind === "test") {
      readModeConfig(testOptions);
      runTests();
      return;
    }

    const log = Log.fileLog(mode.log);

    if (mode.kind === "query") {
      runQuery(log, mode.query);
      return;
    }

    Log.locked(mode.log, () => runOp(log, mode.op));
  }

  function runQuery(log: Log, query: string) {
    switch (query) {
      case "next": {
        const config = readModeConfig(Next.options);
        console.log(Xml.next(Next.run(log, config)));
        break;
      }

      case "tree": {
        const config = readModeConfig(Tree.options);
        console.log(Xml.tree(Tree.run(log, config)));
        break;
      }

      case "status": {
        const config = readModeConfig(Status.options);
        console.log(Xml.status(Status.run(log, config)));
        break;
      }

      case "items": {
        const config = readModeConfig(Items.options);
        console.log(Xml.items(Items.run(log, config)));
        break;
      }

      default:
        throw new DecisionTreeError(`unknown query: ${query}`);
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
        console.log(Xml.promote(PromoteFollowUp.run(log, config)));
        break;
      }

      case "exclude": {
        const config = readModeConfig(Exclude.options);
        console.log(Xml.item(Exclude.run(log, config)));
        break;
      }

      case "restore": {
        const config = readModeConfig(Restore.options);
        console.log(Xml.item(Restore.run(log, config)));
        break;
      }

      case "tag": {
        const config = readModeConfig(Tag.options);
        console.log(Xml.taggedItem(Tag.run(log, config)));
        break;
      }

      case "untag": {
        const config = readModeConfig(Untag.options);
        console.log(Xml.taggedItem(Untag.run(log, config)));
        break;
      }

      case "focus": {
        const config = readModeConfig(Focus.options);
        console.log(Xml.item(Focus.run(log, config)));
        break;
      }

      case "supersede-question": {
        const config = readModeConfig(SupersedeQuestion.options);
        console.log(Xml.supersede(SupersedeQuestion.run(log, config)));
        break;
      }

      case "supersede-option": {
        const config = readModeConfig(SupersedeOption.options);
        console.log(Xml.supersedeOption(SupersedeOption.run(log, config)));
        break;
      }
      default:
        throw new DecisionTreeError(`unknown op: ${op}`);
    }
  }

  return { main };
})();

try {
  Cli.main();
} catch (error) {
  if (!(error instanceof DecisionTreeError)) throw error;

  console.error(error.message);
  process.exit(1);
}
