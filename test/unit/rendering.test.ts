import assert from "node:assert/strict";
import test from "node:test";
import type { ClassifierQuestion } from "@earendil-works/pi-ai";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { ClassifyToolDetails } from "../../index.ts";
import {
    classifyRenderers,
    formatAnswer,
    type RenderedParams,
    type RenderedRequest,
    type ToolRenderContext,
} from "../../renderer.ts";
import { MODEL_ID, boolRequest, choiceRequest, createHarness, scoreRequest } from "../fixtures/harness.ts";

/** A theme that returns its text unchanged, so assertions read the plain lines. */
const theme = {
    fg: (_token: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme;

function context(args: RenderedParams, overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
    return {
        args,
        toolCallId: "call-1",
        invalidate: () => {},
        lastComponent: undefined,
        state: {},
        cwd: process.cwd(),
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded: false,
        showImages: false,
        isError: false,
        durationMs: 450,
        outputPad: 0,
        keyText: () => "ctrl+e",
        keyHint: (_id: string, description: string) => `ctrl+e ${description}`,
        ...overrides,
    } as unknown as ToolRenderContext;
}

const params: RenderedParams = {
    requests: [
        {
            state: { incident: "disk full", host: "db-1" },
            questions: {
                verdict: {
                    type: "choice",
                    instructions: "Pick the response.",
                    criteria: { page: "Wake somebody", wait: "Leave it" },
                },
            },
        },
        {
            state: { incident: "disk full" },
            questions: {
                severity: { type: "score", instructions: "Rate it.", criteria: ["low", "medium", "high"] },
            },
        },
    ],
};

function result(details: ClassifyToolDetails, text = "{}"): AgentToolResult<ClassifyToolDetails> {
    return { content: [{ type: "text", text }], details } as AgentToolResult<ClassifyToolDetails>;
}

function render(component: { render: (width: number) => readonly string[] }): string {
    return component.render(120).join("\n");
}

test("the call lists every question with its type and labels", () => {
    const output = render(classifyRenderers.renderCall(params, theme, context(params)));
    assert.match(output, /classify 2 requests/);
    assert.match(output, /#1 verdict choice: page \| wait/);
    assert.match(output, /#2 severity score: low \| medium \| high/);
    assert.doesNotMatch(output, /Pick the response\./, "instructions stay hidden while collapsed");
});

test("a bool question lists its true and false meanings instead of the constant keys", () => {
    const bool: RenderedParams = {
        requests: [
            {
                state: {},
                questions: {
                    risky: { type: "bool", instructions: "?", criteria: { true: "ships today", false: "blocked" } },
                },
            },
        ],
    };
    const output = render(classifyRenderers.renderCall(bool, theme, context(bool)));
    assert.match(output, /risky bool: ships today \| blocked/);
});

test("the expanded call adds instructions and state keys", () => {
    const output = render(classifyRenderers.renderCall(params, theme, context(params, { expanded: true })));
    assert.match(output, /Pick the response\./);
    assert.match(output, /state: incident, host/);
});

test("the expanded call lists the state keys once per request", () => {
    const bool = (id: string) => [id, { type: "bool", instructions: "?", criteria: { true: "y", false: "n" } }];
    const many: RenderedParams = {
        requests: [
            {
                state: { incident: "disk full" },
                questions: Object.fromEntries([bool("a"), bool("b"), bool("c")]) as RenderedRequest["questions"],
            },
        ],
    };
    const output = render(classifyRenderers.renderCall(many, theme, context(many, { expanded: true })));
    assert.equal(output.match(/state: incident/g)?.length, 1);
});

test("a single-request call drops the request tag", () => {
    const single: RenderedParams = { requests: [params.requests![0]] };
    const output = render(classifyRenderers.renderCall(single, theme, context(single)));
    assert.match(output, /classify 1 request\b/);
    assert.doesNotMatch(output, /#1/);
});

test("the result lists one line per answer and a model footer", () => {
    const details: ClassifyToolDetails = {
        model: "test/footer-model",
        requests: 2,
        failed: 0,
        results: [
            {
                ok: true,
                answers: {
                    verdict: { type: "choice", choice: "page", probabilities: { page: 0.87 }, confidence: 0.87 },
                },
            },
            { ok: true, answers: { severity: { type: "score", score: 1.6, confidence: 0.5 } } },
        ],
    };
    const output = render(
        classifyRenderers.renderResult(result(details), { expanded: false, isPartial: false }, theme, context(params)),
    );
    assert.match(output, /#1 verdict → page \(87%\)/);
    assert.match(output, /#2 severity → 1\.60\/2 high \(50%\)/);
    assert.match(output, /test\/footer-model {2}Took 0\.5s/);
    assert.equal(output.split("\n")[0], "", "the result body opens with the blank line the host rows use");
});

test("a failed entry shows its error message and the failure count", () => {
    const details: ClassifyToolDetails = {
        model: "m",
        requests: 1,
        failed: 1,
        results: [{ ok: false, stopReason: "error", errorMessage: "rate limited" }],
    };
    const output = render(
        classifyRenderers.renderResult(result(details), { expanded: false, isPartial: false }, theme, context(params)),
    );
    assert.match(output, /rate limited/);
    assert.match(output, /1 of 1 failed/);
});

test("a partial result renders a running label and the elapsed time", (t) => {
    const details: ClassifyToolDetails = { model: "m", requests: 1, failed: 0, results: [] };
    const ctx = context(params, { durationMs: undefined });
    classifyRenderers.renderCall(params, theme, ctx);
    // Stop the redraw interval the partial row starts, even when an assertion below throws.
    t.after(() => classifyRenderers.renderResult(result(details), { expanded: true, isPartial: false }, theme, ctx));
    const component = classifyRenderers.renderResult(
        result(details),
        { expanded: true, isPartial: true },
        theme,
        ctx,
    );
    const output = render(component);
    assert.equal(output.split("\n")[0], "", "the partial body opens with the blank line the host rows use");
    assert.match(output, /Deciding\.\.\./);
    assert.match(output, /Elapsed \d+\.\ds/);
});

test("a final result without a recorded duration falls back to the row's own clock", () => {
    const details: ClassifyToolDetails = { model: "m", requests: 1, failed: 0, results: [{ ok: true, answers: {} }] };
    const ctx = context(params, { durationMs: undefined });
    classifyRenderers.renderCall(params, theme, ctx);
    const output = render(
        classifyRenderers.renderResult(result(details), { expanded: false, isPartial: false }, theme, ctx),
    );
    assert.match(output, /Took \d+\.\ds/);
});

test("a row whose execution never started shows no timing", () => {
    const details: ClassifyToolDetails = { model: "m", requests: 1, failed: 0, results: [{ ok: true, answers: {} }] };
    const ctx = context(params, { durationMs: undefined, executionStarted: false });
    classifyRenderers.renderCall(params, theme, ctx);
    const output = render(
        classifyRenderers.renderResult(result(details), { expanded: false, isPartial: false }, theme, ctx),
    );
    assert.doesNotMatch(output, /Took|Elapsed/);
});

test("a result without details falls back to the text content", () => {
    const output = render(
        classifyRenderers.renderResult(
            { content: [{ type: "text", text: "raw output" }] } as AgentToolResult<ClassifyToolDetails>,
            { expanded: false, isPartial: false },
            theme,
            context(params),
        ),
    );
    assert.match(output, /raw output/);
    assert.equal(output.split("\n")[0], "", "the text fallback opens with the blank line the host rows use");
});

test("the collapsed text fallback caps the raw payload", () => {
    const payload = Array.from({ length: 30 }, (_unused, index) => `line ${index}`).join("\n");
    const lines = classifyRenderers
        .renderResult(
            { content: [{ type: "text", text: payload }] } as AgentToolResult<ClassifyToolDetails>,
            { expanded: false, isPartial: false },
            theme,
            context(params),
        )
        .render(120);
    const body = lines.slice(1, -2);
    assert.equal(body.length, 9, "eight capped payload lines and the expand hint");
    assert.match(body.at(-1)!, /\.\.\. \(22 more lines, ctrl\+e to expand\)/);
});

test("the expanded text fallback keeps the whole raw payload", () => {
    const payload = Array.from({ length: 30 }, (_unused, index) => `line ${index}`).join("\n");
    const lines = classifyRenderers
        .renderResult(
            { content: [{ type: "text", text: payload }] } as AgentToolResult<ClassifyToolDetails>,
            { expanded: true, isPartial: false },
            theme,
            context(params),
        )
        .render(120);
    assert.equal(lines.slice(1, -2).length, 30);
});

test("the collapsed result caps its answer lines and names the expand key", () => {
    const details: ClassifyToolDetails = {
        model: "m",
        requests: 12,
        failed: 0,
        results: Array.from({ length: 12 }, () => ({
            ok: true as const,
            answers: { verdict: { type: "bool" as const, probability: 0.9 } },
        })),
    };
    const lines = classifyRenderers
        .renderResult(result(details), { expanded: false, isPartial: false }, theme, context(params))
        .render(120);
    const body = lines.slice(1, -2);
    assert.equal(body.length, 9, "eight capped answer lines and the expand hint");
    assert.match(body.at(-1)!, /\.\.\. \(4 more lines, ctrl\+e to expand\)/);
});

test("the expanded result keeps every answer line", () => {
    const details: ClassifyToolDetails = {
        model: "m",
        requests: 12,
        failed: 0,
        results: Array.from({ length: 12 }, () => ({
            ok: true as const,
            answers: { verdict: { type: "bool" as const, probability: 0.9 } },
        })),
    };
    const lines = classifyRenderers
        .renderResult(result(details), { expanded: true, isPartial: false }, theme, context(params))
        .render(120);
    assert.equal(lines.slice(1, -2).length, 12);
});

test("the footer rolls durations over to minutes like the host rows", () => {
    const details: ClassifyToolDetails = { model: "m", requests: 1, failed: 0, results: [{ ok: true, answers: {} }] };
    const output = render(
        classifyRenderers.renderResult(
            result(details),
            { expanded: false, isPartial: false },
            theme,
            context(params, { durationMs: 95_000 }),
        ),
    );
    assert.match(output, /Took 1m 35s/);
    assert.equal(output.split("\n").length, 2, "an answerless result renders the spacer and the footer only");
});

test("bool answers name the verdict and its probability", () => {
    const question: ClassifierQuestion = {
        type: "bool",
        instructions: "?",
        criteria: { true: "yes", false: "no" },
    };
    assert.equal(formatAnswer({ type: "bool", probability: 0.82 }, question, false), "true (p=82%)");
    assert.equal(formatAnswer({ type: "bool", probability: 0.2 }, question, false), "false (p=20%)");
});

test("expanded choice answers rank the per-label probabilities", () => {
    const answer = {
        type: "choice" as const,
        choice: "page",
        probabilities: { wait: 0.3, page: 0.7 },
        confidence: 0.7,
    };
    assert.equal(formatAnswer(answer, undefined, false), "page (70%)");
    assert.match(formatAnswer(answer, undefined, true), /page 70%, wait 30%/);
});

test("a question missing from still-streaming arguments renders without throwing", () => {
    const partial = { requests: [{ questions: { verdict: undefined } }, undefined] } as unknown as RenderedParams;
    const output = render(
        classifyRenderers.renderCall(partial, theme, context(partial, { argsComplete: false })),
    );
    assert.match(output, /classify 2 requests/);
    assert.match(output, /verdict \?/);
});

test("collapsed output caps the lines and names the expand key", () => {
    const requests = Array.from({ length: 12 }, (_, index) => ({
        state: {},
        questions: { [`q${index}`]: { type: "bool" as const, instructions: "?", criteria: { true: "y", false: "n" } } },
    }));
    const many: RenderedParams = { requests };
    const output = render(classifyRenderers.renderCall(many, theme, context(many)));
    assert.match(output, /\.\.\. \(4 more lines, ctrl\+e to expand\)/);
});

test("the collapsed cap counts wrapped lines, not entries", () => {
    const requests = Array.from({ length: 6 }, (_, index) => ({
        state: {},
        questions: {
            [`q${index}`]: {
                type: "choice" as const,
                instructions: "?",
                criteria: Object.fromEntries(Array.from({ length: 12 }, (_unused, label) => [`label${label}`, "x"])),
            },
        },
    }));
    const wide: RenderedParams = { requests };
    // Every question wraps over two lines at this width, so six entries are more than eight lines.
    const lines = classifyRenderers.renderCall(wide, theme, context(wide)).render(40);
    assert.equal(lines.length, 10, "the title, eight capped lines, and the expand hint");
    assert.match(lines.at(-1)!, /\.\.\. \(\d+ more lines, ctrl\+e to expand\)/);
});

test("the details of an executed call render as answers", async () => {
    const harness = createHarness();
    const requests = [choiceRequest("store"), boolRequest("risky"), scoreRequest("urgency")];
    const executed = (await harness.run({ requests })) as AgentToolResult<ClassifyToolDetails>;
    assert.deepEqual(
        { model: executed.details.model, requests: executed.details.requests, failed: executed.details.failed },
        { model: MODEL_ID, requests: 3, failed: 0 },
    );
    const args = { requests } as unknown as RenderedParams;
    const output = render(
        classifyRenderers.renderResult(executed, { expanded: false, isPartial: false }, theme, context(args)),
    );
    assert.match(output, /#1 store → redis \(75%\)/);
    assert.match(output, /#2 risky → false \(p=25%\)/);
    assert.match(output, /#3 urgency → 1\.25\/2 medium \(50%\)/);
});

test("multi-line instructions stay indented under their question line", () => {
    const multiline: RenderedParams = {
        requests: [
            {
                state: {},
                questions: {
                    verdict: {
                        type: "bool",
                        instructions: "First line.\nSecond line.",
                        criteria: { true: "y", false: "n" },
                    },
                },
            },
        ],
    };
    const lines = classifyRenderers
        .renderCall(multiline, theme, context(multiline, { expanded: true }))
        .render(120);
    assert.deepEqual(lines.slice(-2).map((line) => line.trimEnd()), ["      First line.", "      Second line."]);
});

test("a multi-line error message stays indented under its status icon", () => {
    const details: ClassifyToolDetails = {
        model: "m",
        requests: 1,
        failed: 1,
        results: [{ ok: false, stopReason: "error", errorMessage: "rate limited\nretry later" }],
    };
    const lines = classifyRenderers
        .renderResult(result(details), { expanded: true, isPartial: false }, theme, context(params))
        .render(120);
    assert.deepEqual(lines.slice(1, 3).map((line) => line.trimEnd()), ["✗ rate limited", "      retry later"]);
});

test("a one-level score scale prints the bare score", () => {
    const question: ClassifierQuestion = { type: "score", instructions: "?", criteria: ["only"] };
    assert.equal(formatAnswer({ type: "score", score: 0 }, question, false), "0.00 only");
});
