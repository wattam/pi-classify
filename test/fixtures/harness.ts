import type { ClassifierAnswer, ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import type {
    AgentToolResult,
    ExtensionAPI,
    ExtensionToolContext,
    ModelRegistry,
    ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerClassify, type ResultEntry } from "../../tool.ts";

export const MODEL_ID = "test/classifier";
export const SETTING_KEY = "decisionModel";

/** One recorded `classify()` call, with the concurrency observed while it ran. */
export interface ClassifyCall {
    context: ClassifierContext;
    signal: AbortSignal | undefined;
    inFlight: number;
}

export type ClassifyStub = (context: ClassifierContext, index: number) => Promise<ClassifierResult> | ClassifierResult;

export interface HarnessOptions {
    /** Effective settings returned by `pi.getSettings()`. */
    settings?: Record<string, unknown>;
    /** Answers each request. Defaults to {@link succeed}. */
    classify?: ClassifyStub;
    /** Model IDs the registry resolves as openrouter classifiers. */
    catalog?: string[];
    /** Whether OpenRouter reports configured authentication. */
    authorized?: boolean;
    /** `ctx.signal` of the tool context. */
    ctxSignal?: AbortSignal;
    /** `signal` parameter passed to `execute()`. */
    executeSignal?: AbortSignal;
}

export interface Harness {
    tool: ToolDefinition;
    calls: ClassifyCall[];
    /** Peak number of concurrent `classify()` calls. */
    maxInFlight: () => number;
    /** Model IDs passed to `modelRegistry.findOfType()`, with the type and provider. */
    lookups: { type: string; provider: string; modelId: string }[];
    settings: Record<string, unknown>;
    run: (params: unknown) => Promise<AgentToolResult<unknown>>;
}

function classifierModel(modelId: string) {
    return {
        id: modelId,
        provider: "openrouter",
        type: "classifier",
        api: "typesafe-system-one",
        name: modelId,
        contextWindow: 32_000,
        input: ["text"],
        cost: { input: 0, output: 0 },
    };
}

function result(
    answers: Record<string, ClassifierAnswer>,
    overrides: Partial<ClassifierResult> = {},
): ClassifierResult {
    return {
        api: "typesafe-system-one",
        provider: "openrouter",
        model: MODEL_ID,
        answers,
        stopReason: "stop",
        timestamp: 0,
        ...overrides,
    } as ClassifierResult;
}

/** A successful result whose answers are derived from the question types, not from the implementation. */
export function succeed(context: ClassifierContext): ClassifierResult {
    const answers: Record<string, ClassifierAnswer> = {};
    for (const [id, question] of Object.entries(context.questions)) {
        if (question.type === "choice") {
            const labels = Object.keys(question.criteria as Record<string, string>);
            answers[id] = { type: "choice", choice: labels[0], probabilities: { [labels[0]]: 1 }, confidence: 0.75 };
        } else if (question.type === "score") {
            answers[id] = { type: "score", score: 1.25, confidence: 0.5 };
        } else {
            answers[id] = { type: "bool", probability: 0.25 };
        }
    }
    return result(answers);
}

/** A failed result with the given stop reason and optional provider message. */
export function fail(stopReason: "error" | "aborted", errorMessage?: string): ClassifierResult {
    return result({}, { stopReason, ...(errorMessage === undefined ? {} : { errorMessage }) });
}

/** Register the tool with a stubbed `ExtensionAPI` and tool context. */
export function createHarness(options: HarnessOptions = {}): Harness {
    const settings = options.settings ?? { [SETTING_KEY]: MODEL_ID };
    const catalog = options.catalog ?? [MODEL_ID];
    const classify = options.classify ?? succeed;
    const calls: ClassifyCall[] = [];
    const lookups: Harness["lookups"] = [];
    let inFlight = 0;
    let peak = 0;
    let index = 0;

    let registered: ToolDefinition | undefined;
    const pi = {
        registerTool: (tool: ToolDefinition) => {
            registered = tool;
        },
        getSettings: () => settings,
    } as unknown as ExtensionAPI;
    registerClassify(pi, (message) => { throw new Error(message); });
    if (!registered) throw new Error("The extension registered no tool");
    const tool = registered;

    const modelRegistry = {
        findOfType: (type: string, provider: string, modelId: string) => {
            lookups.push({ type, provider, modelId });
            if (type !== "classifier" || provider !== "openrouter") return undefined;
            return catalog.includes(modelId) ? classifierModel(modelId) : undefined;
        },
        getProviderAuthStatus(provider: string): ReturnType<ModelRegistry["getProviderAuthStatus"]> {
            return provider === "openrouter" && (options.authorized ?? true)
                ? { configured: true, source: "stored" }
                : { configured: false };
        },
        classify: async (_model: unknown, context: ClassifierContext, callOptions?: { signal?: AbortSignal }) => {
            const call: ClassifyCall = { context, signal: callOptions?.signal, inFlight: 0 };
            calls.push(call);
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            call.inFlight = inFlight;
            try {
                return await classify(context, index++);
            } finally {
                inFlight -= 1;
            }
        },
    };

    const ctx = { modelRegistry, signal: options.ctxSignal } as unknown as ExtensionToolContext;

    return {
        tool,
        calls,
        lookups,
        settings,
        maxInFlight: () => peak,
        run: (params: unknown) => tool.execute("call-1", params as never, options.executeSignal, undefined, ctx),
    };
}

/** A minimal valid request with one `bool` question. */
export function boolRequest(id = "q"): Record<string, unknown> {
    return {
        state: { task: "x" },
        questions: {
            [id]: {
                type: "bool",
                instructions: "Does this change risk data loss?",
                criteria: { true: "Can drop writes", false: "Cannot drop writes" },
            },
        },
    };
}

/** A minimal valid request with one `choice` question. */
export function choiceRequest(id = "store"): Record<string, unknown> {
    return {
        state: { task: "Pick a cache store", evidence: ["Single node"] },
        questions: {
            [id]: {
                type: "choice",
                instructions: "Choose from the evidence.",
                criteria: { redis: "Networked, shared", in_memory: "Process-local" },
            },
        },
    };
}

/** A minimal valid request with one `score` question. */
export function scoreRequest(id = "urgency"): Record<string, unknown> {
    return {
        state: { ticket: "disk full" },
        questions: {
            [id]: { type: "score", instructions: "How urgent is it?", criteria: ["low", "medium", "high"] },
        },
    };
}

/** The `results` array of the structured content of a tool result. */
export function entries(result: AgentToolResult<unknown>): ResultEntry[] {
    const payload = result.structuredContent as { results?: ResultEntry[] } | undefined;
    if (!payload?.results) throw new Error("The tool result carries no structured results");
    return payload.results;
}

/** The text of the first text content block of a tool result. */
export function resultText(result: AgentToolResult<unknown>): string {
    const block = result.content.find((entry) => entry.type === "text");
    if (!block || block.type !== "text") throw new Error("The tool result carries no text content");
    return block.text;
}

/** Run the tool and return the thrown error message. Fails when the call succeeds. */
export async function runAndCatch(harness: Harness, params: unknown): Promise<string> {
    try {
        await harness.run(params);
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error("The call returned instead of throwing");
}
