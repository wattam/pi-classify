import assert from "node:assert/strict";
import test from "node:test";
import { boolRequest, choiceRequest, createHarness, runAndCatch, scoreRequest } from "../fixtures/harness.ts";

function question(type: string, criteria: unknown): Record<string, unknown> {
    return { state: { a: 1 }, questions: { q: { type, instructions: "Decide.", criteria } } };
}

test("an empty batch fails with the 1 to 20 budget message and calls no provider", async () => {
    const harness = createHarness();
    const message = await runAndCatch(harness, { requests: [] });
    assert.match(message, /1 to 20/);
    assert.equal(harness.calls.length, 0);
});

test("a batch above the budget fails and calls no provider", async () => {
    const harness = createHarness();
    const requests = Array.from({ length: 21 }, () => boolRequest());
    const message = await runAndCatch(harness, { requests });
    assert.match(message, /1 to 20/);
    assert.match(message, /21/);
    assert.equal(harness.calls.length, 0);
});

test("a batch of exactly 20 requests passes validation", async () => {
    const harness = createHarness();
    const result = await harness.run({ requests: Array.from({ length: 20 }, () => boolRequest()) });
    assert.equal(harness.calls.length, 20);
    assert.equal(result.isError, undefined);
});

test("an empty question map fails naming the request index", async () => {
    const harness = createHarness();
    const message = await runAndCatch(harness, { requests: [choiceRequest(), { state: {}, questions: {} }] });
    assert.match(message, /requests\[1\]\.questions/);
    assert.equal(harness.calls.length, 0);
});

test("choice criteria must be a nonempty map of string meanings", async () => {
    const harness = createHarness();
    for (const criteria of [{}, ["redis", "in_memory"], { redis: 1 }]) {
        const message = await runAndCatch(harness, { requests: [question("choice", criteria)] });
        assert.match(message, /requests\[0\]\.questions\.q\.criteria/);
        assert.match(message, /nonempty map of string meanings/);
    }
    assert.equal(harness.calls.length, 0);
});

test("score criteria must be a nonempty lowest-first string array", async () => {
    const harness = createHarness();
    for (const criteria of [{ low: "y" }, [], ["low", 2]]) {
        const message = await runAndCatch(harness, { requests: [question("score", criteria)] });
        assert.match(message, /requests\[0\]\.questions\.q\.criteria/);
        assert.match(message, /nonempty lowest-first string array/);
    }
    assert.equal(harness.calls.length, 0);
});

test("bool criteria must hold string true and false meanings", async () => {
    const harness = createHarness();
    for (const criteria of [{ true: "y" }, { true: "y", false: 2 }, ["y", "z"]]) {
        const message = await runAndCatch(harness, { requests: [question("bool", criteria)] });
        assert.match(message, /requests\[0\]\.questions\.q\.criteria/);
        assert.match(message, /\{ true: string, false: string \}/);
    }
    assert.equal(harness.calls.length, 0);
});

test("bool criteria with extra non-string keys pass validation", async () => {
    const harness = createHarness();
    const criteria = { true: "y", false: "z", note: 1 };
    const result = await harness.run({ requests: [question("bool", criteria)] });
    assert.equal(harness.calls.length, 1);
    assert.equal(result.isError, undefined);
});

test("a later invalid request stops the whole call before any provider call", async () => {
    const harness = createHarness();
    const message = await runAndCatch(harness, {
        requests: [choiceRequest(), boolRequest(), question("score", { low: "y" })],
    });
    assert.match(message, /requests\[2\]\.questions\.q\.criteria/);
    assert.equal(harness.calls.length, 0);
});

test("valid criteria of every type reach the provider", async () => {
    const harness = createHarness();
    const result = await harness.run({ requests: [choiceRequest(), boolRequest(), scoreRequest()] });
    assert.equal(harness.calls.length, 3);
    assert.equal(result.isError, undefined);
});
