import { AgentAdapter } from './types';

export const piAdapter: AgentAdapter = {
    id: "pi",
    name: "Pi",
    defaultCommand: "pi",

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
