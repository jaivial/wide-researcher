export interface Neo4jConfig {
    uriEnv: string;
    userEnv: string;
    passwordEnv: string;
    databaseEnv: string;
    uri?: string;
    user?: string;
    password?: string;
    database?: string;
}
export interface ProjectConfig {
    projectName: string;
    projectRoot: string;
    collectionName: string;
    qdrantUrl: string;
    embedProvider: string;
    embedModel: string;
    embedDim: number;
    secretsPath: string | null;
    cohereApiKeyField: string;
    graphProvider: string;
    neo4j: Neo4jConfig;
    configPath: string;
}
export declare function loadProjectConfig(): ProjectConfig;
