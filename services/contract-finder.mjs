import fs from "node:fs/promises";
import path from "node:path";
import { logger } from '../utils/logger.mjs';
import { SubmittedContractsManager } from './submitted-contracts-manager.mjs';

export class ContractFinder {
    constructor(sourcifyApi, config, cacheManager) {
        this.sourcifyApi = sourcifyApi;
        this.config = config;
        this.cacheManager = cacheManager;

        // Use the full path directly instead of trying to make it relative
        this.repoPath = this.config.repo_path;

        // Ensure output directory is relative to project root
        const [chain, network] = this.config.chain_name.split('_');
        this.chainOutputDir = path.join('./chains', chain, network);

        this.stats = {
            total: 0,
            processed: 0,
            missing: 0,
            matching: 0,
            errors: 0
        };

        this.missingContracts = [];
        this.matchingContracts = [];

        // Initialize the output directory path
        this.chainOutputDir = path.join('chains', this.config.output_dir);

        this.stats = this.initializeStats();

        // Add timeout handling
        this.processTimeout = 30000; // 30 seconds timeout for processing each contract
        this.verificationCache = new Map(); // In-memory cache

        // Add in-memory index for faster lookups
        this.contractIndex = new Map();

        this.submittedContractsManager = new SubmittedContractsManager(this.chainOutputDir);
    }

    initializeStats() {
        return {
            total: 0,
            processed: 0,
            missing: 0,
            matching: 0,
            errors: 0,
            startTime: new Date().toISOString(),
            lastProcessed: null,
            lastVerified: false
        };
    }

    async findMissingContracts(folderOption) {
        try {
            // Ensure we're using relative paths
            const searchPath = folderOption || this.repoPath;
            logger.info(`Starting contract search in: ${searchPath}`);

            if (folderOption) {
                const folderPath = path.join(searchPath, folderOption);
                logger.info(`Processing specific folder: ${folderPath}`);
                await this.processFolder(folderPath);
            } else {
                // Process all folders
                const folders = await fs.readdir(searchPath);
                for (const folder of folders) {
                    const folderPath = path.join(searchPath, folder);
                    const stat = await fs.stat(folderPath);

                    if (stat.isDirectory()) {
                        await this.processFolder(folderPath);
                    }
                }
            }

            await this.saveProgress();

            return {
                stats: this.stats,
                missingContractsFile: path.join(this.chainOutputDir, 'missing_contracts.json'),
                matchingContractsFile: path.join(this.chainOutputDir, 'matching_contracts.json')
            };

        } catch (error) {
            logger.error('Error in contract search:', error);
            throw error;
        }
    }

    async processFolder(folderPath) {
        try {
            const files = await fs.readdir(folderPath);
            const solFiles = files.filter(file => file.endsWith('.sol'));

            logger.info(`Processing ${solFiles.length} contracts in ${folderPath}`);

            let processed = 0;
            for (const file of solFiles) {
                try {
                    const startTime = Date.now();

                    // Extract address from filename
                    const match = file.match(/^([a-fA-F0-9]{40})_([^.]+)\.sol$/);
                    if (!match) {
                        logger.warn(`Invalid filename format: ${file}`);
                        this.stats.errors++;
                        continue;
                    }

                    const [_, addressWithout0x, contractName] = match;
                    const address = '0x' + addressWithout0x;

                    logger.debug(`Processing contract: ${file}`);

                    // Process contract with timeout
                    await Promise.race([
                        this.processContract(address, contractName, file, folderPath),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Processing timeout')), this.processTimeout)
                        )
                    ]);

                    processed++;
                    if (processed % 10 === 0) {
                        logger.info(`Processed ${processed}/${solFiles.length} contracts in ${folderPath}`);
                    }

                    const processingTime = Date.now() - startTime;
                    logger.debug(`Processed ${file} in ${processingTime}ms`);

                } catch (error) {
                    logger.error(`Error processing file ${file}:`, error);
                    this.stats.errors++;
                }
            }

        } catch (error) {
            logger.error(`Error reading folder ${folderPath}:`, error);
            throw error;
        }
    }

    async processContract(address, contractName, filename, folderPath) {
        try {
            this.stats.processed++;
            this.stats.lastProcessed = filename;

            // Check cache first
            const cachedResult = await this.checkCache(address);
            if (cachedResult !== null) {
                logger.debug(`Cache hit for ${filename}: ${cachedResult ? 'verified' : 'missing'}`);
                if (!cachedResult) {
                    await this.addMissingContract(address, contractName, filename, folderPath);
                } else {
                    await this.addMatchingContract(address, contractName, filename, folderPath);
                }
                return;
            }

            logger.debug(`Cache miss for ${filename}, checking Sourcify...`);

            // If not in cache, check Sourcify
            const isVerified = await this.sourcifyApi.checkContract(address);

            // Only update cache for verified contracts
            // Missing contracts will only be cached after successful submission
            if (isVerified) {
                await this.updateCache(address, true);
            }

            if (!isVerified) {
                await this.addMissingContract(address, contractName, filename, folderPath);
                logger.info(`Found missing contract: ${filename}`);
            } else {
                await this.addMatchingContract(address, contractName, filename, folderPath);
                logger.debug(`Found matching contract: ${filename}`);
            }

        } catch (error) {
            logger.error(`Error processing contract ${address}:`, error);
            this.stats.errors++;
        }
    }

    async checkCache(address) {
        try {
            const cache = await this.cacheManager.load();
            return cache[address] ?? null;
        } catch (error) {
            logger.error(`Cache read error for ${address}:`, error);
            return null;
        }
    }

    async updateCache(address, isVerified) {
        try {
            const cache = await this.cacheManager.load();
            cache[address] = isVerified;
            await this.cacheManager.save(cache);
        } catch (error) {
            logger.error(`Cache update error for ${address}:`, error);
        }
    }

    async addMissingContract(address, contractName, filename, folderPath) {
        const filePath = path.join(folderPath, filename);
        const source = await fs.readFile(filePath, 'utf8');

        this.missingContracts.push({
            address,
            contractName,
            filename,
            source
        });

        this.stats.missing++;
    }

    async addMatchingContract(address, contractName, filename, folderPath) {
        const filePath = path.join(folderPath, filename);
        const source = await fs.readFile(filePath, 'utf8');

        this.matchingContracts.push({
            address,
            contractName,
            filename,
            source,
            verifiedAt: new Date().toISOString()
        });

        this.stats.matching++;
    }

    async saveProgress() {
        try {
            // Save missing contracts
            await this.saveMissingContracts();
            // Save matching contracts
            await this.saveMatchingContracts();
            // Save stats
            await this.saveStats();
            // Force cache save
            if (this.cacheManager) {
                await this.cacheManager.save(this.verificationCache);
            }
        } catch (error) {
            logger.error('Error saving progress:', error);
            throw error;
        }
    }

    async saveStats() {
        const filePath = path.join(this.chainOutputDir, 'contract_stats.json');
        try {
            await fs.writeFile(filePath, JSON.stringify(this.stats, null, 2));
            logger.debug('Stats saved successfully');
        } catch (error) {
            logger.error('Error saving stats:', error);
        }
    }

    async saveMissingContracts() {
        const filePath = path.join(this.chainOutputDir, 'missing_contracts.json');
        try {
            await fs.writeFile(filePath, JSON.stringify(this.missingContracts, null, 2));
            logger.debug(`Saved ${this.missingContracts.length} missing contracts to ${filePath}`);
        } catch (error) {
            logger.error('Error saving missing contracts:', error);
        }
    }

    async saveMatchingContracts() {
        const filePath = path.join(this.chainOutputDir, 'matching_contracts.json');
        try {
            await fs.writeFile(filePath, JSON.stringify(this.matchingContracts, null, 2));
            logger.debug(`Saved ${this.matchingContracts.length} matching contracts to ${filePath}`);
        } catch (error) {
            logger.error('Error saving matching contracts:', error);
        }
    }

    getTimeElapsed() {
        const start = new Date(this.overallStats.startTime);
        const now = new Date();
        const elapsed = now - start;

        // Convert to hours, minutes, seconds
        const hours = Math.floor(elapsed / 3600000);
        const minutes = Math.floor((elapsed % 3600000) / 60000);
        const seconds = Math.floor((elapsed % 60000) / 1000);

        // Format the time string
        let timeString = '';
        if (hours > 0) timeString += `${hours}h `;
        if (minutes > 0) timeString += `${minutes}m `;
        timeString += `${seconds}s`;

        return timeString;
    }

    async resetStats() {
        try {
            // Reset stats object
            this.stats = this.initializeStats();

            // Reset contracts arrays
            this.missingContracts = [];
            this.matchingContracts = [];

            // Clear cache
            if (this.cacheManager) {
                await this.cacheManager.clear();
            }

            // Ensure output directory exists
            await fs.mkdir(this.chainOutputDir, { recursive: true });

            // Clear/reset all JSON files
            const files = [
                'missing_contracts.json',
                'matching_contracts.json',
                'contract_stats.json'
            ];

            for (const file of files) {
                const filePath = path.join(this.chainOutputDir, file);
                try {
                    // Write empty arrays/objects to files
                    await fs.writeFile(filePath, JSON.stringify([], null, 2));
                    logger.debug(`Reset ${file}`);
                } catch (error) {
                    if (error.code !== 'ENOENT') { // Ignore if file doesn't exist
                        logger.error(`Error resetting ${file}:`, error);
                    }
                }
            }

            // Reset submission tracking
            await this.submittedContractsManager.reset();

            logger.info("Stats, cache, and files reset successfully");
        } catch (error) {
            logger.error("Error resetting stats:", error);
            throw error;
        }
    }

    // Add this method to check if we're parsing addresses correctly
    extractAddressFromFilename(filename) {
        // The address should be the part before the first underscore
        const match = filename.match(/^(0x?[a-fA-F0-9]{40})_/);
        if (!match) return null;

        // Ensure address is properly formatted with 0x prefix
        const address = match[1].toLowerCase();
        return address.startsWith('0x') ? address : `0x${address}`;
    }

    async indexContract(address, data) {
        this.contractIndex.set(address.toLowerCase(), data);
    }

    async processBatch(contracts, batchSize = 100) {
        for (let i = 0; i < contracts.length; i += batchSize) {
            const batch = contracts.slice(i, i + batchSize);
            await Promise.all(batch.map(contract => this.processContract(contract)));
        }
    }

    async submitContract(contract) {
        try {
            const result = await this.sourcifyApi.submitContract(contract);

            // Track submission
            await this.submittedContractsManager.addSubmittedContract(contract, result);

            if (result.success) {
                // Only cache after successful submission
                await this.updateCache(contract.address, true);
            }

            return result;
        } catch (error) {
            logger.error(`Error submitting contract ${contract.address}:`, error);
            throw error;
        }
    }
}
