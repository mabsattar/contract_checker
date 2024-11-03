import fs from 'fs/promises';
import path from 'path';
import { logger } from './logger.mjs';

export class CacheManager {
    constructor(chainName) {
        const [chain, network] = chainName.split('_');

        // Ensure we're using relative paths from project root
        this.cacheDir = path.join('./chains', chain, network);
        this.cachePath = path.join(this.cacheDir, 'verification_cache.json');
        this.cache = {};
    }

    async init() {
        try {
            // Create cache directory if it doesn't exist
            await fs.mkdir(this.cacheDir, { recursive: true });
            await this.load();
        } catch (error) {
            logger.error('Error initializing cache:', error);
            throw error;
        }
    }

    async load() {
        try {
            const data = await fs.readFile(this.cachePath, 'utf8');
            this.cache = JSON.parse(data);
            return this.cache;
        } catch (error) {
            if (error.code === 'ENOENT') {
                // If file doesn't exist, initialize empty cache
                this.cache = {};
                await this.save(this.cache);
                return this.cache;
            }
            throw error;
        }
    }

    async clear() {
        try {
            this.cache = {};
            await this.save(this.cache);
            logger.info('Cache cleared successfully');
        } catch (error) {
            logger.error('Error clearing cache:', error);
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

    async markVerified(address) {
        this.cache[address.toLowerCase()] = {
            verified: true,
            timestamp: new Date().toISOString()
        };
        await this.save(this.cache);
    }

    isVerified(address) {
        return !!this.cache[address.toLowerCase()]?.verified;
    }
}