import assert from "node:assert/strict";
import test from "node:test";
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import {
    MODEL_ID,
    boolRequest,
    choiceRequest,
    createHarness,
    entries,
    fail,
    resultText,
    scoreRequest,
    succeed,
} from "../fixtures/harness.ts";

const answer = (id: string, choice: string): ClassifierResult =>
    ({
        api: "typesafe-system-one",
        provider: "openrouter",
        model: MODEL_ID,
        answers: { [id]: { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 0.9 } },
        stopReason: "stop",
        timestamp: 0,
    }) as ClassifierResult;

test("a successful batch returns one entry per request in input order", async () => {
    const harness = createHarness();
    const result = await harness.run({ requests: [choiceRequest("store"), boolRequest("risky")] });
    const store = { type: "choice", choice: "redis", probabilities: { redis: 1 }, confidence: 0.75 };
    assert.deepEqual(result.structuredContent, {
        results: [
            { ok: true, answers: { store } },
            { ok: true, answers: { risky: { type: "bool", probability: 0.25 } } },
        ],
    });
    assert.equal(result.isError, undefined);
});

test("the state and questions of each request reach classify unchanged", async () => {
    const harness = createHarness();
    const requests = [choiceRequest("store"), boolRequest("risky"), scoreRequest("urgency")];
    await harness.run({ requests });
    for (const [index, request] of requests.entries()) {
        assert.deepEqual(harness.calls[index].context.state, request.state);
        assert.deepEqual(harness.calls[index].context.questions, request.questions);
        assert.equal(harness.calls[index].context.images, undefined);
    }
    assert.deepEqual(
        harness.calls.map((call) => Object.values(call.context.questions)[0].type),
        ["choice", "bool", "score"],
        "bool reaches classify as bool; the extension does no noul mapping",
    );
});

test("the text content is the JSON of the structured content with no status line", async () => {
    const harness = createHarness();
    const result = await harness.run({ requests: [choiceRequest(), boolRequest()] });
    const text = resultText(result);
    assert.equal(text.startsWith("{"), true);
    assert.deepEqual(JSON.parse(text), result.structuredContent);
    assert.equal(/requests failed/.test(text), false);
});

test("a 20-request batch answers every request and preserves order", async () => {
    const harness = createHarness({
        classify: (context: ClassifierContext) => answer("pick", String((context.state as { index: number }).index)),
    });
    const requests = Array.from({ length: 20 }, (_unused, index) => ({
        state: { index },
        questions: { pick: { type: "choice", instructions: "Pick.", criteria: { a: "A", b: "B" } } },
    }));
    const results = entries(await harness.run({ requests }));
    assert.equal(results.length, 20);
    const picks = results.map((entry) => (entry.ok ? entry.answers.pick : undefined));
    assert.deepEqual(
        picks.map((pick) => (pick && pick.type === "choice" ? pick.choice : undefined)),
        requests.map((_unused, index) => String(index)),
    );
});

test("at most four classify calls run at a time", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    let started = 0;
    const harness = createHarness({
        classify: async (context: ClassifierContext) => {
            started += 1;
            if (started >= 4) release?.();
            await gate;
            return succeed(context);
        },
    });
    await harness.run({ requests: Array.from({ length: 20 }, () => boolRequest()) });
    assert.equal(harness.calls.length, 20);
    assert.equal(harness.maxInFlight(), 4, "four requests run at a time, never more");
});

test("every non-stop stop reason becomes an error entry with the provider message", async () => {
    const harness = createHarness({
        classify: (_context: ClassifierContext, index: number) =>
            index === 0 ? fail("error", "OpenRouter error (429): rate limited") : fail("aborted", "cancelled"),
    });
    const result = await harness.run({ requests: [boolRequest(), boolRequest()] });
    assert.deepEqual(result.structuredContent, {
        results: [
            { ok: false, stopReason: "error", errorMessage: "OpenRouter error (429): rate limited" },
            { ok: false, stopReason: "error", errorMessage: "cancelled" },
        ],
    });
});

test("a failure without a provider message carries the classify error and stop reason", async () => {
    const harness = createHarness({ classify: () => fail("aborted") });
    const [entry] = entries(await harness.run({ requests: [boolRequest()] }));
    if (entry.ok) assert.fail("expected a failure entry");
    assert.equal(entry.stopReason, "error");
    assert.equal(entry.errorMessage, "Classify error (aborted)");
});

test("an all-failure batch is an error result that still carries the entries", async () => {
    const harness = createHarness({ classify: () => fail("error", "no credit") });
    const result = await harness.run({ requests: [boolRequest(), boolRequest()] });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
        results: [
            { ok: false, stopReason: "error", errorMessage: "no credit" },
            { ok: false, stopReason: "error", errorMessage: "no credit" },
        ],
    });
});

test("a partial failure is not an error and carries the status line only in the text", async () => {
    const harness = createHarness({
        classify: (context: ClassifierContext, index: number) =>
            index === 1 ? fail("error", "OpenRouter error (429): rate limited") : succeed(context),
    });
    const result = await harness.run({ requests: [choiceRequest(), boolRequest(), choiceRequest()] });
    const text = resultText(result);
    assert.equal(result.isError, undefined);
    assert.equal(text.split("\n")[0], "1 of 3 requests failed");
    assert.deepEqual(JSON.parse(text.split("\n").slice(1).join("\n")), result.structuredContent);
    assert.equal(JSON.stringify(result.structuredContent).includes("requests failed"), false);
    assert.deepEqual(entries(result).map((entry) => entry.ok), [true, false, true]);
});

test("no entry carries both answers and an error message", async () => {
    const harness = createHarness({
        classify: (context: ClassifierContext, index: number) =>
            index === 0 ? succeed(context) : fail("error", "boom"),
    });
    const result = await harness.run({ requests: [boolRequest(), boolRequest()] });
    for (const entry of entries(result)) {
        assert.equal("answers" in entry && "errorMessage" in entry, false);
    }
});
