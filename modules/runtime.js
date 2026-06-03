"use strict";

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

const TERM_KEEP_ON_EXIT = true;
const TERM_CLOSE_ON_EXIT = false;
const TERMINAL_FALLBACKS = ["ptyxis --", "kgx --", "gnome-terminal --", "xterm -e"];

Gio._promisify(Gio.Subprocess.prototype,
    "communicate_utf8_async", "communicate_utf8_finish");
Gio._promisify(Gio.InputStream.prototype,
    "read_bytes_async", "read_bytes_finish");

let runtimeCmd;
let runtimeVersion;
let discoveringRuntimeVersion = null;

function reportError(error, message) {
    logError(error, message);
}

export function setRuntime(cmd) {
    runtimeCmd = cmd;
    runtimeVersion = undefined;
    discoveringRuntimeVersion = null;
}

export function getRuntime() {
    return runtimeCmd || "podman";
}

async function discoverRuntimeVersion() {
    try {
        const out = await spawnCommandline(`${runtimeCmd} version --format json`);
        const versionJson = JSON.parse(out);
        const versionString = versionJson?.Client?.Version;
        if (versionString) {
            runtimeVersion = new Version(versionString);
        }
    } catch (e) {
        reportError(e, `Error getting ${runtimeCmd} version`);
    }
}

export async function getContainers(settings) {
    if (runtimeVersion === undefined) {
        if (!discoveringRuntimeVersion) {
            discoveringRuntimeVersion = discoverRuntimeVersion();
        }
        await discoveringRuntimeVersion;
    }

    const sortBy = settings.get_string("sort-by");
    let jsonContainers;

    try {
        const out = await spawnCommandline(`${runtimeCmd} ps -a --sort ${sortBy} --format json`);
        jsonContainers = JSON.parse(out);
    } catch (e) {
        reportError(e, `Error fetching containers from ${runtimeCmd}`);
        throw new Error(`Error fetching containers from ${runtimeCmd}`);
    }

    if (jsonContainers === null || !Array.isArray(jsonContainers)) {
        return [];
    }

    return jsonContainers.map(e => new Container(settings, e));
}

class Container {
    constructor(settings, json) {
        this.terminal = settings.get_string("terminal");

        const isDocker = runtimeCmd === "docker";

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
        } else {
            if (runtimeVersion && runtimeVersion.newerOrEqualTo("2.0.3")) {
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
        }
    }

    start()   { runCommand("start", this.name); }
    stop()    { runCommand("stop", this.name); }
    rm()      { runCommand("rm", this.name); }
    restart() { runCommand("restart", this.name); }
    pause()   { runCommand("pause", this.name); }
    unpause() { runCommand("unpause", this.name); }

    logs() {
        const isRunning = this.state === "running" || this.state === "Up";
        runCommandInTerminal(this.terminal, `${runtimeCmd} logs -f`, this.name, "",
            isRunning ? TERM_CLOSE_ON_EXIT : TERM_KEEP_ON_EXIT);
    }

    watchTop() {
        runCommandInTerminal(this.terminal, `watch ${runtimeCmd} top`, this.name, "");
    }

    shell() {
        const loginShellCmd = "sh -c 's=${SHELL:-$(grep ^$(id -un): /etc/passwd 2>/dev/null | cut -d: -f7)}; exec ${s:-/bin/sh}'";
        runCommandInTerminal(this.terminal, `${runtimeCmd} exec -it`, this.name, loginShellCmd);
    }

    stats() {
        runCommandInTerminal(this.terminal, `${runtimeCmd} stats`, this.name, "");
    }

    async inspect() {
        this.ipAddress = "n/a";
        try {
            const out = await runCommand("inspect --format json", this.name);
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
        } catch (e) {
            reportError(e, "Error inspecting container");
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

export async function spawnCommandline(cmdline) {
    const [, argv] = GLib.shell_parse_argv(cmdline);
    const cmd = Gio.Subprocess.new(argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);

    const [out, err] = await cmd.communicate_utf8_async(null, null);
    const status = cmd.get_exit_status();
    if (status !== 0)
        throw new Error(`Command terminated with status ${status}: ${err}`);
    return out;
}

async function runCommand(command, containerName) {
    const cmdline = `${runtimeCmd} ${command} ${containerName}`;

    try {
        const out = await spawnCommandline(cmdline);
        return out;
    } catch (e) {
        const errMsg = `Error running ${command} on ${containerName}`;
        Main.notify(errMsg, e.message);
        reportError(e, errMsg);
        throw e;
    }
}

function runCommandInTerminal(terminal, command, containerName, args, keepOpenOnExit) {
    terminal = resolveTerminal(terminal);
    if (!terminal) {
        const errMsg = `Error running ${command} on ${containerName}`;
        const message = "No supported terminal found. Install ptyxis, kgx, gnome-terminal, or configure a terminal in preferences.";
        Main.notify(errMsg, message);
        return;
    }

    let cmdline;
    if (keepOpenOnExit)
        cmdline = `${terminal} bash -c '${command} ${containerName} ${args};read i'`;
    else
        cmdline = `${terminal} ${command} ${containerName} ${args}`;

    try {
        GLib.spawn_command_line_async(cmdline);
    } catch (e) {
        const errMsg = `Error running ${command} on ${containerName}`;
        Main.notify(errMsg, e.message);
        reportError(e, errMsg);
    }
}

function resolveTerminal(terminal) {
    const candidates = terminal ? [terminal, ...TERMINAL_FALLBACKS] : TERMINAL_FALLBACKS;

    for (const candidate of candidates) {
        try {
            const [, argv] = GLib.shell_parse_argv(candidate);
            if (argv?.[0] && commandExists(argv[0]))
                return candidate;
        } catch (e) {
            reportError(e, `Invalid terminal command "${candidate}"`);
        }
    }

    return null;
}

function commandExists(command) {
    if (command.includes("/"))
        return GLib.file_test(command, GLib.FileTest.IS_EXECUTABLE);
    return GLib.find_program_in_path(command) !== null;
}

export async function newEventsProcess(onEvent) {
    if (runtimeVersion === undefined) {
        if (!discoveringRuntimeVersion)
            discoveringRuntimeVersion = discoverRuntimeVersion();
        await discoveringRuntimeVersion;
    }

    try {
        const cmdline = `${runtimeCmd} events --filter type=container --format '{"name": "{{ .Name }}"}'`;
        const [, argv] = GLib.shell_parse_argv(cmdline);
        const process = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        const pipe = process.get_stdout_pipe();
        _readStream(pipe, onEvent);
        return process;
    } catch (e) {
        reportError(e, "Error starting events listener");
        throw new Error("Error starting events listener");
    }
}

async function _readStream(inputStream, onEvent) {
    while (true) {
        try {
            const result = await inputStream.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null);
            const rawjson = new TextDecoder().decode(result.toArray());
            if (rawjson === "")
                break;

            rawjson.split(/\n/).forEach(j => {
                if (j !== "") {
                    try {
                        onEvent(JSON.parse(j));
                    } catch (e) {
                        reportError(e, "Error parsing container event");
                    }
                }
            });
        } catch (e) {
            reportError(e, "Error reading container events stream");
            break;
        }
    }
}

class Version {
    constructor(v) {
        const splits = v.split(".");
        this.major = parseInt(splits[0]);
        this.minor = parseInt(splits[1]);
        this.patch = splits.length > 2 ? splits[2] : null;
    }

    newerOrEqualTo(v) {
        return this.compare(new Version(v)) >= 0;
    }

    compare(other) {
        if (this.major !== other.major)
            return Math.sign(this.major - other.major);
        if (this.minor !== other.minor)
            return Math.sign(this.minor - other.minor);
        if (this.patch !== other.patch) {
            if (this.patch === null)
                return -1;
            return this.patch.localeCompare(other.patch);
        }
        return 0;
    }
}
