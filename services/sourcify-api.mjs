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
            // Use repository endpoint to check if contract exists
            const url = `${this.apiUrl}/files/any/${this.chainId}/${address}`;
            logger.debug(`Checking contract ${address} on Sourcify`);

            try {
                const response = await this.client.get(url);

                // Check response format and matching status
                if (response.data) {
                    if (Array.isArray(response.data)) {
                        // Check for both perfect and partial matches
                        const isVerified = response.data.some(item =>
                            item.address.toLowerCase() === address.toLowerCase() &&
                            (item.status === 'perfect' || item.status === 'partial')
                        );

                        if (isVerified) {
                            logger.debug(`Contract ${address} is verified on Sourcify (Array response)`);
                            return true;
                        }
                    } else {
                        // Direct file check succeeded, contract exists
                        logger.debug(`Contract ${address} is verified on Sourcify (Direct check)`);
                        return true;
                    }
                }

                logger.info(`Contract ${address} is not verified on Sourcify`);
                return false;

            } catch (error) {
                // 404 means contract not found
                if (error.response && error.response.status === 404) {
                    logger.info(`Contract ${address} is not verified on Sourcify`);
                    return false;
                }
                // Other errors should be logged
                throw error;
            }

        } catch (error) {
            logger.error(`Error checking contract ${address}:`, error);
            if (error.response) {
                logger.error('Error response:', error.response.data);
            }
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
