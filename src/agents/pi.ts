import * as fs from 'node:fs';
import { AgentAdapter } from './types';

export const piAdapter: AgentAdapter = {
    id: "pi",
    name: "Pi",

    settings: [
        { key: "binaryPath", name: "Binary path", description: "Path to pi executable", type: "text", default: "pi" },
        { key: "model", name: "Model", description: "Model pattern (e.g. sonnet, opus). Leave blank for default", type: "text", default: "" },
        { key: "provider", name: "Provider", description: "Provider name (e.g. google, anthropic, amazon-bedrock). Leave blank for default", type: "text", default: "" },
        { key: "additionalArgs", name: "Additional arguments", description: "Extra CLI args (space-separated)", type: "text", default: "" },
    ],

    buildCommand({ renderedPrompt, sessionFile, agentSettings }) {
        const args = ["-p", "--session", sessionFile];

        if (agentSettings.model) args.push("--model", agentSettings.model);
        if (agentSettings.provider) args.push("--provider", agentSettings.provider);
        if (agentSettings.additionalArgs) {
            args.push(...agentSettings.additionalArgs.split(/\s+/).filter(Boolean));
        }

        args.push(renderedPrompt);

        return { command: agentSettings.binaryPath || "pi", args };
    },

    isSuccess(exitCode) {
        return exitCode === 0;
    },

    async extractCost(_sessionFile) {
        return null; // TODO: implement
    },

    async peek(logFile, lines = 20) {
        if (!fs.existsSync(logFile)) return '(no output yet)';
        const content = fs.readFileSync(logFile, 'utf-8');
        return content.split('\n').slice(-lines).join('\n');
    },

    resumeCommand(sessionFile) {
        return `pi --session ${sessionFile}`;
    },
};
