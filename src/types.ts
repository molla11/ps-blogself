export interface SnapshotDiff {
    start: number;
    end: number;
    newText: string;
}

export interface Snapshot {
    timestamp: number;
    content?: string;
    diff?: SnapshotDiff;
    hash: string;
}

export interface RequestLog {
    id: string;
    timestamp: number;
    snapshotIndexRange: [number, number]; // [start, end] inclusive
    promptType: string;
}

export interface FileHistory {
    id: string;
    filePath: string;
    language: string;
    startedAt: number;
    lastModified: number;
    snapshots: Snapshot[];
    requestLogs: RequestLog[];
}

export interface SessionIndexItem {
    filePath: string;
    fileName: string;
    language: string;
    lastModified: number;
    fileHash: string;
}

export interface BlogPostDraft {
    filePath: string;
    instructions: string;
    selectedChangeIndices: number[]; // Indices of snapshots that are selected
    diffComments: Record<number, string>; // Map snapshot index to comment
    baseContent?: string;
    // Resolved content for backend
    diffs?: {
        index: number;
        type: 'full' | 'diff';
        content: string | import('./types').SnapshotDiff; // Use imported type or defined structure?
        // Actually SnapshotDiff is defined in this file.
        // content: string | SnapshotDiff;
        timestamp: number;
    }[];
    createdAt: number;
    updatedAt?: number;
}

export interface DiffSelection {
    snapshotIndex: number;
    diffBlock: string;
    userComment: string;
    context: {
        startLine: number;
        endLine: number;
    };
    isSelected: boolean;
}
