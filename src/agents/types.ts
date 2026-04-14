export interface AgentSettingDefinition {
    key: string;
    name: string;
    description: string;
    type: 'text' | 'number' | 'toggle' | 'dropdown';
    default: any;
    options?: string[];
}

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
    id: string;
    name: string;
    settings: AgentSettingDefinition[];

    buildCommand(params: {
        renderedPrompt: string;
        logFile: string;
        sessionFile: string;
        workingDirectory: string;
        agentSettings: Record<string, any>;
    }): { command: string; args: string[] };

    isSuccess(exitCode: number, logFile: string): boolean;
    extractCost(sessionFile: string): Promise<CostData | null>;
    peek(logFile: string, lines?: number): Promise<string>;
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
