import axios from 'axios';
import Bottleneck from "bottleneck";
import FormData from 'form-data';
import { logger } from '../utils/logger.mjs';

export class SourcifyAPI {
    constructor(config) {
        // Validate required config
        if (!config.sourcify_api) throw new Error('sourcify_api is required in config');
        if (!config.sourcify_repo) throw new Error('sourcify_repo is required in config');
        if (!config.chain_id) throw new Error('chain_id is required in config');

        this.apiUrl = config.sourcify_api;
        this.repoUrl = config.sourcify_repo;
        this.chainId = config.chain_id;
        this.maxRetries = config.max_retries || 3;

        // Create axios instance with default config
        this.client = axios.create({
            timeout: 30000, // Increased timeout for large contracts
        });

        // Setup rate limiting
        this.limiter = new Bottleneck({
            minTime: 3000,
            maxConcurrent: 1
        });

        // Add response interceptor for error handling
        this.client.interceptors.response.use(
            response => response,
            error => this.handleApiError(error)
        );
    }

    async handleApiError(error) {
        if (error.response) {
            logger.error(`API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            logger.error('No response received from API');
        } else {
            logger.error('Error setting up request:', error.message);
        }
        throw error;
    }

    async checkContract(address) {
        try {
            // 1. First check repository for full matches
            const repoFullUrl = `${this.repoUrl}/contracts/full_match/${this.chainId}/${address}/metadata.json`;
            try {
                const fullResponse = await this.client.get(repoFullUrl);
                if (fullResponse.status === 200) {
                    logger.debug(`Contract ${address} is fully verified on Sourcify repository`);
                    return true;
                }
            } catch (error) {
                if (error.response?.status !== 404) {
                    logger.error(`Error checking full match for ${address}:`, error.message);
                }
            }

            // 2. Then check repository for partial matches
            const repoPartialUrl = `${this.repoUrl}/contracts/partial_match/${this.chainId}/${address}/metadata.json`;
            try {
                const partialResponse = await this.client.get(repoPartialUrl);
                if (partialResponse.status === 200) {
                    logger.debug(`Contract ${address} is partially verified on Sourcify repository`);
                    return true;
                }
            } catch (error) {
                if (error.response?.status !== 404) {
                    logger.error(`Error checking partial match for ${address}:`, error.message);
                }
            }

            // 3. Finally check API as fallback
            const apiUrl = `${this.apiUrl}/files/any/${this.chainId}/${address}`;
            try {
                const apiResponse = await this.client.get(apiUrl);
                if (apiResponse.data) {
                    if (Array.isArray(apiResponse.data)) {
                        const isVerified = apiResponse.data.some(item =>
                            item.address.toLowerCase() === address.toLowerCase() &&
                            (item.status === 'perfect' || item.status === 'partial')
                        );
                        if (isVerified) {
                            logger.debug(`Contract ${address} is verified on Sourcify API`);
                            return true;
                        }
                    } else {
                        logger.debug(`Contract ${address} is verified on Sourcify API (Direct check)`);
                        return true;
                    }
                }
            } catch (error) {
                if (error.response?.status !== 404) {
                    logger.error(`Error checking API for ${address}:`, error.message);
                }
            }

            // If we get here, contract is not verified anywhere
            logger.info(`Contract ${address} is not verified on Sourcify`);
            return false;

        } catch (error) {
            logger.error(`Unexpected error checking contract ${address}:`, error);
            return false;
        }
    }

    async submitContract(address, contractData) {
        const formData = new FormData();

        try {
            // 1. Contract Address (from contracts.json)
            formData.append('address', address);

            // 2. Chain ID (from config)
            formData.append('chain', '1');  // Ethereum mainnet

            // 3. Source Code (from .sol files)
            formData.append('files', Buffer.from(contractData.source), 'source.sol');

            // 4. Compiler Version (extracted from source)
            const compilerVersion = this.extractCompilerVersion(contractData.source);
            if (compilerVersion) {
                formData.append('compilerVersion', compilerVersion);
            }

            return await this.client.post('/verify', formData, {
                headers: {
                    ...formData.getHeaders()
                }
            });
        } catch (error) {
            logger.error(`Failed to submit contract ${address}:`, error);
            throw error;
        }
    }

    // Helper to extract compiler version from source code
    extractCompilerVersion(source) {
        const pragmaMatch = source.match(/pragma solidity (\^?\d+\.\d+\.\d+)/);
        if (pragmaMatch) {
            return pragmaMatch[1];
        }
        return null;
    }

    // Helper method to format contract data
    formatContractData(contract) {
        const formData = new FormData();

        try {
            // Required fields
            formData.append('address', contract.address);
            formData.append('chain', contract.chainId || '1');

            // Source files
            if (contract.source) {
                formData.append('files', Buffer.from(contract.source), 'source.sol');
            }

            // Optional metadata
            if (contract.compilerVersion) {
                formData.append('compilerVersion', contract.compilerVersion);
            }

            return formData;
        } catch (error) {
            logger.error('Error formatting contract data:', error);
            throw error;
        }
    }

    // Method to check verification status
    async checkVerificationStatus(contractAddresses) {
        try {
            const response = await this.client.post('/verification-status', {
                addresses: contractAddresses
            });
            return response.data;
        } catch (error) {
            logger.error('Failed to check verification status:', error.message);
            throw error;
        }
    }
}
