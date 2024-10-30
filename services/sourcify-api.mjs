import axios from 'axios';
import Bottleneck from "bottleneck";
import FormData from 'form-data';
import { logger } from '../utils/logger.mjs';

export class SourcifyAPI {
    constructor(config) {
        // Validate required config
        if (!config.sourcify_api) throw new Error('sourcify_api is required in config');
        if (!config.chain_id) throw new Error('chain_id is required in config');

        // Chain ID mapping
        this.chainIds = {
            'ethereum': '1',      // Ethereum Mainnet
            'sepolia': '11155111', // Sepolia Testnet
            'arbitrum': '42161',   // Arbitrum One
            'celo': '42220',      // Celo Mainnet
            'optimism': '10',     // Optimism
            'polygon': '137',     // Polygon Mainnet
        };

        // Ensure URLs don't end with slash
        this.apiUrl = config.sourcify_api || "https://sourcify.dev/server";
        this.chainId = this.validateChainId(config.chain_id);
        this.maxRetries = config.max_retries || 3;
        this.verificationDelay = config.verification_delay || 5000;

        this.client = axios.create({
            timeout: 10000,
            headers: {
                'Accept': 'application/json'
            }
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

        // Add timeout retry logic
        this.client.interceptors.response.use(
            response => response,
            async error => {
                if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                    logger.warn(`Request timed out for ${error.config.url}, retrying...`);
                    return this.client.request(error.config);
                }
                throw error;
            }
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
            // Ensure address is properly formatted
            address = address.toLowerCase();
            if (!address.startsWith('0x')) {
                address = '0x' + address;
            }

            logger.debug(`Checking contract ${address} on chain ${this.chainId}...`);

            // Check both full and partial matches using repository API
            const fullMatchUrl = `${this.repoUrl}/full_match/${this.chainId}/${address}/metadata.json`;
            const partialMatchUrl = `${this.repoUrl}/partial_match/${this.chainId}/${address}/metadata.json`;

            try {
                // Try full match first
                const fullMatchResponse = await this.makeRequest(fullMatchUrl);
                if (fullMatchResponse.status === 200) {
                    logger.info(`Contract ${address} has full match verification`);
                    return true;
                }
            } catch (error) {
                // If full match fails, try partial match
                try {
                    const partialMatchResponse = await this.makeRequest(partialMatchUrl);
                    if (partialMatchResponse.status === 200) {
                        logger.info(`Contract ${address} has partial match verification`);
                        return true;
                    }
                } catch (innerError) {
                    // Both checks failed, contract is not verified
                    logger.debug(`Contract ${address} is not verified`);
                    return false;
                }
            }

            return false;

        } catch (error) {
            // Log error but don't throw
            logger.warn(`Error checking contract ${address}: ${error.message}`);
            return false;
        }
    }


    async makeRequest(url, retries = 3, delay = 1000) {
        for (let i = 0; i < retries; i++) {
            try {
                return await this.client.head(url);
            } catch (error) {
                if (i === retries - 1) throw error;
                if (error.response?.status === 429) {
                    await new Promise(resolve => setTimeout(resolve, delay * (i + 1)));
                    continue;
                }
                throw error;
            }
        }
    }


    async submitContract(address, contractData) {
        try {
            // Format contract data using helper method
            const formData = this.formatContractData({
                address: address,
                source: contractData.source,
                chainId: this.chainId
            });

            // Submit to Sourcify API using the correct endpoint
            const verifyUrl = `${this.apiUrl}/verify-contract`;
            const response = await this.client.post(verifyUrl, formData, {
                headers: {
                    ...formData.getHeaders(),
                    'Content-Type': 'multipart/form-data'
                }
            });

            logger.info(`Successfully submitted contract ${address}`);
            return response.data;

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
            formData.append('chain', contract.chainId || this.chainId);

            // Source files
            if (contract.source) {
                formData.append('files', Buffer.from(contract.source), 'source.sol');
            }

            // Optional metadata
            const compilerVersion = contract.compilerVersion || this.extractCompilerVersion(contract.source);
            if (compilerVersion) {
                formData.append('compilerVersion', compilerVersion);
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
            // Use the check-by-addresses endpoint for batch verification status
            const response = await this.client.post(`${this.apiUrl}/check-by-addresses`, {
                addresses: contractAddresses,
                chainIds: [this.chainId]
            });

            // Process and format the response
            const results = {};
            if (response.data && Array.isArray(response.data)) {
                response.data.forEach(result => {
                    results[result.address] = {
                        status: result.status,
                        verified: result.status === 'perfect' || result.status === 'partial'
                    };
                });
            }

            return results;
        } catch (error) {
            logger.error('Failed to check verification status:', error.message);
            throw error;
        }
    }

    // Add this method to validate and normalize chain ID
    validateChainId(chainId) {
        // If chainId is a string name (e.g., 'ethereum', 'sepolia')
        if (typeof chainId === 'string' && this.chainIds[chainId.toLowerCase()]) {
            return this.chainIds[chainId.toLowerCase()];
        }

        // If chainId is already a number or numeric string
        if (!isNaN(chainId)) {
            return chainId.toString();
        }

        // If chainId is invalid
        logger.error(`Invalid chain ID: ${chainId}`);
        throw new Error(`Invalid chain ID: ${chainId}. Must be one of: ${Object.keys(this.chainIds).join(', ')} or a valid chain ID number`);
    }
}
