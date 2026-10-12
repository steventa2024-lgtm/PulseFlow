declare module "pg" { // Ambient types for the optional PostgreSQL driver.
  export class Client {
    constructor(config: { connectionString: string });
    connect(): Promise<void>;
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
    end(): Promise<void>;
  }
}
