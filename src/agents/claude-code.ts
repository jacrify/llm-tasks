import * as fs from 'node:fs';
import { AgentAdapter } from './types';

export const claudeCodeAdapter: AgentAdapter = {
    id: "claude-code",
    name: "Claude Code",
    defaultCommand: "claude",

    buildArgs({ renderedPrompt, extraArgs }) {
        const args = ["-p"];
        if (extraArgs.length > 0) args.push(...extraArgs);
        args.push(renderedPrompt);
        return args;
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
