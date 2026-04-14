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
};
