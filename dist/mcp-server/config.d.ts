export interface ProjectConfig {
    projectName: string;
    projectRoot: string;
    collectionName: string;
    qdrantUrl: string;
    embedModel: string;
    configPath: string;
}
export declare function loadProjectConfig(): ProjectConfig;
