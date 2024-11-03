import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.mjs';

export async function ensureChainDirs(chainPath) {
    try {
        const fullPath = path.join(process.cwd(), 'chain', chainPath);
        await fs.mkdir(fullPath, { recursive: true });
        logger.debug(`Ensured chain directory exists: ${fullPath}`);
        return fullPath;
    } catch (error) {
        logger.error(`Error creating chain directory: ${error}`);
        throw error;
    }
} 