import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionHandler, SessionStartEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import extension from "../../index.ts";
import { MODEL_ID, SETTING_KEY, choiceRequest, createHarness } from "../fixtures/harness.ts";

async function startExtension(settings: Record<string, unknown>) {
    const registered: string[] = [];
    const notifications: { message: string; level?: string }[] = [];
    let onStart: ExtensionHandler<SessionStartEvent> | undefined;
    const pi = {
        on(event: string, handler: ExtensionHandler<SessionStartEvent>) {
            if (event === "session_start") onStart = handler;
        },
        registerTool: ({ name }: ToolDefinition) => registered.push(name),
        getSettings: () => settings,
    } as unknown as ExtensionAPI;
    const ctx = {
        hasUI: true,
        ui: { notify(message: string, level?: string) { notifications.push({ message, level }); } },
    } as ExtensionContext;

    await extension(pi);
    assert.deepEqual(registered, [], "tool registration waits for session_start");
    assert.ok(onStart, "the extension handles session_start");
    await onStart({ type: "session_start", reason: "startup" }, ctx);
    return { registered, notifications };
}

test("classify startup on Linux", async (t) => {
    const original = process.platform;
    t.after(() => Object.defineProperty(process, "platform", { value: original }));
    Object.defineProperty(process, "platform", { value: "linux" });

    await t.test("registers the tool when decisionModel is set", async () => {
        const { registered, notifications } = await startExtension({ [SETTING_KEY]: MODEL_ID });
        assert.deepEqual(registered, ["classify"]);
        assert.deepEqual(notifications, []);
    });

    for (const [label, settings] of [
        ["missing", {}],
        ["empty", { [SETTING_KEY]: "" }],
        ["whitespace-only", { [SETTING_KEY]: " \t" }],
        ["not a string", { [SETTING_KEY]: 7 }],
    ] as const) {
        await t.test(`warns and registers no tool when decisionModel is ${label}`, async () => {
            const { registered, notifications } = await startExtension(settings);
            assert.deepEqual(registered, []);
            assert.equal(notifications.length, 1);
            assert.equal(notifications[0].level, "warning");
            assert.match(notifications[0].message, /classify.*decisionModel.*settings\.json/);
        });
    }
});

test("classify is registered as a direct tool", () => {
    const { tool } = createHarness();
    assert.equal(tool.name, "classify");
    assert.equal(tool.label, "Classify");
    assert.equal(tool.exposure, undefined);
    assert.equal(tool.defaultActive, undefined);
    assert.equal(tool.namespace, undefined);
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(typeof tool.renderResult, "function");
});

test("the parameter schema accepts a well-formed batch", () => {
    const { tool } = createHarness();
    assert.equal(Check(tool.parameters, { requests: [choiceRequest()] }), true);
});

test("the parameter schema rejects malformed batches", () => {
    const { tool } = createHarness();
    const question = {
        type: "choice",
        instructions: "Choose from the evidence.",
        criteria: { redis: "Networked" },
    };
    assert.equal(Check(tool.parameters, {}), false, "requests is required");
    assert.equal(Check(tool.parameters, { requests: {} }), false, "requests must be an array");
    assert.equal(
        Check(tool.parameters, { requests: [{ questions: { q: question } }] }),
        false,
        "state is required",
    );
    assert.equal(
        Check(tool.parameters, { requests: [{ state: {}, questions: { q: { ...question, instructions: 1 } } }] }),
        false,
        "instructions must be a string",
    );
    assert.equal(
        Check(tool.parameters, { requests: [{ state: {}, questions: { q: { ...question, type: "ranking" } } }] }),
        false,
        "type is one of choice, bool, score",
    );
});

test("the parameter schema leaves the batch budget and the criteria values to execute", () => {
    const { tool } = createHarness();
    assert.equal(Check(tool.parameters, { requests: [] }), true, "an empty batch reaches execute");
    assert.equal(
        Check(tool.parameters, { requests: Array.from({ length: 21 }, () => choiceRequest()) }),
        true,
        "an over-budget batch reaches execute for the budget message",
    );
    const criteria = (value: unknown) => ({
        requests: [{ state: {}, questions: { q: { type: "choice", instructions: "Decide.", criteria: value } } }],
    });
    assert.equal(Check(tool.parameters, criteria({ redis: 1 })), true, "a non-string meaning reaches execute");
    assert.equal(Check(tool.parameters, criteria(["low", 2])), true, "a non-string level reaches execute");
});

test("the output schema describes a results array of ok-discriminated entries", () => {
    const { tool } = createHarness();
    const schema = tool.outputSchema;
    assert.ok(schema, "the tool declares an outputSchema");
    const success = { ok: true, answers: { store: { type: "choice", choice: "redis" } } };
    const failure = { ok: false, stopReason: "error", errorMessage: "OpenRouter error (429): rate limited" };
    const score = { ok: true, answers: { urgency: { type: "score", score: 1.4, confidence: 0.6 } } };
    const bool = { ok: true, answers: { risky: { type: "bool", probability: 0.1 } } };
    assert.equal(Check(schema, { results: [] }), true);
    assert.equal(Check(schema, { results: [success, failure] }), true);
    assert.equal(Check(schema, { results: [score, bool] }), true);
    assert.equal(Check(schema, { results: [{ ...failure, ok: true }] }), false, "ok alone discriminates the branches");
    assert.equal(Check(schema, { results: [{ ok: false, answers: {} }] }), false, "a failure carries no answers");
    assert.equal(
        Check(schema, { results: [{ ok: false, stopReason: "aborted", errorMessage: "x" }] }),
        false,
        "error is the only failure stop reason",
    );
});

test("the description states the batch contract, the state-only input, and failure handling", () => {
    const { tool } = createHarness();
    const description = tool.description;
    assert.match(description, /classify/);
    assert.match(description, /not for implementation/);
    assert.match(description, /classifier sees only `state` and `questions`/);
    assert.match(description, /1 to 20/);
    assert.match(description, /"ok": true/);
    assert.match(description, /"ok": false/);
    assert.match(description, /never invent an answer/i);
    for (const type of ["choice", "bool", "score"]) assert.match(description, new RegExp(`\`${type}\``));
    assert.match(description, /ask_user/);
});

test("the prompt snippet is one line and names the batched state input", () => {
    const { tool } = createHarness();
    assert.ok(tool.promptSnippet, "the tool declares a promptSnippet");
    assert.equal(tool.promptSnippet?.includes("\n"), false);
    assert.match(tool.promptSnippet ?? "", /state/);
});

test("every prompt guideline bullet names classify", () => {
    const { tool } = createHarness();
    const guidelines = tool.promptGuidelines ?? [];
    assert.ok(guidelines.length >= 3, "the tool declares its guidance as bullets");
    for (const bullet of guidelines) assert.match(bullet, /classify/);
    assert.ok(guidelines.some((bullet) => /`state`/.test(bullet)), "a bullet puts evidence in state");
    assert.ok(guidelines.some((bullet) => /ok.*false/i.test(bullet)), "a bullet covers failed entries");
});
