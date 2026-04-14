import * as fs from 'node:fs';
import { AgentAdapter } from './types';

export const claudeCodeAdapter: AgentAdapter = {
    id: "claude-code",
    name: "Claude Code",

    settings: [
        { key: "binaryPath", name: "Binary path", description: "Path to claude executable", type: "text", default: "claude" },
        { key: "model", name: "Model", description: "Model to use (e.g. sonnet, opus)", type: "text", default: "" },
        { key: "additionalArgs", name: "Additional arguments", description: "Extra CLI args", type: "text", default: "" },
    ],

    buildCommand({ renderedPrompt, agentSettings }) {
        const args = ["-p"];
        if (agentSettings.model) args.push("--model", agentSettings.model);
        if (agentSettings.additionalArgs) {
            args.push(...agentSettings.additionalArgs.split(/\s+/).filter(Boolean));
        }
        args.push(renderedPrompt);
        return { command: agentSettings.binaryPath || "claude", args };
    },

    isSuccess(exitCode) {
        return exitCode === 0;
    },

    async extractCost() {
        return null;
    },

    async peek(logFile, lines = 20) {
        if (!fs.existsSync(logFile)) return '(no output yet)';
        const content = fs.readFileSync(logFile, 'utf-8');
        return content.split('\n').slice(-lines).join('\n');
    },

    resumeCommand() {
        return `claude --continue`;
    },
};
