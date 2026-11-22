import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type { ClassifyAnswer, ClassifyToolDetails, ResultEntry } from "./tool.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
    if (process.platform !== "linux") return;

    const { registerClassify } = await import("./tool.ts");
    pi.on("session_start", (_event, ctx) => {
        registerClassify(pi, (message) => {
            if (ctx.hasUI) ctx.ui.notify(message, "warning");
            else process.stderr.write(`${message}\n`);
        });
    });
}
