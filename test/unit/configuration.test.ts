import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_ID, SETTING_KEY, boolRequest, createHarness, runAndCatch } from "../fixtures/harness.ts";

const OTHER_MODEL_ID = "test/other-classifier";

test("the tool looks up the configured OpenRouter classifier ID", async () => {
    const harness = createHarness({ settings: { [SETTING_KEY]: ` ${OTHER_MODEL_ID} ` }, catalog: [OTHER_MODEL_ID] });
    await harness.run({ requests: [boolRequest()] });
    assert.deepEqual(harness.lookups, [{ type: "classifier", provider: "openrouter", modelId: OTHER_MODEL_ID }]);
});

test("the setting is read on every call", async () => {
    const harness = createHarness({ catalog: [MODEL_ID, OTHER_MODEL_ID] });
    await harness.run({ requests: [boolRequest()] });
    harness.settings[SETTING_KEY] = OTHER_MODEL_ID;
    await harness.run({ requests: [boolRequest()] });
    assert.deepEqual(harness.lookups.map((lookup) => lookup.modelId), [MODEL_ID, OTHER_MODEL_ID]);
});

test("clearing decisionModel after registration prevents model lookup and execution", async () => {
    const harness = createHarness();
    delete harness.settings[SETTING_KEY];
    const message = await runAndCatch(harness, { requests: [boolRequest()] });
    assert.match(message, /decisionModel.*settings\.json/);
    assert.deepEqual(harness.lookups, []);
    assert.deepEqual(harness.calls, []);
});

test("an unresolvable model throws and returns no results", async () => {
    const harness = createHarness({ settings: { [SETTING_KEY]: "test/missing-classifier" }, catalog: [] });
    const message = await runAndCatch(harness, { requests: [boolRequest()] });
    assert.match(message, /test\/missing-classifier/);
    assert.match(message, /decisionModel/);
    assert.match(message, /\/login openrouter/);
    assert.equal(/"?results"?\s*[:[]/.test(message), false, "the message is not a classifier answer");
    assert.equal(harness.calls.length, 0);
});

test("a missing openrouter credential throws before any provider call", async () => {
    const harness = createHarness({ authorized: false });
    const message = await runAndCatch(harness, { requests: [boolRequest()] });
    assert.match(message, /openrouter/);
    assert.match(message, /\/login openrouter/);
    assert.match(message, /decisionModel/);
    assert.ok(message.includes(MODEL_ID));
    assert.equal(harness.calls.length, 0);
});

test("classify receives the execute signal when it is defined", async () => {
    const executeSignal = new AbortController().signal;
    const ctxSignal = new AbortController().signal;
    const harness = createHarness({ executeSignal, ctxSignal });
    await harness.run({ requests: [boolRequest(), boolRequest()] });
    assert.deepEqual(harness.calls.map((call) => call.signal), [executeSignal, executeSignal]);
});

test("classify falls back to the context signal when execute gets none", async () => {
    const ctxSignal = new AbortController().signal;
    const harness = createHarness({ ctxSignal });
    await harness.run({ requests: [boolRequest()] });
    assert.equal(harness.calls[0].signal, ctxSignal);
});

test("classify gets no signal when neither the call nor the context has one", async () => {
    const harness = createHarness();
    await harness.run({ requests: [boolRequest()] });
    assert.equal(harness.calls[0].signal, undefined);
});
