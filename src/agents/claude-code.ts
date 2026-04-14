import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { AgentAdapter } from './types';

export const claudeCodeAdapter: AgentAdapter = {
    id: "claude-code",
    name: "Claude Code",
    defaultCommand: "claude",

    buildArgs({ renderedPrompt, sessionFile, extraArgs }) {
        const sessionId = generateUUID(sessionFile);

        // Store session ID so resumeCommand can use it
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
        fs.writeFileSync(sessionFile, JSON.stringify({ sessionId }), 'utf-8');

        const args = [
            "-p",
            "--output-format", "json",
            "--session-id", sessionId,
        ];
        if (extraArgs.length > 0) args.push(...extraArgs);
        args.push(renderedPrompt);
        return args;
    },

    isSuccess(exitCode) {
        return exitCode === 0;
    },

    async extractCost(_sessionFile: string, logFile: string) {
        try {
            if (!fs.existsSync(logFile)) return null;
            const content = fs.readFileSync(logFile, 'utf-8').trim();
            if (!content) return null;

            const data = JSON.parse(content);
            if (!data.usage) return null;

            // Find model from modelUsage keys
            const models = data.modelUsage ? Object.keys(data.modelUsage) : [];
            const model = models[0] || undefined;

            return {
                model,
                cost: data.total_cost_usd,
                inputTokens: data.usage.input_tokens,
                outputTokens: data.usage.output_tokens,
                cacheReadTokens: data.usage.cache_read_input_tokens,
                cacheWriteTokens: data.usage.cache_creation_input_tokens,
            };
        } catch {
            return null;
        }
    },

    async peek(logFile, lines = 20) {
        if (!fs.existsSync(logFile)) return '(no output yet)';
        const content = fs.readFileSync(logFile, 'utf-8');

        // Try to parse JSON output and show just the result
        try {
            const data = JSON.parse(content.trim());
            if (data.result) return data.result;
        } catch { /* not JSON yet, show raw */ }

        return content.split('\n').slice(-lines).join('\n');
    },

    resumeCommand(sessionFile: string) {
        try {
            const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
            return `claude --resume ${data.sessionId}`;
        } catch {
            return `claude --continue`;
        }
    },
};

/** Generate a deterministic UUID v4-format string from a seed */
function generateUUID(seed: string): string {
    const hash = crypto.createHash('md5').update(seed).digest('hex');
    return [
        hash.slice(0, 8),
        hash.slice(8, 12),
        '4' + hash.slice(13, 16),
        ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
        hash.slice(20, 32),
    ].join('-');
}
