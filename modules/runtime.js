"use strict";

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

// Processes: podman/docker, the configured terminal (or a fallback), and watch -x.
// The only shell scripts hold the terminal open or select a shell inside the container.
// Terminals probed in order when the configured terminal is not installed.
const TERMINAL_FALLBACKS = ["ptyxis --", "kgx --", "gnome-terminal --", "xterm -e"];

// Runs inside the container: prefer SHELL, then the user's passwd entry, then /bin/sh.
// id, grep and cut are container commands; no container data is inserted into the script.
const CONTAINER_SHELL_SCRIPT = 's=${SHELL:-$(grep "^$(id -un):" /etc/passwd 2>/dev/null | cut -d: -f7)}; exec "${s:-/bin/sh}"';

Gio._promisify(Gio.Subprocess.prototype,
    "communicate_utf8_async", "communicate_utf8_finish");
Gio._promisify(Gio.InputStream.prototype,
    "read_bytes_async", "read_bytes_finish");

// Per-runtime state. Keeping command and version together means a runtime
// switch cannot leak a Podman version or parser choice into a Docker request.
const runtimeStates = new Map();
let runtimeCmd;

function getRuntimeState(cmd) {
    let state = runtimeStates.get(cmd);
    if (!state) {
        state = {cmd, version: undefined, discovery: null, cancellable: new Gio.Cancellable(), processes: new Set()};
        runtimeStates.set(cmd, state);
    }
    return state;
}

export function setRuntime(cmd) {
    // Keep the executable restricted to the two runtimes supported by the schema.
    if (cmd !== "podman" && cmd !== "docker")
        throw new Error(`Unsupported container runtime: ${cmd}`);
    reset();
    runtimeCmd = cmd;
}

export function reset() {
    for (const state of runtimeStates.values()) {
        state.cancellable.cancel();
        for (const process of state.processes)
            process.force_exit();
        state.processes.clear();
    }
    runtimeStates.clear();
    runtimeCmd = null;
}

async function discoverRuntimeVersion(state) {
    try {
        const out = await spawnArgv([state.cmd, "version", "--format", "json"], state);
        const versionJson = JSON.parse(out);
        const versionString = versionJson?.Client?.Version;
        if (versionString)
            state.version = new Version(versionString);
    } catch (e) {
        if (!state.cancellable.is_cancelled())
            logError(e, `Error getting ${state.cmd} version`);
    }
}

async function ensureRuntimeVersion(state) {
    if (state.version !== undefined)
        return;

    if (!state.discovery)
        state.discovery = discoverRuntimeVersion(state);
    await state.discovery;
}

export async function getContainers(settings) {
    const state = getRuntimeState(runtimeCmd);
    await ensureRuntimeVersion(state);
    state.cancellable.set_error_if_cancelled();

    const sortBy = settings.get_string("sort-by");
    // Only known sort fields may be passed to Podman or used for Docker sorting.
    if (!Object.hasOwn(SORT_KEYS, sortBy))
        throw new Error(`Unsupported container sort field: ${sortBy}`);
    const isDocker = state.cmd === "docker";
    // Genuine Docker has no `--sort` flag and emits one JSON object per line.
    const argv = isDocker
        ? [state.cmd, "ps", "-a", "--format", "json"]
        : [state.cmd, "ps", "-a", "--sort", sortBy, "--format", "json"];

    let rows;
    try {
        const out = await spawnArgv(argv, state);
        rows = parseContainerRows(out);
    } catch (e) {
        if (!state.cancellable.is_cancelled())
            logError(e, `Error fetching containers from ${state.cmd}`);
        throw e;
    }

    const containers = rows.map(json => new Container(settings, state, json));
    return isDocker ? sortContainers(containers, sortBy) : containers;
}

function parseContainerRows(out) {
    const text = out.trim();
    if (text === "")
        return [];

    // Podman returns a JSON array; Docker returns newline-delimited objects.
    if (text.startsWith("[")) {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [parsed];
    }

    return text
        .split("\n")
        .map(line => line.trim())
        .filter(line => line !== "")
        .map(line => JSON.parse(line));
}

const SORT_KEYS = {
    command: "command",
    created: "createdAt",
    id: "id",
    image: "image",
    names: "name",
    runningfor: "runningFor",
    size: "size",
    status: "status",
};

function sortContainers(containers, sortBy) {
    const key = SORT_KEYS[sortBy] ?? "createdAt";
    const collator = new Intl.Collator(undefined, {numeric: true, sensitivity: "base"});
    return [...containers].sort((a, b) => {
        const av = a[key];
        const bv = b[key];
        if (av === undefined || av === null)
            return bv === undefined || bv === null ? 0 : 1;
        if (bv === undefined || bv === null)
            return -1;
        return collator.compare(String(av), String(bv));
    });
}

class Container {
    constructor(settings, state, json) {
        this.terminal = settings.get_string("terminal");
        this.runtimeCmd = state.cmd;
        this._runtimeState = state;

        const isDocker = state.cmd === "docker";

        if (isDocker) {
            this.name = typeof json.Names === "string" ? json.Names : json.Names?.[0];
            this.id = json.ID || json.Id;
            this.state = json.State || json.Status;
            this.status = json.State || json.Status;
            this.createdAt = json.CreatedAt || json.Created;
            this.image = json.Image;
            this.command = json.Command || json.Cmd;
            this.startedAt = json.StartedAt ? new Date(json.StartedAt * 1000) : null;
            this.ports = json.Ports || "n/a";
            this.runningFor = json.RunningFor;
            this.size = json.Size;
        } else {
            if (state.version && state.version.newerOrEqualTo("2.0.3")) {
                this.name = json.Names?.[0];
                this.id = json.Id;
                this.state = json.State;
                this.status = json.State;
                this.createdAt = json.CreatedAt;
            } else {
                this.name = json.Names;
                this.id = json.ID;
                this.state = json.Status;
                this.status = json.Status;
                this.createdAt = json.Created;
            }
            this.image = json.Image;
            this.command = json.Cmd || json.Command;
            this.entrypoint = json.Entrypoint || json.entrypoint;
            if (Array.isArray(this.entrypoint))
                this.entrypoint = this.entrypoint.join(" ");
            if (Array.isArray(this.command))
                this.command = this.command.join(" ");
            this.startedAt = json.StartedAt ? new Date(json.StartedAt * 1000) : null;
            if (!json.Ports || json.Ports === "")
                this.ports = "n/a";
            else
                this.ports = json.Ports?.map(e => `host ${e.host_ip}:${e.host_port}/${e.protocol} -> pod ${e.container_port}`).join(", ");
            this.runningFor = json.RunningFor;
            this.size = json.Size;
        }
    }

    start()   { return runCommand(this._runtimeState, [this.runtimeCmd, "start", this.name]); }
    stop()    { return runCommand(this._runtimeState, [this.runtimeCmd, "stop", this.name]); }
    rm()      { return runCommand(this._runtimeState, [this.runtimeCmd, "rm", this.name]); }
    restart() { return runCommand(this._runtimeState, [this.runtimeCmd, "restart", this.name]); }
    pause()   { return runCommand(this._runtimeState, [this.runtimeCmd, "pause", this.name]); }
    unpause() { return runCommand(this._runtimeState, [this.runtimeCmd, "unpause", this.name]); }

    logs() {
        const isRunning = this.state === "running" || this.state === "Up";
        runCommandInTerminal(this.terminal, [this.runtimeCmd, "logs", "-f", this.name], !isRunning);
    }

    watchTop() {
        // -x executes the runtime directly, without watch's default sh -c wrapper.
        runCommandInTerminal(this.terminal, ["watch", "-x", this.runtimeCmd, "top", this.name]);
    }

    shell() {
        runCommandInTerminal(this.terminal,
            [this.runtimeCmd, "exec", "-it", this.name, "sh", "-c", CONTAINER_SHELL_SCRIPT]);
    }

    stats() {
        runCommandInTerminal(this.terminal, [this.runtimeCmd, "stats", this.name]);
    }

    async inspect() {
        this.ipAddress = "n/a";
        const out = await runCommand(this._runtimeState, [this.runtimeCmd, "inspect", "--format", "json", this.name]);
        const json = JSON.parse(out);
        if (json.length > 0) {
            const config = json[0];
            const ns = config.NetworkSettings;
            if (ns?.IPAddress)
                this.ipAddress = ns.IPAddress;
            if (config.Config?.Entrypoint) {
                this.entrypoint = config.Config.Entrypoint;
                if (Array.isArray(this.entrypoint))
                    this.entrypoint = this.entrypoint.join(" ");
            }
            if (config.Config?.Cmd) {
                this.command = config.Config.Cmd;
                if (Array.isArray(this.command))
                    this.command = this.command.join(" ");
            }
        }
    }

    async details() {
        const lines = [
            `Name: ${this.name}`,
            `ID: ${this.id}`,
            `Status: ${this.status}`,
            `Image: ${this.image}`,
            `Created: ${this.createdAt}`,
            `Started: ${this.startedAt || "never"}`,
            `Ports: ${this.ports}`,
        ];

        await this.inspect();
        lines.push(`IP Address: ${this.ipAddress}`);
        if (this.entrypoint)
            lines.push(`Entrypoint: ${this.entrypoint}`);
        if (this.command)
            lines.push(`Command: ${this.command}`);

        return lines.join("\n");
    }
}

async function spawnArgv(argv, state) {
    // A stale container must not start a process after reset or a runtime switch.
    state.cancellable.set_error_if_cancelled();
    const cmd = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

    state.processes.add(cmd);
    try {
        const [out, err] = await cmd.communicate_utf8_async(null, state.cancellable);
        state.cancellable.set_error_if_cancelled();
        if (!cmd.get_successful())
            throw new Error(`Command failed: ${err}`);
        return out;
    } finally {
        // reset() owns termination while the command is pending.
        state.processes.delete(cmd);
    }
}

async function runCommand(state, argv) {
    try {
        return await spawnArgv(argv, state);
    } catch (e) {
        if (!state.cancellable.is_cancelled()) {
            const errMsg = `Error running ${argv.join(" ")}`;
            Main.notify(errMsg, e.message);
            logError(e, errMsg);
        }
        throw e;
    }
}

function runCommandInTerminal(terminal, argv, keepOpenOnExit = false) {
    const terminalArgv = resolveTerminal(terminal);
    const errMsg = `Error running ${argv.join(" ")}`;
    if (!terminalArgv) {
        const message = "No supported terminal found. Install ptyxis, kgx, gnome-terminal, or configure a terminal in preferences.";
        Main.notify(errMsg, message);
        return;
    }

    // sh consumes the next argument as $0; "$@" forwards the command unchanged.
    // No runtime or container name is interpolated into the fixed script.
    const commandArgv = keepOpenOnExit
        ? ["sh", "-c", '"$@"; read -r _', "sh", ...argv]
        : argv;

    try {
        // User-opened terminals remain independent of runtime reset/disable.
        Gio.Subprocess.new([...terminalArgv, ...commandArgv], Gio.SubprocessFlags.NONE);
    } catch (e) {
        Main.notify(errMsg, e.message);
        logError(e, errMsg);
    }
}

function resolveTerminal(terminal) {
    const candidates = terminal ? [terminal, ...TERMINAL_FALLBACKS] : TERMINAL_FALLBACKS;

    for (const candidate of candidates) {
        try {
            // Only this user-configured command line needs parsing; it is not a shell script.
            const [, argv] = GLib.shell_parse_argv(candidate);
            if (argv?.[0] && commandExists(argv[0]))
                return argv;
        } catch (e) {
            logError(e, `Invalid terminal command "${candidate}"`);
        }
    }

    return null;
}

function commandExists(command) {
    if (command.includes("/"))
        return GLib.file_test(command, GLib.FileTest.IS_EXECUTABLE);
    return GLib.find_program_in_path(command) !== null;
}

export function newEventsProcess(onEvent) {
    const state = getRuntimeState(runtimeCmd);

    try {
        // STDERR_SILENCE keeps an unused stderr pipe from ever filling up.
        const process = Gio.Subprocess.new([state.cmd, "events", "--filter", "type=container"],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        const cancellable = new Gio.Cancellable();
        const inputStream = process.get_stdout_pipe();
        const readTask = _readStream(inputStream, onEvent, cancellable)
            .finally(() => {
                process.force_exit();
                inputStream.close(null);
            }).catch(e => {
                if (!cancellable.is_cancelled())
                    logError(e, "Error reading container events");
            });
        return {
            process,
            readTask,
            cancel() {
                cancellable.cancel();
                process.force_exit();
            },
        };
    } catch (e) {
        logError(e, "Error starting events listener");
        throw e;
    }
}

async function _readStream(inputStream, onEvent, cancellable) {
    const decoder = new TextDecoder();
    // GJS TextDecoder has no streaming mode, so buffer raw bytes and only
    // decode up to each newline. A newline byte cannot occur inside a
    // multi-byte UTF-8 sequence, so every decoded line is complete.
    let pending = new Uint8Array(0);

    while (true) {
        const result = await inputStream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, cancellable);
        cancellable.set_error_if_cancelled();
        if (result.get_size() === 0)
            break;

        const chunk = result.toArray();
        const merged = new Uint8Array(pending.length + chunk.length);
        merged.set(pending, 0);
        merged.set(chunk, pending.length);

        let lineStart = 0;
        for (let i = 0; i < merged.length; i++) {
            if (merged[i] !== 0x0A)
                continue;

            const line = decoder.decode(merged.subarray(lineStart, i)).trim();
            if (line !== "")
                onEvent(line);
            lineStart = i + 1;
        }
        // A read can end mid-line; keep the tail bytes for the next chunk.
        pending = merged.subarray(lineStart);
    }

    const tail = decoder.decode(pending).trim();
    if (tail !== "")
        onEvent(tail);
}

class Version {
    constructor(v) {
        const splits = v.split(".");
        this.major = parseInt(splits[0]) || 0;
        this.minor = parseInt(splits[1]) || 0;
        this.patch = splits.length > 2 ? parseInt(splits[2]) || 0 : null;
    }

    newerOrEqualTo(v) {
        return this.compare(new Version(v)) >= 0;
    }

    compare(other) {
        if (this.major !== other.major)
            return Math.sign(this.major - other.major);
        if (this.minor !== other.minor)
            return Math.sign(this.minor - other.minor);
        const a = this.patch ?? 0;
        const b = other.patch ?? 0;
        return Math.sign(a - b);
    }
}
