import * as fs from 'node:fs';
import { AgentAdapter } from './types';

export const piAdapter: AgentAdapter = {
    id: "pi",
    name: "Pi",
    defaultCommand: "pi",

    buildArgs({ renderedPrompt, sessionFile, extraArgs }) {
        const args = ["-p", "--session", sessionFile];
        if (extraArgs.length > 0) args.push(...extraArgs);
        args.push(renderedPrompt);
        return args;
    },

    isSuccess(exitCode) {
        return exitCode === 0;
    },

    async extractCost(sessionFile: string) {
        try {
            if (!fs.existsSync(sessionFile)) return null;
            const content = fs.readFileSync(sessionFile, 'utf-8');
            const lines = content.trim().split('\n');

            let totalCost = 0;
            let totalInput = 0;
            let totalOutput = 0;
            let totalCacheRead = 0;
            let totalCacheWrite = 0;
            let model: string | undefined;
            let provider: string | undefined;

            for (const line of lines) {
                try {
                    const obj = JSON.parse(line);
                    if (obj.type === 'message' && obj.message?.role === 'assistant' && obj.usage) {
                        const u = obj.usage;
                        if (u.cost) totalCost += u.cost.total || 0;
                        totalInput += u.input || 0;
                        totalOutput += u.output || 0;
                        totalCacheRead += u.cacheRead || 0;
                        totalCacheWrite += u.cacheWrite || 0;
                        if (obj.model) model = obj.model;
                        if (obj.provider) provider = obj.provider;
                    }
                } catch { /* skip unparseable lines */ }
            }

            if (totalCost === 0 && totalInput === 0) return null;

            return {
                model,
                provider,
                cost: totalCost,
                inputTokens: totalInput,
                outputTokens: totalOutput,
                cacheReadTokens: totalCacheRead,
                cacheWriteTokens: totalCacheWrite,
            };
        } catch {
            return null;
        }
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
