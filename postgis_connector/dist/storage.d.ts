export interface SavedConnection {
    id: string;
    name: string;
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    createdAt: string;
}
export declare function loadConnections(): SavedConnection[];
export declare function saveConnections(connections: SavedConnection[]): void;
export declare function __reset(): void;
//# sourceMappingURL=storage.d.ts.map