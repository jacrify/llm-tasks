export interface TaskRecord {
    id: string;
    pid: number;
    logFile: string;
    sourceFile: string;
    sourceLine: number;
    taskText: string;
    started: string;
    agentSessionId?: string;
    parentTaskLine?: number;
    resumedFromSession?: string;
}

export interface AgentAdapter {
    id: string;
    name: string;
    defaultCommand: string;
    buildArgs(opts: { renderedPrompt: string; extraArgs: string[] }): string[];
    isSuccess(exitCode: number): boolean;
}
