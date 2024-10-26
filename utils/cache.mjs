import fs from "node:fs/promises";
import path from "node:path";
import { logger } from './logger.mjs';

export class CacheManager {
    constructor() {
        this.cachePath = path.join(process.cwd(), "config", "sourcify_cache.json");
    }

    async load() {
        try {
            const data = await fs.readFile(this.cachePath, "utf8");
            return JSON.parse(data);
        } catch (error) {
            if (error.code === "ENOENT") {
                logger.info("Cache file not found. Starting with empty cache.");
                return {};
            }
            logger.error("Error reading cache:", error);
            return {};
        }
    }

    async save(contracts) {
        await fs.writeFile(this.cachePath, JSON.stringify(contracts, null, 2));
        logger.info("Cache updated successfully");
    }
}