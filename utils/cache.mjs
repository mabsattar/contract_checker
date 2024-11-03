import fs from "node:fs/promises";
import path from "node:path";
import { logger } from './logger.mjs';

export class CacheManager {
    constructor(chainName) {
        // Split chain name into network parts (e.g. "ethereum_mainnet" -> ["ethereum", "mainnet"])
        const [chain, network] = chainName.split('_');

        // Construct proper path following chains/{chain}/{network} structure
        this.cacheDir = path.join(process.cwd(), 'chains', chain, network);
        this.cachePath = path.join(this.cacheDir, 'verification_cache.json');

        // Ensure cache directory exists
        fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    async init() {
        try {
            await fs.mkdir(this.cacheDir, { recursive: true });
        } catch (error) {
            logger.error("Error creating cache directory:", error);
        }
    }

    async load() {
        try {
            await this.init();
            const data = await fs.readFile(this.cachePath, "utf8");
            return JSON.parse(data);
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.info("Cache file not found, creating new cache");
                return {};
            }
            logger.error("Error reading cache:", error);
            return {};
        }
    }

    async save(contracts) {
        try {
            await this.init();
            await fs.writeFile(this.cachePath, JSON.stringify(contracts, null, 2));
            logger.debug("Cache updated successfully");
        } catch (error) {
            logger.error("Error saving cache:", error);
        }
    }

    async clear() {
        try {
            // Reset cache file to empty object
            await fs.writeFile(this.cachePath, JSON.stringify({}, null, 2));
            logger.info("Cache cleared successfully");
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.error("Error clearing cache:", error);
                throw error;
            }
            // If file doesn't exist, that's fine - it's effectively cleared
        }
    }
}