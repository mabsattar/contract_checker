import fs from 'fs/promises';
import path from 'path';
import { logger } from './logger.mjs';

export class CacheManager {
    constructor(chainName) {
        // Split chain name into network parts (e.g. "ethereum_mainnet" -> ["ethereum", "mainnet"])
        const [chain, network] = chainName.split('_');

        // Construct proper path following chains/{chain}/{network} structure
        this.cacheDir = path.join(process.cwd(), 'chains', chain, network);
        this.cachePath = path.join(this.cacheDir, 'verification_cache.json');
    }

    async init() {
        try {
            // Create cache directory if it doesn't exist
            await fs.mkdir(this.cacheDir, { recursive: true });

            // Try to load existing cache
            try {
                const data = await fs.readFile(this.cachePath, 'utf8');
                this.cache = JSON.parse(data);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    // If file doesn't exist, initialize empty cache
                    this.cache = {};
                    await this.save(this.cache);
                } else {
                    throw error;
                }
            }
        } catch (error) {
            logger.error('Error initializing cache:', error);
            throw error;
        }
    }

    async save(data) {
        try {
            await fs.writeFile(this.cachePath, JSON.stringify(data, null, 2));
        } catch (error) {
            logger.error('Error saving cache:', error);
            throw error;
        }
    }
}