export interface CostData {
    model?: string;
    provider?: string;
    cost?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}

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
        sessionFile: string;
        extraArgs: string[];
    }): string[];

    /** Determine if task succeeded. Default: exit code === 0. */
    isSuccess(exitCode: number): boolean;

    /** Extract cost/usage from session file after completion. */
    extractCost(sessionFile: string): Promise<CostData | null>;

    /** Read last N lines of output. */
    peek(logFile: string, lines?: number): Promise<string>;

    /** Build a shell command for resuming the session. */
    resumeCommand(sessionFile: string): string;
}

export interface TaskRecord {
    id: string;
    pid: number;
    sourceFile: string;
    sourceLine: number;
    taskText: string;
    logNote: string;
    logFile: string;
    sessionFile: string;
    agentId: string;
    started: string;
    cost?: CostData;
}
