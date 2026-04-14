export interface AgentAdapter {
    /** Unique identifier */
    id: string;
    /** Display name for settings dropdown */
    name: string;
    /** Default binary/command name */
    defaultCommand: string;

    /**
     * Build the full args array for spawning.
     * The command itself comes from settings (user can override).
     */
    buildArgs(params: {
        renderedPrompt: string;
        task: string;
        extraArgs: string[];
    }): string[];

    /** Determine if task succeeded. Default: exit code === 0. */
    isSuccess(exitCode: number): boolean;
}

export interface TaskRecord {
    id: string;
    tmuxSession: string;
    sourceFile: string;
    sourceLine: number;
    taskText: string;
    agentId: string;
    started: string;
}
