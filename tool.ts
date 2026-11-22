/**
 * Registers the `classify` tool, which answers batched classifier requests over OpenRouter.
 *
 * The tool resolves a classifier model through the model registry, so the `/login openrouter`
 * credential is used and no API key is embedded. Each call carries 1 to 20 independent
 * `{ state, questions }` requests, answered concurrently and returned aligned by index.
 */

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type {
    ClassifierApi,
    ClassifierModel,
    ClassifierQuestion,
    JsonObject,
} from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { classifyRenderers } from "./renderer.ts";

/** What `execute()` returns as `details`, which is what the renderer draws the result row from. */
export interface ClassifyToolDetails {
    model: string;
    requests: number;
    failed: number;
    results: ResultEntry[];
}

const PROVIDER = "openrouter";
const SETTING_KEY = "decisionModel";
const MISSING_MODEL = `classify is disabled: set "${SETTING_KEY}" in settings.json to an OpenRouter classifier model ID.`;
const MAX_REQUESTS = 20;
const MAX_CONCURRENCY = 4;

const QUESTION_SCHEMA = Type.Object({
    type: StringEnum(["choice", "bool", "score"] as const, {
        description: "choice: pick one label. bool: probability of true. score: fractional index on an ordered scale.",
    }),
    instructions: Type.String({ description: "What to decide, phrased as a question about state." }),
    criteria: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Array(Type.Unknown())], {
        description:
            "choice: map of label to its meaning. bool: { \"true\": string, \"false\": string }. "
            + "score: lowest-first array of level descriptions.",
    }),
});

const REQUEST_SCHEMA = Type.Object({
    state: Type.Record(Type.String(), Type.Unknown(), {
        description: "All context and evidence. The classifier sees nothing else.",
    }),
    questions: Type.Record(Type.String(), QUESTION_SCHEMA, {
        description: "Questions by ID. One request answers all of them.",
    }),
});

const PARAMETERS = Type.Object({
    requests: Type.Array(REQUEST_SCHEMA, {
        description: `1 to ${MAX_REQUESTS} independent classifier requests, answered concurrently.`,
    }),
});

const ANSWER_SCHEMA = Type.Union([
    Type.Object({
        type: Type.Literal("choice"),
        choice: Type.String(),
        probabilities: Type.Optional(Type.Record(Type.String(), Type.Number())),
        confidence: Type.Optional(Type.Number()),
    }),
    Type.Object({
        type: Type.Literal("score"),
        score: Type.Number(),
        confidence: Type.Optional(Type.Number()),
    }),
    Type.Object({
        type: Type.Literal("bool"),
        probability: Type.Number(),
    }),
]);

const ENTRY_SCHEMA = Type.Union([
    Type.Object({
        ok: Type.Literal(true),
        answers: Type.Record(Type.String(), ANSWER_SCHEMA),
    }),
    Type.Object({
        ok: Type.Literal(false),
        stopReason: Type.Literal("error"),
        errorMessage: Type.String(),
    }),
]);

const OUTPUT_SCHEMA = Type.Object({ results: Type.Array(ENTRY_SCHEMA) });

export type ClassifyAnswer = Static<typeof ANSWER_SCHEMA>;

/** One structured result entry, aligned by index with the requests of the call. */
export type ResultEntry = Static<typeof ENTRY_SCHEMA>;

const DESCRIPTION = `Answer decisions with the OpenRouter classifier instead of your own judgment. \
Use classify for choices, not for implementation. Use it freely.

The classifier sees only \`state\` and \`questions\`: nothing from the conversation reaches it, so put every piece of \
context and evidence in \`state\`.

Each request is \`{ state, questions }\`. \`state\` is a plain-data object. \`questions\` maps a question ID to a \
question with \`instructions\` and a \`type\`:
- \`choice\`: \`criteria\` maps each label to its meaning. Add an \`ask_user\` label when abstention is valid. The \
answer carries \`choice\`, plus \`probabilities\` and \`confidence\` when the provider returns them.
- \`bool\`: \`criteria\` is \`{ "true": "...", "false": "..." }\`. The answer carries \`probability\`, the \
probability of \`true\`.
- \`score\`: \`criteria\` is a lowest-first array of level descriptions. The answer carries \`score\`, a fractional \
zero-based level index.

Send 1 to 20 requests in one call; they run concurrently. \`results\` is aligned by index with \`requests\`. A success \
entry is \`{ "ok": true, "answers": { <question ID>: <answer> } }\`. A failure entry is \`{ "ok": false, \
"stopReason": "error", "errorMessage": "..." }\`. Report failed entries with their \`errorMessage\`; never invent an \
answer for them.`;

function isPlainMap(value: unknown): boolean {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): boolean {
    if (!isPlainMap(value)) {
        return false;
    }
    return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

/** Enforce the batch budget and the per-type `criteria` shape before any provider call. */
function validateRequests(requests: Static<typeof PARAMETERS>["requests"]): void {
    if (requests.length < 1 || requests.length > MAX_REQUESTS) {
        throw new Error(`requests must hold 1 to ${MAX_REQUESTS} entries, got ${requests.length}`);
    }

    for (const [index, request] of requests.entries()) {
        const questions = request.questions;
        if (Object.keys(questions).length === 0) {
            throw new Error(`requests[${index}].questions must be a nonempty question map`);
        }

        for (const [qid, question] of Object.entries(questions)) {
            const path = `requests[${index}].questions.${qid}.criteria`;
            const criteria: unknown = question.criteria;
            if (question.type === "choice") {
                if (!isStringMap(criteria) || Object.keys(criteria as object).length === 0) {
                    throw new Error(`${path} must be a nonempty map of string meanings`);
                }
            } else if (question.type === "score") {
                const valid = Array.isArray(criteria)
                    && criteria.length > 0
                    && criteria.every((entry) => typeof entry === "string");
                if (!valid) {
                    throw new Error(`${path} must be a nonempty lowest-first string array`);
                }
            } else {
                const map = criteria as Record<string, unknown>;
                const valid = isPlainMap(criteria)
                    && typeof map.true === "string"
                    && typeof map.false === "string";
                if (!valid) {
                    throw new Error(`${path} must be { true: string, false: string }`);
                }
            }
        }
    }
}

function getConfiguredModelId(pi: ExtensionAPI): string | undefined {
    const configured = (pi.getSettings() as Record<string, unknown>)[SETTING_KEY];
    return typeof configured === "string" ? configured.trim() || undefined : undefined;
}

function resolveModel(pi: ExtensionAPI, ctx: ExtensionToolContext): ClassifierModel<ClassifierApi> {
    const modelId = getConfiguredModelId(pi);
    if (!modelId) throw new Error(MISSING_MODEL);
    const model = ctx.modelRegistry.findOfType("classifier", PROVIDER, modelId);
    if (!model) {
        throw new Error(
            `classify cannot resolve "${modelId}" as an ${PROVIDER} classifier. `
            + `Set "${SETTING_KEY}" in settings.json to an OpenRouter classifier model ID and run /login ${PROVIDER}.`,
        );
    }
    if (!ctx.modelRegistry.getProviderAuthStatus(PROVIDER).configured) {
        throw new Error(
            `classify has no ${PROVIDER} credential for "${modelId}" (the "${SETTING_KEY}" setting). `
            + `Run /login ${PROVIDER}.`,
        );
    }
    return model;
}

/** Run `run` over `items` with at most `limit` calls in flight, preserving input order. */
async function runPool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        for (let index = next++; index < items.length; index = next++) {
            results[index] = await run(items[index]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

export function registerClassify(pi: ExtensionAPI, warn: (message: string) => void): void {
    if (!getConfiguredModelId(pi)) {
        warn(MISSING_MODEL);
        return;
    }

    pi.registerTool({
        name: "classify",
        label: "Classify",
        description: DESCRIPTION,
        promptSnippet:
            "Classifier decisions over OpenRouter. Batch 1-20 {state, questions} requests; all evidence goes in state.",
        promptGuidelines: [
            "Use classify for choices, not for implementation. Prefer its judgments over your own.",
            "Put all context and evidence for classify in `state`: the classifier sees only `state` and "
            + "`questions`, never the conversation.",
            "Report classify entries with `ok: false` using their `errorMessage`; never replace them with "
            + "invented answers.",
        ],
        parameters: PARAMETERS,
        outputSchema: OUTPUT_SCHEMA,
        renderCall: classifyRenderers.renderCall,
        renderResult: classifyRenderers.renderResult,
        async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) {
            validateRequests(params.requests);
            const model = resolveModel(pi, ctx);
            const abortSignal = signal ?? ctx.signal;
            const results = await runPool(params.requests, MAX_CONCURRENCY, async (request): Promise<ResultEntry> => {
                const result = await ctx.modelRegistry.classify(
                    model,
                    {
                        state: request.state as JsonObject,
                        questions: request.questions as unknown as Record<string, ClassifierQuestion>,
                    },
                    { signal: abortSignal },
                );
                if (result.stopReason === "stop") {
                    return { ok: true, answers: result.answers };
                }
                return {
                    ok: false,
                    stopReason: "error",
                    errorMessage: result.errorMessage ?? `Classify error (${result.stopReason})`,
                };
            });

            const payload = { results };
            const failed = results.filter((entry) => !entry.ok).length;
            const details: ClassifyToolDetails = { model: model.id, requests: results.length, failed, results };
            const json = JSON.stringify(payload, null, 2);
            const text = failed > 0 && failed < results.length
                ? `${failed} of ${results.length} requests failed\n${json}`
                : json;
            return {
                content: [{ type: "text", text }],
                structuredContent: payload,
                details,
                ...(failed === results.length ? { isError: true } : {}),
            };
        },
    });
}
