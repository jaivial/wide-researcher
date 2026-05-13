export interface Secrets {
    cohere_api_key?: string;
}
export declare function getSecret(key: keyof Secrets): Promise<string | undefined>;
export declare function setSecret(key: keyof Secrets, value: string): Promise<void>;
export declare function deleteSecret(key: keyof Secrets): Promise<void>;
export declare function secretsFilePath(): string;
