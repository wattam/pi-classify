import { lstat, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const peers = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"];
/** Agent directory holding this extension: <agentDir>/extensions/pi-classify. */
const agentDir = resolve(root, "..", "..");
const releasesDir = join(agentDir, "install", "releases");

/**
 * Resolve the installed release's node_modules.
 *
 * `install/current-version` always names the running release, so the link survives `pi update`.
 */
async function resolveHostNodeModules() {
    if (process.env.PI_HOST_NODE_MODULES) {
        return resolve(process.env.PI_HOST_NODE_MODULES);
    }

    const versionFile = join(agentDir, "install", "current-version");
    const version = (await readFile(versionFile, "utf8").catch(() => "")).trim();
    if (!version) {
        throw new Error(`Could not read the installed Pi release from ${versionFile}; `
            + "set PI_HOST_NODE_MODULES to the release's node_modules directory");
    }

    return join(releasesDir, version, "node_modules");
}

/** A link this script created earlier points into the agent's releases directory. */
async function isStaleHostLink(local) {
    const target = await realpath(local).catch(() => undefined);
    return target !== undefined && target.startsWith(releasesDir + "/");
}

export async function linkHostPeers() {
    const host = await resolveHostNodeModules();
    for (const name of peers) {
        const target = await realpath(join(host, name));
        const manifest = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
        if (manifest.name !== name || typeof manifest.version !== "string" || !manifest.version) {
            throw new Error(`Invalid host package: ${name}`);
        }
        const local = join(root, "node_modules", name);
        const existing = await lstat(local).catch((error) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
        });
        if (existing) {
            if (!existing.isSymbolicLink()) throw new Error(`Refusing to overwrite local package: ${name}`);
            if (await realpath(local).catch(() => undefined) === target) {
                console.log(`${name} ${manifest.version}`);
                continue;
            }
            if (!(await isStaleHostLink(local))) throw new Error(`Refusing to overwrite local package: ${name}`);
            await rm(local, { force: true });
        }
        await mkdir(dirname(local), { recursive: true });
        await symlink(target, local, "dir");
        console.log(`${name} ${manifest.version}`);
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await linkHostPeers();
}
