/**
 * Presentation for the `classify` tool.
 *
 * The call lists the questions of the batch, one line per question, with its type and the labels or
 * levels it chooses from. The result lists the answers in the same order, with a status icon per
 * request, and closes with the classifier model and how long the batch took. Collapsed rows cap the
 * number of lines and name the key that expands them; expanded rows add instructions, state keys,
 * and per-label probabilities.
 */

import {
    type AgentToolResult,
    type Theme,
    type ToolRenderers,
    type ToolRenderResultOptions,
    truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ClassifyAnswer, ClassifyToolDetails } from "./index.ts";

/** The host does not export `ToolRenderContext`, so it is read back off the renderer signatures. */
export type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

const COLLAPSED_LINES = 8;
const COLLAPSED_TEXT_CHARS = 72;
/** Prefix of a question line of the call. */
const LINE_INDENT = "  ";
/** Prefix of text placed under a line, clear of the longest tag a line starts with. */
const CONTINUATION_INDENT = "      ";

/**
 * One question of the call arguments. The fields stay as wide as the parameter schema yields them,
 * so the renderer is assignable to the host's `renderCall`, and optional because every field may
 * still be missing while the call streams in.
 */
export interface RenderedQuestion {
    type?: unknown;
    instructions?: string;
    criteria?: unknown;
}

/** One request of the call arguments. Every field may still be missing while the call streams in. */
export interface RenderedRequest {
    state?: Record<string, unknown>;
    questions?: Record<string, RenderedQuestion | undefined>;
}

export interface RenderedParams {
    requests?: RenderedRequest[];
}

function truncate(text: string, expanded: boolean): string {
    const flat = text.replace(/\s+/g, " ").trim();
    if (expanded || flat.length <= COLLAPSED_TEXT_CHARS) {
        return flat;
    }
    return `${flat.slice(0, COLLAPSED_TEXT_CHARS - 3)}...`;
}

/**
 * Re-indents model- or provider-supplied text, which may hold newlines, so that a continuation line
 * never falls back to column 0 and merges with the next entry.
 */
function indentLines(text: string, indent: string): string {
    return text.split("\n").join(`\n${indent}`);
}

/** Text placed under a line of the row, with its own lines kept under the same indent. */
function continuation(text: string): string {
    return CONTINUATION_INDENT + indentLines(text, CONTINUATION_INDENT);
}

function percent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

/**
 * The row's clock, kept in `ToolRenderContext.state`. The host's `startToolTimer`/`toolTimerText`
 * are internal to the release, so the row keeps the same state shape and behavior itself.
 */
interface TimerState {
    startedAt?: number;
    endedAt?: number;
    interval?: ReturnType<typeof setInterval>;
}

/** Start the row's clock once execution starts. Called from `renderCall`. */
function startTimer(context: ToolRenderContext): void {
    const state = context.state as TimerState;
    if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
    }
}

/**
 * The row's timing line: `Elapsed 4.2s` while the result is partial, redrawn every second, and
 * `Took 4.2s` once it is final. Undefined when the row has neither a start time nor a recorded
 * duration.
 */
function timerText(context: ToolRenderContext, isPartial: boolean): string | undefined {
    const state = context.state as TimerState;
    if (state.startedAt !== undefined && isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
    }
    if (!isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
            clearInterval(state.interval);
            state.interval = undefined;
        }
    }
    // A final result's recorded duration wins: it is monotonic and survives reloads. The row's own
    // clock is the fallback for live progress and for results stored without one.
    if (!isPartial && context.durationMs !== undefined) {
        return `Took ${formatDuration(context.durationMs)}`;
    }
    if (state.startedAt === undefined) {
        return undefined;
    }
    return `${isPartial ? "Elapsed" : "Took"} ${formatDuration((state.endedAt ?? Date.now()) - state.startedAt)}`;
}

/** The host's tool-row duration format: `4.2s` below a minute, then `1m 30s` and `2h 3m 4s`. */
function formatDuration(ms: number): string {
    const seconds = ms / 1000;
    if (seconds < 60) {
        return `${seconds.toFixed(1)}s`;
    }
    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const remainder = totalSeconds % 60;
    if (minutes < 60) {
        return `${minutes}m ${remainder}s`;
    }
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/**
 * Labels of a `choice` question, levels of a `score` question, and the `true` then `false` meanings
 * of a `bool` one. A `bool` question's keys are always `true` and `false`, so its meanings are the
 * only part worth drawing.
 */
export function criteriaLabels(question: RenderedQuestion | undefined): string[] {
    const criteria: unknown = question?.criteria;
    if (Array.isArray(criteria)) {
        return criteria.map((entry, index) => (typeof entry === "string" ? entry : `level ${index}`));
    }
    if (typeof criteria !== "object" || criteria === null) {
        return [];
    }
    const map = criteria as Record<string, unknown>;
    if (question?.type === "bool" && typeof map.true === "string" && typeof map.false === "string") {
        return [map.true, map.false];
    }
    return Object.keys(map);
}

/** `#<n>` when the batch holds several requests, so single-request calls stay quiet. */
function requestTag(index: number, total: number): string {
    return total > 1 ? `#${index + 1} ` : "";
}

/** One answer as plain text, without theme colors, so tests can assert on it. */
export function formatAnswer(
    answer: ClassifyAnswer,
    question: RenderedQuestion | undefined,
    expanded: boolean,
): string {
    if (answer.type === "bool") {
        const verdict = answer.probability >= 0.5 ? "true" : "false";
        return `${verdict} (p=${percent(answer.probability)})`;
    }
    if (answer.type === "score") {
        const levels = criteriaLabels(question);
        const level = levels[Math.round(answer.score)];
        // A one-level scale has no range to divide by, so it prints the bare score.
        const scale = levels.length > 1 ? `${answer.score.toFixed(2)}/${levels.length - 1}` : answer.score.toFixed(2);
        const named = level ? `${scale} ${level}` : scale;
        return answer.confidence === undefined ? named : `${named} (${percent(answer.confidence)})`;
    }
    let text = answer.choice;
    if (answer.confidence !== undefined) {
        text += ` (${percent(answer.confidence)})`;
    }
    if (expanded && answer.probabilities) {
        const ranked = Object.entries(answer.probabilities)
            .sort(([, a], [, b]) => b - a)
            .map(([label, probability]) => `${label} ${percent(probability)}`);
        if (ranked.length > 0) {
            text += `\n${continuation(ranked.join(", "))}`;
        }
    }
    return text;
}

/**
 * Collapsed output capped at {@link COLLAPSED_LINES} wrapped lines, like the host's tool rows, with
 * a last line naming the key that shows the rest. Capping logical lines instead would let a single
 * long answer wrap over the whole row. Caches its lines per width: tool rows redraw every frame.
 */
class LinePreview implements Component {
    private cachedWidth: number | undefined;
    private cachedLines: readonly string[] | undefined;
    private readonly text: string;
    private readonly formatHint: (hidden: number) => string;

    constructor(text: string, formatHint: (hidden: number) => string) {
        this.text = text;
        this.formatHint = formatHint;
    }

    render(width: number): readonly string[] {
        if (this.cachedLines === undefined || this.cachedWidth !== width) {
            const preview = truncateToVisualLines(this.text, COLLAPSED_LINES, width, 0, "start");
            this.cachedLines = preview.skippedCount > 0
                ? [...preview.visualLines, truncateToWidth(this.formatHint(preview.skippedCount), width, "...")]
                : preview.visualLines;
            this.cachedWidth = width;
        }
        return this.cachedLines;
    }

    invalidate(): void {
        this.cachedLines = undefined;
        this.cachedWidth = undefined;
    }
}

/** The row's lines, capped while collapsed. */
function addLines(
    component: Container,
    lines: string[],
    expanded: boolean,
    theme: Theme,
    context: ToolRenderContext,
): void {
    const text = lines.join("\n");
    if (expanded) {
        component.addChild(new Text(text, 0, 0));
        return;
    }
    const hint = (hidden: number) =>
        `${theme.fg("muted", `... (${hidden} more lines,`)} `
        + `${context.keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
    component.addChild(new LinePreview(text, hint));
}

/** The row's closing line: a blank line and the muted parts that are set, joined by two spaces. */
function addFooter(component: Container, theme: Theme, parts: Array<string | undefined>): void {
    const text = parts.filter((part): part is string => part !== undefined && part.length > 0).join("  ");
    if (text.length === 0) {
        return;
    }
    component.addChild(new Spacer(1));
    component.addChild(new Text(theme.fg("muted", text), 0, 0));
}

export const classifyRenderers = {
    renderCall(args: RenderedParams, theme: Theme, context: ToolRenderContext): Container {
        startTimer(context);
        const component = (context.lastComponent as Container | undefined) ?? new Container();
        component.clear();

        const requests = Array.isArray(args?.requests) ? args.requests : [];
        let title = theme.fg("toolTitle", theme.bold("classify"));
        if (requests.length > 0) {
            title += theme.fg("muted", ` ${requests.length} request${requests.length === 1 ? "" : "s"}`);
        }
        component.addChild(new Text(title, 0, 0));

        const lines: string[] = [];
        for (const [index, request] of requests.entries()) {
            const questions = request?.questions ?? {};
            for (const [qid, question] of Object.entries(questions)) {
                const labels = criteriaLabels(question);
                let line = `${LINE_INDENT}${theme.fg("muted", requestTag(index, requests.length))}`;
                line += theme.fg("accent", qid);
                line += theme.fg("dim", ` ${typeof question?.type === "string" ? question.type : "?"}`);
                if (labels.length > 0) {
                    line += theme.fg("muted", `: ${truncate(labels.join(" | "), context.expanded)}`);
                }
                if (context.expanded && question?.instructions) {
                    line += `\n${theme.fg("dim", continuation(question.instructions))}`;
                }
                lines.push(line);
            }
            // The state belongs to the request, so it follows its questions instead of each of them.
            const keys = context.expanded ? Object.keys(request?.state ?? {}) : [];
            if (keys.length > 0) {
                lines.push(theme.fg("dim", continuation(`state: ${keys.join(", ")}`)));
            }
        }
        if (lines.length > 0) {
            addLines(component, lines, context.expanded, theme, context);
        }
        return component;
    },

    renderResult(
        result: AgentToolResult<ClassifyToolDetails>,
        options: ToolRenderResultOptions,
        theme: Theme,
        context: ToolRenderContext,
    ): Container {
        const timing = timerText(context, options.isPartial);
        const component = (context.lastComponent as Container | undefined) ?? new Container();
        component.clear();

        if (options.isPartial) {
            component.addChild(new Spacer(1));
            component.addChild(new Text(theme.fg("warning", "Deciding..."), 0, 0));
            addFooter(component, theme, [timing]);
            return component;
        }

        const details = result.details;
        const entries = details?.results ?? [];
        if (entries.length === 0) {
            const text = result.content.find((part) => part.type === "text")?.text.trim() ?? "";
            if (text) {
                component.addChild(new Spacer(1));
                // The raw payload runs to hundreds of lines for a large batch, so it is capped like
                // the answer lines instead of being drawn whole.
                const colored = theme.fg(context.isError ? "error" : "toolOutput", text);
                addLines(component, [colored], options.expanded, theme, context);
            }
            addFooter(component, theme, [timing]);
            return component;
        }

        const requests = Array.isArray((context.args as RenderedParams)?.requests)
            ? (context.args as RenderedParams).requests!
            : [];
        const lines: string[] = [];
        for (const [index, entry] of entries.entries()) {
            const tag = theme.fg("muted", requestTag(index, entries.length));
            if (!entry.ok) {
                const message = indentLines(entry.errorMessage, CONTINUATION_INDENT);
                lines.push(`${theme.fg("error", "\u2717")} ${tag}${theme.fg("error", message)}`);
                continue;
            }
            for (const [qid, answer] of Object.entries(entry.answers)) {
                const question = requests[index]?.questions?.[qid];
                const text = formatAnswer(answer, question, options.expanded);
                lines.push(
                    `${theme.fg("success", "\u2713")} ${tag}${theme.fg("accent", qid)} `
                    + `${theme.fg("muted", "\u2192")} ${theme.fg("toolOutput", text)}`,
                );
            }
        }
        if (lines.length > 0) {
            component.addChild(new Spacer(1));
            addLines(component, lines, options.expanded, theme, context);
        }

        addFooter(component, theme, [
            details?.model,
            details?.failed ? `${details.failed} of ${entries.length} failed` : undefined,
            timing,
        ]);
        return component;
    },
};
