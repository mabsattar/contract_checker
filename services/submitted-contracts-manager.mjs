import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.mjs';

export class SubmittedContractsManager {
    constructor(chainOutputDir) {
        this.chainOutputDir = chainOutputDir;
        this.submittedContracts = [];
        this.stats = {
            total: 0,
            success: 0,
            failed: 0,
            lastSubmitted: null,
            startTime: new Date().toISOString()
        };
    }

    async addSubmittedContract(contract, result) {
        const submissionData = {
            address: contract.address,
            contractName: contract.contractName,
            filename: contract.filename,
            submittedAt: new Date().toISOString(),
            status: result.success ? 'success' : 'failed',
            error: result.error || null,
            chainId: contract.chainId,
            sourcifyResponse: result.response || null
        };

        this.submittedContracts.push(submissionData);
        this.stats.total++;
        this.stats.lastSubmitted = contract.filename;

        if (result.success) {
            this.stats.success++;
        } else {
            this.stats.failed++;
        }

        // Save after each submission
        await this.saveProgress();
    }

    async saveProgress() {
        try {
            await fs.mkdir(this.chainOutputDir, { recursive: true });

            // Save submitted contracts
            const contractsPath = path.join(this.chainOutputDir, 'submitted_contracts.json');
            await fs.writeFile(contractsPath, JSON.stringify(this.submittedContracts, null, 2));

            // Save submission stats
            const statsPath = path.join(this.chainOutputDir, 'submission_stats.json');
            await fs.writeFile(statsPath, JSON.stringify(this.stats, null, 2));

            logger.debug(`Saved ${this.submittedContracts.length} submitted contracts`);
        } catch (error) {
            logger.error('Error saving submitted contracts:', error);
        }
    }

    async reset() {
        this.submittedContracts = [];
        this.stats = {
            total: 0,
            success: 0,
            failed: 0,
            lastSubmitted: null,
            startTime: new Date().toISOString()
        };

        try {
            await fs.mkdir(this.chainOutputDir, { recursive: true });

            const files = [
                'submitted_contracts.json',
                'submission_stats.json'
            ];

            for (const file of files) {
                const filePath = path.join(this.chainOutputDir, file);
                await fs.writeFile(filePath, JSON.stringify(file.includes('stats') ? {} : [], null, 2));
            }

            logger.info('Submission tracking reset successfully');
        } catch (error) {
            logger.error('Error resetting submission tracking:', error);
        }
    }

    getStats() {
        return this.stats;
    }

    async loadSubmittedContracts() {
        try {
            const filePath = path.join(this.chainOutputDir, 'submitted_contracts.json');
            const data = await fs.readFile(filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.error('Error loading submitted contracts:', error);
            }
            return [];
        }
    }
} 