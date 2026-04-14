import * as fs from 'node:fs';
import { AgentAdapter } from './types';

export const claudeCodeAdapter: AgentAdapter = {
    id: "claude-code",
    name: "Claude Code",
    defaultCommand: "claude",

    buildArgs({ renderedPrompt, sessionFile, extraArgs }) {
        // Use sessionFile as a place to store the session ID
        // Generate a deterministic session ID from the session file path
        const sessionId = generateUUID(sessionFile);

        // Write session ID to sessionFile so we can use it for resume
        fs.mkdirSync(require('path').dirname(sessionFile), { recursive: true });
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

    async extractCost(sessionFile: string) {
        // Claude Code with --output-format json writes a JSON object to stdout
        // which gets captured in the log file. The session file just has our session ID.
        // Cost data comes from the JSON output in the log file.
        // We need to read the log file, not the session file.
        // However, we only get sessionFile here. The log file path follows the pattern:
        // same dir, same name but .log extension
        const logFile = sessionFile.replace(/\/sessions\//, '/') + '.log';
        try {
            if (!fs.existsSync(logFile)) return null;
            const content = fs.readFileSync(logFile, 'utf-8').trim();
            if (!content) return null;

            // Try to parse as JSON (claude --output-format json outputs a single JSON object)
            const data = JSON.parse(content);
            if (data.usage) {
                return {
                    model: data.model,
                    cost: data.cost_usd,
                    inputTokens: data.usage.input_tokens,
                    outputTokens: data.usage.output_tokens,
                    cacheReadTokens: data.usage.cache_read_input_tokens,
                    cacheWriteTokens: data.usage.cache_creation_input_tokens,
                };
            }
        } catch {
            // JSON parse failed — output wasn't JSON (maybe text mode)
        }
        return null;
    },

    async peek(logFile, lines = 20) {
        if (!fs.existsSync(logFile)) return '(no output yet)';
        const content = fs.readFileSync(logFile, 'utf-8');
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
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update(seed).digest('hex');
    // Format as UUID v4
    return [
        hash.slice(0, 8),
        hash.slice(8, 12),
        '4' + hash.slice(13, 16),
        ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
        hash.slice(20, 32),
    ].join('-');
}
