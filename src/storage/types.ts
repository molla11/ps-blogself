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
    // workspaceId field removed as we are using flat structure with absolute path
    filePath: string; // Absolute path
    language: string;
    startedAt: number;
    lastModified: number;
    snapshots: Snapshot[];
    requestLogs: RequestLog[];
}

export interface SessionIndexItem {
    filePath: string; // Absolute path
    fileName: string;
    language: string;
    lastModified: number;
    fileHash: string;
}
