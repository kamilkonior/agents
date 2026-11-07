const assert                                      = require("node:assert/strict");
const fs                           = require("node:fs");
const { tmpdir }                           = require("node:os");
const { dirname, join }                             = require("node:path");
const { test }                             = require("node:test");
const { parseArgs }                             = require("node:util");

const { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } = fs;

                                                                         

                                                     

            
                                                                       
                                                                    
                                             
                                                                        
                                                 
                                                                     
                                             

                                              

            
                  
                             
  

                                               

                                                                        

                                                                                    

                                                 

               
                                                                                            
                                                                                                    
                                                    

               
                                                
                                          
                                                  

               
                                                
                                                  

                     
                   
             
               
                                                    
                        
                           
                            
                      
  

                   
                 
             
               
                         
                           
                            
  

                     
                    
             
               
                                                    
                              
                           
                            
  

              
                                                               
                        
                                
                                           
  

class DesignTreeError extends Error {}

const Log = (() => {
  function fileLog(path        )      {
    return {
      read() {
        if (!existsSync(path)) return [];

        return readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line));
      },

      append(event) {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, JSON.stringify(event) + "\n");
      },
    };
  }

  function memoryLog(events          = [])      {
    return {
      read() {
        return [...events];
      },

      append(event) {
        events.push(event);
      },
    };
  }

  function find(log     , id        )                    {
    return log.read().find((event) => "id" in event && event.id === id);
  }

  function has(log     , id        )          {
    return find(log, id) !== undefined;
  }

  function nextId(log     , type                 , prefix        )         {
    const numbers = log
      .read()
      .filter((event)                   => event.type === type)
      .map((event) => Number(event.id.slice(prefix.length)));

    return `${prefix}${Math.max(0, ...numbers) + 1}`;
  }

  function transaction   (log     , work                    )    {
    const existing = log.read();
    const staged = memoryLog([...existing]);

    const result = work(staged);

    for (const event of staged.read().slice(existing.length)) log.append(event);

    return result;
  }

  function tests() {
    test("transaction that throws leaves the log untouched", () => {
      // given
      const question        = { type: "add-question", id: "Q1", text: "q" };
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
      const question        = { type: "add-question", id: "Q1", text: "q" };
      const option        = { type: "add-option", id: "Q1a", text: "a", origin: "Q1" };
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
      const question        = { type: "add-question", id: "Q1", text: "q" };
      const option        = { type: "add-option", id: "Q1a", text: "a", origin: "Q1" };

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
      const question        = { type: "add-question", id: "Q1", text: "q" };
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
  function questionNode(nodes                , id        )               {
    const node = nodes.get(id);
    if (node?.kind !== "question") throw new Error(`log has no question ${id}`);

    return node;
  }

  function optionNode(nodes                , id        )             {
    const node = nodes.get(id);
    if (node?.kind !== "option") throw new Error(`log has no option ${id}`);

    return node;
  }

  function followUpNode(nodes                , id        )               {
    const node = nodes.get(id);
    if (node?.kind !== "follow-up") throw new Error(`log has no follow-up ${id}`);

    return node;
  }

  function parentNode(nodes                , id        )                                           {
    const node = nodes.get(id);
    if (node === undefined) throw new Error(`log has no node ${id}`);

    return node;
  }

  function excludedBy(
    graph       ,
    node                                          ,
  )                                                       {
    if (graph.exclusions.has(node.id)) return node;

    const parent = node.kind === "option" ? node.question : node.parent;

    return parent === undefined ? undefined : excludedBy(graph, parent);
  }

  function liveOptions(graph       , question              )               {
    return question.options
      .filter((option) => !graph.exclusions.has(option.id))
      .map((option) => ({ id: option.id, text: option.text }));
  }

  function build(log     )        {
    const nodes                 = new Map();
    const roots                 = [];
    const rootFollowUps                 = [];
    const exclusions                      = new Map();

    for (const event of log.read()) {
      switch (event.type) {
        case "add-question": {
          const node               = {
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
          const node             = {
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
          const option = optionNode(nodes, event.target);
          option.question.answer = option;
          break;
        }

        case "add-follow-up": {
          const node               = {
            kind: "follow-up",
            id: event.id,
            text: event.text,
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

        case "exclude-item": {
          exclusions.set(parentNode(nodes, event.target).id, event.reason);
          break;
        }

        case "restore-item": {
          exclusions.delete(parentNode(nodes, event.target).id);
          break;
        }

        default: {
          const unknown        = event;
          throw new DesignTreeError(`unknown event type: ${(unknown                    ).type}`);
        }
      }
    }

    return { nodes, roots, rootFollowUps, exclusions };
  }

  function tree(graph       )             {
    function live(node                                          )          {
      return !graph.exclusions.has(node.id);
    }

    function question(node              )             {
      if (!live(node)) return [];

      const answer = node.answer !== undefined && live(node.answer) ? node.answer : undefined;

      const children             = [];
      if (answer !== undefined) {
        children.push(...answer.children.flatMap(question), ...followUps(answer));
      }
      children.push(...node.children.flatMap(question), ...followUps(node));

      if (answer === undefined) {
        return [{ kind: "open-question", id: node.id, text: node.text, options: liveOptions(graph, node), children }];
      }

      return [
        { kind: "question", id: node.id, text: node.text, answer: { id: answer.id, text: answer.text }, children },
      ];
    }

    function followUps(node                                          )             {
      return node.followUps.flatMap(followUp);
    }

    function followUp(node              )             {
      if (!live(node)) return [];
      if (node.status === "open") return [{ kind: "follow-up", id: node.id, text: node.text }];

      return [...node.children.flatMap(question), ...followUps(node)];
    }

    return [...graph.roots.flatMap(question), ...graph.rootFollowUps.flatMap(followUp)];
  }

  function frontier(graph       )                                            {
    function open(item          )                                            {
      if (item.kind === "follow-up") return [item];

      const below = item.children.flatMap(open);

      return item.kind === "open-question" ? [item, ...below] : below;
    }

    return tree(graph).flatMap(open);
  }

  function liveNode(log     , id        , role                     )                                           {
    const graph = build(log);

    const node = graph.nodes.get(id);
    if (node === undefined) throw new DesignTreeError(`${role} not found: ${id}`);
    if (excludedBy(graph, node) !== undefined) throw new DesignTreeError(`${role} is excluded: ${id}`);

    return node;
  }

  function excludedNode(log     , id        )                                           {
    const graph = build(log);

    const node = graph.nodes.get(id);
    if (node === undefined) throw new DesignTreeError(`target not found: ${id}`);

    const excluding = excludedBy(graph, node);
    if (excluding === undefined) throw new DesignTreeError(`target is not excluded: ${id}`);
    if (excluding !== node) {
      throw new DesignTreeError(`${id} cannot be restored, as its ancestor ${excluding.id} is excluded`);
    }

    return node;
  }

  function itemData(log     , node                                          )           {
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
    test("an unknown event type throws", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "dismiss-follow-up", target: "F1" }                    ,
      ]);

      // when
      const act = () => build(log);

      // then
      assert.throws(
        act,
        (error) => error instanceof DesignTreeError && error.message === "unknown event type: dismiss-follow-up",
      );
    });

    test("the latest selection is the question's answer", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "select-option", target: "Q1a" },
        { type: "select-option", target: "Q1b" },
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
          { type: "select-option", target: "Q1a" },
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
          { type: "select-option", target: "Q1a" },
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
          { type: "select-option", target: "Q1a" },
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
          { type: "select-option", target: "Q1a" },
          { type: "select-option", target: "Q1b" },
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
          { type: "select-option", target: "Q1a" },
          { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1" },
          { type: "add-follow-up", id: "F2", text: "f2", origin: "Q1" },
          { type: "promote-follow-up", target: "F1" },
          { type: "exclude-item", target: "F2", reason: "not-applicable" },
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
          { type: "select-option", target: "Q1a" },
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
          { type: "select-option", target: "Q1a" },
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
          { type: "select-option", target: "Q1a" },
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
          { type: "select-option", target: "Q1a" },
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
          { type: "select-option", target: "Q1a" },
          { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1" },
          { type: "add-follow-up", id: "F2", text: "f2", origin: "F1" },
          { type: "exclude-item", target: "F1", reason: "not-applicable" },
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

    test("tree leaves out off-path branches and excluded follow-ups", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
          { type: "select-option", target: "Q1a" },
          { type: "add-question", id: "Q2", text: "q2", origin: "Q1b" },
          { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1" },
          { type: "exclude-item", target: "F1", reason: "not-applicable" },
        ]),
      );

      // when
      const items = tree(graph);

      // then
      assert.deepEqual(items, [
        { kind: "question", id: "Q1", text: "q1", answer: { id: "Q1a", text: "a" }, children: [] },
      ]);
    });

    test("an excluded answer reopens its question and leaves its subtree out", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
          { type: "select-option", target: "Q1a" },
          { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
          { type: "add-option", id: "Q2a", text: "x", origin: "Q2" },
          { type: "exclude-item", target: "Q1a", reason: "not-applicable" },
        ]),
      );

      // when
      const items = tree(graph);

      // then
      assert.deepEqual(items, [
        { kind: "open-question", id: "Q1", text: "q1", options: [{ id: "Q1b", text: "b" }], children: [] },
      ]);
    });

    test("an excluded option is not offered by its open question", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
          { type: "add-option", id: "Q1c", text: "c", origin: "Q1" },
          { type: "exclude-item", target: "Q1b", reason: "deferred" },
        ]),
      );

      // when
      const items = tree(graph);

      // then
      assert.deepEqual(items, [
        {
          kind: "open-question",
          id: "Q1",
          text: "q1",
          options: [
            { id: "Q1a", text: "a" },
            { id: "Q1c", text: "c" },
          ],
          children: [],
        },
      ]);
    });

    test("an excluded question is left out with its subtree", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-question", id: "Q2", text: "q2" },
          { type: "add-question", id: "Q3", text: "q3", origin: "Q1" },
          { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1" },
          { type: "exclude-item", target: "Q1", reason: "not-applicable" },
        ]),
      );

      // when
      const items = tree(graph);

      // then
      assert.deepEqual(items, [{ kind: "open-question", id: "Q2", text: "q2", options: [], children: [] }]);
    });

    test("an excluded follow-up is left out with its subtree", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "select-option", target: "Q1a" },
          { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1" },
          { type: "add-question", id: "Q2", text: "f1", origin: "F1" },
          { type: "promote-follow-up", target: "F1" },
          { type: "exclude-item", target: "F1", reason: "deferred" },
        ]),
      );

      // when
      const items = tree(graph);

      // then
      assert.deepEqual(items, [
        { kind: "question", id: "Q1", text: "q1", answer: { id: "Q1a", text: "a" }, children: [] },
      ]);
    });

    test("a restored answer settles its question again with its subtree", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
          { type: "select-option", target: "Q1a" },
          { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
          { type: "exclude-item", target: "Q1a", reason: "not-applicable" },
          { type: "restore-item", target: "Q1a" },
        ]),
      );

      // when
      const items = tree(graph);

      // then
      assert.deepEqual(items, [
        {
          kind: "question",
          id: "Q1",
          text: "q1",
          answer: { id: "Q1a", text: "a" },
          children: [{ kind: "open-question", id: "Q2", text: "q2", options: [], children: [] }],
        },
      ]);
    });

    test("tree nests the settled path, with promoted follow-ups in place", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "select-option", target: "Q1a" },
          { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1a" },
          { type: "add-question", id: "Q2", text: "f1", origin: "F1" },
          { type: "add-option", id: "Q2a", text: "x", origin: "Q2" },
          { type: "promote-follow-up", target: "F1" },
          { type: "select-option", target: "Q2a" },
        ]),
      );

      // when
      const items = tree(graph);

      // then
      assert.deepEqual(items, [
        {
          kind: "question",
          id: "Q1",
          text: "q1",
          answer: { id: "Q1a", text: "a" },
          children: [
            { kind: "question", id: "Q2", text: "f1", answer: { id: "Q2a", text: "x" }, children: [] },
          ],
        },
      ]);
    });

    test("an open question shows its options and what's under it", () => {
      // given
      const graph = build(
        Log.memoryLog([
          { type: "add-question", id: "Q1", text: "q1" },
          { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
          { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
          { type: "add-question", id: "Q2", text: "q2", origin: "Q1" },
        ]),
      );

      // when
      const items = tree(graph);

      // then
      assert.deepEqual(items, [
        {
          kind: "open-question",
          id: "Q1",
          text: "q1",
          options: [
            { id: "Q1a", text: "a" },
            { id: "Q1b", text: "b" },
          ],
          children: [{ kind: "open-question", id: "Q2", text: "q2", options: [], children: [] }],
        },
      ]);
    });

    test("looking up an unknown id throws not found for its role", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => liveNode(log, "Q9", "target");

      // then
      assert.throws(act, (error) => error instanceof DesignTreeError && error.message === "target not found: Q9");
    });

    test("looking up an excluded item throws excluded for its role", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "exclude-item", target: "Q1", reason: "deferred" },
      ]);

      // when
      const act = () => liveNode(log, "Q1", "origin");

      // then
      assert.throws(act, (error) => error instanceof DesignTreeError && error.message === "origin is excluded: Q1");
    });

    test("looking up an item under an excluded option throws excluded", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "exclude-item", target: "Q1a", reason: "not-applicable" },
      ]);

      // when
      const act = () => liveNode(log, "Q2", "target");

      // then
      assert.throws(act, (error) => error instanceof DesignTreeError && error.message === "target is excluded: Q2");
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
      assert.throws(act, (error) => error instanceof DesignTreeError && error.message === "target not found: Q9");
    });

    test("looking up a live item to restore throws not excluded", () => {
      // given
      const log = Log.memoryLog([{ type: "add-question", id: "Q1", text: "q" }]);

      // when
      const act = () => excludedNode(log, "Q1");

      // then
      assert.throws(act, (error) => error instanceof DesignTreeError && error.message === "target is not excluded: Q1");
    });

    test("looking up an item hidden by an excluded ancestor to restore throws", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-question", id: "Q2", text: "q2", origin: "Q1a" },
        { type: "exclude-item", target: "Q1a", reason: "not-applicable" },
      ]);

      // when
      const act = () => excludedNode(log, "Q2");

      // then
      assert.throws(
        act,
        (error) =>
          error instanceof DesignTreeError && error.message === "Q2 cannot be restored, as its ancestor Q1a is excluded",
      );
    });

    test("looking up an excluded item to restore returns its node", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "exclude-item", target: "Q1a", reason: "deferred" },
      ]);

      // when
      const node = excludedNode(log, "Q1a");

      // then
      assert.equal(node.kind, "option");
      assert.equal(node.id, "Q1a");
    });
  }

  return {
    tree: (log     ) => tree(build(log)),
    frontier: (log     ) => frontier(build(log)),
    liveNode,
    excludedNode,
    itemData,
    tests,
  };
})();

const AddQuestion = (() => {
  const options = {
    text: { type: "string" },
    origin: { type: "string" },
    option: { type: "string", multiple: true },
  }         ;

  function addQuestion(log     , text        , origin         )         {
    if (origin !== undefined) Graph.liveNode(log, origin, "origin");

    const id = Log.nextId(log, "add-question", "Q");
    const event        = { type: "add-question", id, text };
    if (origin !== undefined) event.origin = origin;

    log.append(event);

    return id;
  }

  function run(
    log     ,
    config                                                       ,
  )               {
    const text = config.text;
    if (!text) throw new DesignTreeError("add-question requires --text");
    if ((config.option ?? []).length < 2) {
      throw new DesignTreeError("a question requires at least two options");
    }

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

    test("question with a single option throws and appends nothing", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => run(log, { text: "q", option: ["a"] });

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
      const events          = [
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
  }         ;

  function nextOptionId(log     , origin        )         {
    const count = log
      .read()
      .filter((event) => event.type === "add-option" && event.origin === origin).length;
    if (count >= 26) throw new DesignTreeError(`question ${origin} already has 26 options`);

    return `${origin}${String.fromCharCode("a".charCodeAt(0) + count)}`;
  }

  function add(log     , text        , origin        )         {
    if (!text) throw new DesignTreeError("option requires a text");

    const question = Graph.liveNode(log, origin, "origin");
    if (question.kind !== "question") {
      throw new DesignTreeError(`origin is not a question: ${origin}`);
    }

    const id = nextOptionId(log, origin);

    log.append({ type: "add-option", id, text, origin });

    return id;
  }

  function run(log     , config                                    )             {
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
      const events          = [
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
      const events          = [
        { type: "add-question", id: "Q1", text: "q" },
        ...letters.map((letter)        => ({
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
      const question        = { type: "add-question", id: "Q1", text: "q" };
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
      const events          = [
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
      const events          = [
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
    target: { type: "string" },
  }         ;

  function select(log     , target        )                {
    const option = Graph.liveNode(log, target, "target");
    if (option.kind !== "option") {
      throw new DesignTreeError(`target is not an option: ${target}`);
    }

    const question = option.question;

    log.append({ type: "select-option", target });

    return {
      question: { id: question.id, text: question.text },
      option: { id: option.id, text: option.text },
    };
  }

  function run(log     , config                     )                {
    if (!config.target) throw new DesignTreeError("select-option requires --target");

    return select(log, config.target);
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
        (error) => error instanceof DesignTreeError && error.message === "select-option requires --target",
      );
      assert.deepEqual(log.read(), []);
    });

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
      const question        = { type: "add-question", id: "Q1", text: "q" };
      const log = Log.memoryLog([question]);

      // when
      const act = () => select(log, "Q1");

      // then
      assert.throws(act, DesignTreeError);
      assert.deepEqual(log.read(), [question]);
    });

    test("selecting an option records it and returns the question with the option", () => {
      // given
      const events          = [
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
      assert.deepEqual(log.read(), [...events, { type: "select-option", target: "Q1a" }]);
    });
  }

  return { options, run, tests };
})();

const AddFollowUp = (() => {
  const options = {
    text: { type: "string" },
    origin: { type: "string" },
  }         ;

  function add(log     , text        , origin         )         {
    if (!text) throw new DesignTreeError("follow-up requires a text");

    if (origin !== undefined) Graph.liveNode(log, origin, "origin");

    const id = Log.nextId(log, "add-follow-up", "F");
    const event        = { type: "add-follow-up", id, text };
    if (origin !== undefined) event.origin = origin;

    log.append(event);

    return id;
  }

  function run(log     , config                                    )               {
    if (!config.text) throw new DesignTreeError("add-follow-up requires --text");

    const id = add(log, config.text, config.origin);

    return { id, text: config.text };
  }

  function open(log     , id        )               {
    const node = Graph.liveNode(log, id, "target");
    if (node.kind !== "follow-up") throw new DesignTreeError(`target is not a follow-up: ${id}`);
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

    test("follow-up under an excluded follow-up throws and appends nothing", () => {
      // given
      const events          = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-follow-up", id: "F1", text: "f1", origin: "Q1" },
        { type: "exclude-item", target: "F1", reason: "not-applicable" },
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
      const events          = [
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
      const events          = [
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
        { type: "exclude-item", target: "F1", reason: "not-applicable" },
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
    target: { type: "string" },
    option: { type: "string", multiple: true },
  }         ;

  function run(log     , config                                        )               {
    const target = config.target;
    if (!target) throw new DesignTreeError("promote-follow-up requires --target");

    return Log.transaction(log, (staged) => {
      const followUp = AddFollowUp.open(staged, target);
      const question = AddQuestion.run(staged, {
        text: followUp.text,
        origin: followUp.id,
        option: config.option,
      });

      staged.append({ type: "promote-follow-up", target });

      return question;
    });
  }

  function tests() {
    test("promoting without a target throws and appends nothing", () => {
      // given
      const events          = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-follow-up", id: "F1", text: "f", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { option: ["x", "y"] });

      // then
      assert.throws(
        act,
        (error) => error instanceof DesignTreeError && error.message === "promote-follow-up requires --target",
      );
      assert.deepEqual(log.read(), events);
    });

    test("promoting with an empty option throws and appends nothing", () => {
      // given
      const events          = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-follow-up", id: "F1", text: "f", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "F1", option: ["a", ""] });

      // then
      assert.throws(act, DesignTreeError);
      assert.deepEqual(log.read(), events);
    });

    test("promoting a follow-up creates its question under it", () => {
      // given
      const events          = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-follow-up", id: "F1", text: "f", origin: "Q1a" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const question = run(log, { target: "F1", option: ["x", "y"] });

      // then
      assert.deepEqual(question, {
        id: "Q2",
        text: "f",
        options: [
          { id: "Q2a", text: "x" },
          { id: "Q2b", text: "y" },
        ],
      });
      assert.deepEqual(log.read(), [
        ...events,
        { type: "add-question", id: "Q2", text: "f", origin: "F1" },
        { type: "add-option", id: "Q2a", text: "x", origin: "Q2" },
        { type: "add-option", id: "Q2b", text: "y", origin: "Q2" },
        { type: "promote-follow-up", target: "F1" },
      ]);
    });
  }

  return { options, run, tests };
})();

const ExcludeItem = (() => {
  const options = {
    target: { type: "string" },
    reason: { type: "string" },
  }         ;

  const reasons                    = ["not-applicable", "deferred"];

  function run(log     , config                                      )           {
    const { target, reason } = config;
    if (!target) throw new DesignTreeError("exclude-item requires --target");
    if (!reason) throw new DesignTreeError("exclude-item requires --reason");

    const exclusionReason = reasons.find((each) => each === reason);
    if (exclusionReason === undefined) {
      throw new DesignTreeError(`reason must be ${reasons.join(" or ")}: ${reason}`);
    }

    const node = Graph.liveNode(log, target, "target");

    const excluded = Graph.itemData(log, node);

    log.append({ type: "exclude-item", target, reason: exclusionReason });

    return excluded;
  }

  function tests() {
    test("excluding without a target throws and appends nothing", () => {
      // given
      const events          = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { reason: "deferred" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DesignTreeError && error.message === "exclude-item requires --target",
      );
      assert.deepEqual(log.read(), events);
    });

    test("excluding without a reason throws and appends nothing", () => {
      // given
      const events          = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q1" });

      // then
      assert.throws(
        act,
        (error) => error instanceof DesignTreeError && error.message === "exclude-item requires --reason",
      );
      assert.deepEqual(log.read(), events);
    });

    test("excluding with an unknown reason throws and appends nothing", () => {
      // given
      const events          = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, { target: "Q1", reason: "later" });

      // then
      assert.throws(
        act,
        (error) =>
          error instanceof DesignTreeError && error.message === "reason must be not-applicable or deferred: later",
      );
      assert.deepEqual(log.read(), events);
    });

    test("excluding an unknown target throws and appends nothing", () => {
      // given
      const log = Log.memoryLog();

      // when
      const act = () => run(log, { target: "Q9", reason: "deferred" });

      // then
      assert.throws(act, (error) => error instanceof DesignTreeError && error.message === "target not found: Q9");
      assert.deepEqual(log.read(), []);
    });

    test("excluding an option records the exclusion and returns the option", () => {
      // given
      const events          = [
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
      ];
      const log = Log.memoryLog([...events]);

      // when
      const excluded = run(log, { target: "Q1a", reason: "deferred" });

      // then
      assert.deepEqual(excluded, { kind: "option", option: { id: "Q1a", text: "a" } });
      assert.deepEqual(log.read(), [...events, { type: "exclude-item", target: "Q1a", reason: "deferred" }]);
    });

    test("excluding a question returns it with its options that are not excluded", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "add-option", id: "Q1b", text: "b", origin: "Q1" },
        { type: "add-option", id: "Q1c", text: "c", origin: "Q1" },
        { type: "exclude-item", target: "Q1b", reason: "not-applicable" },
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

const RestoreItem = (() => {
  const options = {
    target: { type: "string" },
  }         ;

  function run(log     , config                     )           {
    const target = config.target;
    if (!target) throw new DesignTreeError("restore-item requires --target");

    const node = Graph.excludedNode(log, target);

    const restored = Graph.itemData(log, node);

    log.append({ type: "restore-item", target });

    return restored;
  }

  function tests() {
    test("restoring without a target throws and appends nothing", () => {
      // given
      const events          = [{ type: "add-question", id: "Q1", text: "q" }];
      const log = Log.memoryLog([...events]);

      // when
      const act = () => run(log, {});

      // then
      assert.throws(
        act,
        (error) => error instanceof DesignTreeError && error.message === "restore-item requires --target",
      );
      assert.deepEqual(log.read(), events);
    });
  }

  return { options, run, tests };
})();

const Next = (() => {
  const options = {}         ;

  function run(log     )                       {
    const node = Graph.frontier(log)[0];
    if (node === undefined) return undefined;

    if (node.kind === "follow-up") {
      return { kind: "follow-up", followUp: { id: node.id, text: node.text } };
    }

    return { kind: "question", question: { id: node.id, text: node.text, options: node.options } };
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

    test("next is a follow-up when one comes first", () => {
      // given
      const log = Log.memoryLog([
        { type: "add-question", id: "Q1", text: "q1" },
        { type: "add-option", id: "Q1a", text: "a", origin: "Q1" },
        { type: "select-option", target: "Q1a" },
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
  const options = {}         ;

  function run(log     )             {
    return Graph.tree(log);
  }

  function tests() {}

  return { options, run, tests };
})();

const Xml = (() => {
  function escapeXml(text        )         {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  function option(data            )         {
    return `<option><id>${data.id}</id><text>${escapeXml(data.text)}</text></option>`;
  }

  function question(data              )         {
    const options = data.options.map((each) => `    ${option(each)}\n`).join("");

    return [
      "<question>",
      `  <id>${data.id}</id>`,
      `  <text>${escapeXml(data.text)}</text>`,
      data.options.length === 0 ? "  <options></options>" : `  <options>\n${options}  </options>`,
      "</question>",
    ].join("\n");
  }

  function selection(data               )         {
    return [
      "<selection>",
      `  <question><id>${data.question.id}</id><text>${escapeXml(data.question.text)}</text></question>`,
      `  ${option(data.option)}`,
      "</selection>",
    ].join("\n");
  }

  function followUp(data              )         {
    return `<follow-up><id>${data.id}</id><text>${escapeXml(data.text)}</text></follow-up>`;
  }

  function item(data          )         {
    switch (data.kind) {
      case "question":
        return question(data.question);
      case "option":
        return option(data.option);
      case "follow-up":
        return followUp(data.followUp);
    }
  }

  function next(data                      )         {
    if (data === undefined) return "<next></next>";
    if (data.kind === "follow-up") return `<next>\n  ${followUp(data.followUp)}\n</next>`;

    const body = question(data.question)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");

    return `<next>\n${body}\n</next>`;
  }

  function tree(items            )         {
    if (items.length === 0) return "<tree></tree>";

    function lines(item          )           {
      if (item.kind === "follow-up") return [followUp(item)];

      const head = [`  <id>${item.id}</id>`, `  <text>${escapeXml(item.text)}</text>`];
      const state =
        item.kind === "question"
          ? [`  <answer><id>${item.answer.id}</id><text>${escapeXml(item.answer.text)}</text></answer>`]
          : ["  <open>", ...item.options.map((each) => `    ${option(each)}`), "  </open>"];
      const children = item.children.flatMap(lines).map((line) => `  ${line}`);

      return ["<question>", ...head, ...state, ...children, "</question>"];
    }

    const body = items.flatMap(lines).map((line) => `  ${line}`);

    return ["<tree>", ...body, "</tree>"].join("\n");
  }

  function tests() {
    test("option text is escaped", () => {
      // given
      const data             = { id: "Q1a", text: "a < b > c & d" };

      // when
      const xml = option(data);

      // then
      assert.equal(xml, "<option><id>Q1a</id><text>a &lt; b &gt; c &amp; d</text></option>");
    });

    test("question without options renders empty options", () => {
      // given
      const data               = { id: "Q1", text: "q", options: [] };

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
      const data               = {
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
      const data               = { id: "Q1", text: "a < b > c & d", options: [] };

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
      const data               = { id: "Q1", text: "q", options: [{ id: "Q1a", text: "a" }] };

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
      const data               = { id: "F1", text: "a < b > c & d" };

      // when
      const xml = followUp(data);

      // then
      assert.equal(xml, "<follow-up><id>F1</id><text>a &lt; b &gt; c &amp; d</text></follow-up>");
    });

    test("next with a follow-up wraps the follow-up line", () => {
      // given
      const data               = { id: "F1", text: "f" };

      // when
      const xml = next({ kind: "follow-up", followUp: data });

      // then
      assert.deepEqual(xml.split("\n"), ["<next>", `  ${followUp(data)}`, "</next>"]);
    });

    test("a follow-up item renders as its follow-up line", () => {
      // given
      const data               = { id: "F1", text: "f" };

      // when
      const xml = item({ kind: "follow-up", followUp: data });

      // then
      assert.equal(xml, "<follow-up><id>F1</id><text>f</text></follow-up>");
    });

    test("an empty tree renders an empty tree element", () => {
      // given
      const items             = [];

      // when
      const xml = tree(items);

      // then
      assert.equal(xml, "<tree></tree>");
    });

    test("tree renders a settled question with an open question nested inside", () => {
      // given
      const items             = [
        {
          kind: "question",
          id: "Q1",
          text: "q1",
          answer: { id: "Q1a", text: "a" },
          children: [
            {
              kind: "open-question",
              id: "Q2",
              text: "q2",
              options: [
                { id: "Q2a", text: "x" },
                { id: "Q2b", text: "y" },
              ],
              children: [],
            },
          ],
        },
      ];

      // when
      const xml = tree(items);

      // then
      assert.equal(
        xml,
        [
          "<tree>",
          "  <question>",
          "    <id>Q1</id>",
          "    <text>q1</text>",
          "    <answer><id>Q1a</id><text>a</text></answer>",
          "    <question>",
          "      <id>Q2</id>",
          "      <text>q2</text>",
          "      <open>",
          "        <option><id>Q2a</id><text>x</text></option>",
          "        <option><id>Q2b</id><text>y</text></option>",
          "      </open>",
          "    </question>",
          "  </question>",
          "</tree>",
        ].join("\n"),
      );
    });

    test("tree escapes answer text and renders follow-ups as follow-up lines", () => {
      // given
      const follow               = { id: "F1", text: "f" };
      const items             = [
        {
          kind: "question",
          id: "Q1",
          text: "q1",
          answer: { id: "Q1a", text: "a < b > c & d" },
          children: [],
        },
        { kind: "follow-up", ...follow },
      ];

      // when
      const xml = tree(items);

      // then
      const lines = xml.split("\n");
      assert.ok(lines.includes("    <answer><id>Q1a</id><text>a &lt; b &gt; c &amp; d</text></answer>"));
      assert.equal(lines.at(-2), `  ${followUp(follow)}`);
    });
  }

  return { option, question, selection, followUp, item, next, tree, tests };
})();

const Cli = (() => {
  const cliOptions = {
    op: { type: "string" },
    query: { type: "string" },
    test: { type: "boolean" },
    log: { type: "string" },
  }         ;

  const testOptions = {}         ;

             
                      
                                             
                                                    

  function readMode()       {
    const { op, query, test, log } = parseArgs({ options: cliOptions, strict: false }).values;

    const given = [op, query, test].filter((value) => value !== undefined);
    if (given.length > 1) {
      throw new DesignTreeError("--op, --query and --test are mutually exclusive");
    }

    if (test !== undefined) {
      if (log !== undefined) throw new DesignTreeError("--test does not take --log");

      return { kind: "test" };
    }

    if (op === undefined && query === undefined) {
      throw new DesignTreeError("missing --op, --query or --test");
    }
    if (op !== undefined && typeof op !== "string") throw new DesignTreeError("--op requires a value");
    if (query !== undefined && typeof query !== "string") {
      throw new DesignTreeError("--query requires a value");
    }

    if (log === undefined) throw new DesignTreeError("missing --log");
    if (typeof log !== "string") throw new DesignTreeError("--log requires a value");

    if (typeof query === "string") return { kind: "query", query, log };

    return { kind: "op", op: op          , log };
  }

  function readModeConfig                                  (modeOptions   ) {
    try {
      return parseArgs({ options: { ...cliOptions, ...modeOptions } }).values;
    } catch (error) {
      throw new DesignTreeError((error         ).message);
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
    ExcludeItem.tests();
    RestoreItem.tests();
    Next.tests();
    Tree.tests();
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

    runOp(log, mode.op);
  }

  function runQuery(log     , query        ) {
    switch (query) {
      case "next": {
        readModeConfig(Next.options);
        console.log(Xml.next(Next.run(log)));
        break;
      }

      case "tree": {
        readModeConfig(Tree.options);
        console.log(Xml.tree(Tree.run(log)));
        break;
      }

      default:
        throw new DesignTreeError(`unknown query: ${query}`);
    }
  }

  function runOp(log     , op        ) {
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

      case "exclude-item": {
        const config = readModeConfig(ExcludeItem.options);
        console.log(Xml.item(ExcludeItem.run(log, config)));
        break;
      }

      case "restore-item": {
        const config = readModeConfig(RestoreItem.options);
        console.log(Xml.item(RestoreItem.run(log, config)));
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
