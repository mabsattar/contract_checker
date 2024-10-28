import fs from "node:fs/promises";
import path from "node:path";
import { logger } from '../utils/logger.mjs';

export class ContractFinder {
    constructor(sourcifyApi, config) {
        this.sourcifyApi = sourcifyApi;
        this.config = config;
        this.missingContracts = [];
        this.stats = {
            total: 0,
            processed: 0,
            missing: 0,
            errors: 0
        };
    }

    async findMissingContracts(specificFolder = null) {
        try {
            const repoPath = this.config.ethereumRepo;
            logger.info(`Starting contract search in: ${repoPath}`);

            if (specificFolder) {
                await this.processSingleFolder(path.join(repoPath, specificFolder));
            } else {
                const folders = await fs.readdir(repoPath);
                for (const folder of folders) {
                    await this.processSingleFolder(path.join(repoPath, folder));
                }
            }

            // Save results
            await this.saveMissingContracts();
            await this.saveStats();

            return {
                stats: this.stats,
                missingContractsFile: 'missing_contracts.json'
            };
        } catch (error) {
            logger.error('Error in findMissingContracts:', error);
            throw error;
        }
    }

    async processSingleFolder(folderPath) {
        try {
            const files = await fs.readdir(folderPath);
            const solFiles = files.filter(f => f.endsWith('.sol'));

            this.stats.total += solFiles.length;
            logger.info(`Processing ${solFiles.length} contracts in ${folderPath}`);

            for (const file of solFiles) {
                try {
                    const contractPath = path.join(folderPath, file);
                    const contractAddress = file.replace('.sol', '').toLowerCase();

                    // Check if contract exists in Sourcify
                    const exists = await this.sourcifyApi.checkContract(contractAddress);

                    if (!exists) {
                        const source = await fs.readFile(contractPath, 'utf8');
                        this.missingContracts.push({
                            address: contractAddress,
                            path: contractPath,
                            source,
                            foundAt: new Date().toISOString()
                        });
                        this.stats.missing++;

                        // Save periodically
                        if (this.missingContracts.length % 100 === 0) {
                            await this.saveMissingContracts();
                        }
                    }

                    this.stats.processed++;
                } catch (error) {
                    logger.error(`Error processing file ${file}:`, error);
                    this.stats.errors++;
                }

                // Log progress
                if (this.stats.processed % 100 === 0) {
                    this.logProgress();
                }
            }
        } catch (error) {
            logger.error(`Error processing folder ${folderPath}:`, error);
            throw error;
        }
    }

    async saveMissingContracts() {
        const filePath = path.join(process.cwd(), 'missing_contracts.json');
        await fs.writeFile(filePath, JSON.stringify(this.missingContracts, null, 2));
        logger.info(`Saved ${this.missingContracts.length} missing contracts to ${filePath}`);
    }

    async saveStats() {
        const filePath = path.join(process.cwd(), 'contract_stats.json');
        await fs.writeFile(filePath, JSON.stringify(this.stats, null, 2));
        logger.info('Stats saved to', filePath);
    }

    logProgress() {
        const progress = {
            processed: this.stats.processed,
            total: this.stats.total,
            missing: this.stats.missing,
            errors: this.stats.errors,
            percentage: ((this.stats.processed / this.stats.total) * 100).toFixed(2)
        };
        logger.info('Progress:', progress);
    }
}

