// Qdrant client singleton. Reads URL + collection from the project
// config supplied to the MCP server via argv.
import { QdrantClient } from '@qdrant/js-client-rest';
import { loadProjectConfig } from './config.js';
const cfg = loadProjectConfig();
export const COLLECTION = cfg.collectionName;
export const QDRANT_URL = cfg.qdrantUrl;
export const PROJECT_ROOT = cfg.projectRoot;
export const qdrant = new QdrantClient({ url: QDRANT_URL });
//# sourceMappingURL=db.js.map