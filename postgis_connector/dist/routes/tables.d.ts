import { Router } from 'express';
export interface TableInfo {
    schema: string;
    table: string;
    geomColumn: string;
    geomType: string;
    srid: number;
    isGeography: boolean;
    estimatedExtent: string | null;
}
export declare function tablesRouter(): Router;
//# sourceMappingURL=tables.d.ts.map