import axios from 'axios';
import FormData from 'form-data';
import { logger } from '../utils/logger.mjs';
import path from 'path';
import fs from 'fs/promises';
import { keccak256 } from 'ethereum-cryptography/keccak';
import { utf8ToBytes } from 'ethereum-cryptography/utils';

export class SourcifyAPI {
    constructor(config) {
        this.chainId = config.chain_id;
        this.apiUrl = config.sourcify_api;
        this.shouldTryPartialMatch = config.sourcify.attempts.partial_match;
        this.shouldTryFullMatch = config.sourcify.attempts.full_match;
        this.timeout = config.sourcify.timeout;

        logger.info('SourcifyAPI initialized with:', {
            chainId: this.chainId,
            apiUrl: this.apiUrl
        });

        this.verificationStats = {
            successful: 0,
            failed: 0,
            rateLimited: 0,
            malformed: 0,
            lastError: null,
            lastSuccess: null,
            matchingContracts: []
        };

        this.stats = {
            ...this.stats,
            fullMatches: 0,
            partialMatches: 0,
            failed: 0
        };
    }

    _isValidAddress(address) {
        // Check if address is a string and matches Ethereum address format
        return typeof address === 'string' &&
            /^(0x)?[0-9a-fA-F]{40}$/i.test(address);
    }

    async checkContract(address) {
        try {
            if (!this._isValidAddress(address)) {
                logger.warn(`Invalid address format: ${address}`);
                return false;
            }

            // Normalize address to lowercase
            address = address.toLowerCase();
            if (!address.startsWith('0x')) {
                address = '0x' + address;
            }

            // First try the verification check endpoint
            const verifyUrl = `${this.apiUrl}/check-by-addresses?addresses=${address}&chainIds=${this.chainId}`;
            logger.debug(`Checking Sourcify verification at: ${verifyUrl}`);

            const response = await axios.get(verifyUrl);
            logger.debug(`Sourcify response for ${address}:`, response.data);

            // The API returns an array of results
            if (Array.isArray(response.data) && response.data.length > 0) {
                const result = response.data[0];

                // Check if contract is verified (either full or partial match)
                const isVerified = result.status === 'perfect' || result.status === 'partial';

                if (isVerified) {
                    this.verificationStats.successful++;
                    this.verificationStats.lastSuccess = address;
                    this.verificationStats.matchingContracts.push({
                        address,
                        status: result.status,
                        timestamp: new Date().toISOString()
                    });
                    logger.debug(`Contract ${address} is verified in Sourcify (${result.status})`);
                    return true;
                }
            }

            // If we get here, try the files endpoint as a fallback
            const filesUrl = `${this.apiUrl}/files/any/${this.chainId}/${address}`;
            try {
                const filesResponse = await axios.head(filesUrl);
                if (filesResponse.status === 200) {
                    this.verificationStats.successful++;
                    this.verificationStats.lastSuccess = address;
                    this.verificationStats.matchingContracts.push({
                        address,
                        status: 'files exist',
                        timestamp: new Date().toISOString()
                    });
                    logger.debug(`Contract ${address} is verified in Sourcify (files exist)`);
                    return true;
                }
            } catch (error) {
                if (error.response?.status === 404) {
                    logger.debug(`Contract ${address} is not verified in Sourcify (no files found)`);
                    return false;
                }
                // For other errors, continue to the main error handler
                throw error;
            }

            return false;

        } catch (error) {
            return this._handleApiError(error, address);
        }
    }

    async submitContract(contract) {
        try {
            if (!this._validateContractData(contract)) {
                throw new Error('Invalid contract data format');
            }

            const formData = new FormData();

            // Add required fields
            formData.append('address', contract.address.toLowerCase());
            formData.append('chain', this.chainId);

            // Add source file
            formData.append('files', Buffer.from(contract.source), contract.filename);

            // Add metadata using the helper method
            const metadata = this._createMetadata(contract);
            formData.append('files', Buffer.from(JSON.stringify(metadata)), 'metadata.json');

            // First try full match
            if (this.shouldTryFullMatch) {

                try {
                    const fullMatchResponse = await axios.post(
                        `${this.apiUrl}/verify`,
                        formData,
                        {
                            headers: formData.getHeaders(),
                            maxBodyLength: Infinity
                        }
                    );

                    if (fullMatchResponse.data.status === 'success') {
                        this.stats.fullMatches++;
                        logger.info(`Full match successful for ${contract.address}`);
                        return {
                            success: true,
                            response: fullMatchResponse.data
                        };
                    }
                } catch (error) {
                    logger.debug(`Full match failed for ${contract.address}:`, {
                        status: error.response?.status,
                        data: error.response?.data
                    });
                }
            }

            // If configured and full match failed, try partial match
            if (this.shouldTryPartialMatch) {
                try {
                    const partialMatchResponse = await axios.post(
                        `${this.apiUrl}/verify`,
                        formData,
                        {
                            headers: formData.getHeaders(),
                            maxBodyLength: Infinity,
                            params: { partial: true }
                        }
                    );

                    if (partialMatchResponse.data.status === 'success') {
                        this.stats.partialMatches++;
                        logger.info(`Partial match successful for ${contract.address}`);
                        return {
                            success: true,
                            response: partialMatchResponse.data
                        };
                    }
                } catch (error) {
                    logger.debug(`Partial match failed for ${contract.address}:`, {
                        status: error.response?.status,
                        data: error.response?.data
                    });
                }
            }

            this.stats.failed++;
            return {
                success: false,
                error: 'Both full and partial matches failed'
            };

        } catch (error) {
            this.stats.failed++;
            logger.error(`Error submitting contract ${contract.address}:`, {
                message: error.message,
                response: error.response?.data
            });
            return {
                success: false,
                error: error.message,
                response: error.response?.data
            };
        }
    }

    _extractCompilerSettings(source) {
        // Extract pragma solidity version
        const pragmaMatch = source.match(/pragma solidity (\^?\d+\.\d+\.\d+|[\^\~]\d+\.\d+)/);
        const compilerVersion = pragmaMatch ? pragmaMatch[1] : '0.8.17';

        // Extract SPDX license
        const licenseMatch = source.match(/SPDX-License-Identifier: (.*)/);
        const license = licenseMatch ? licenseMatch[1].trim() : 'UNLICENSED';

        return {
            compilerVersion,
            license
        };
    }

    _createMetadata(contract) {
        // Use existing metadata if present
        if (contract.metadata) {
            return contract.metadata;
        }

        // Extract settings from source
        const { compilerVersion, license } = this._extractCompilerSettings(contract.source);

        // Get chain-specific EVM version
        const evmVersionMap = {
            1: 'london',    // Ethereum Mainnet
            137: 'paris',   // Polygon
            56: 'london',   // BSC
        };

        const evmVersion = evmVersionMap[this.chainId] || 'london';

        return {
            compiler: {
                version: compilerVersion,
            },
            language: "Solidity",
            output: {
                abi: [], // Empty ABI since we don't have it
                devdoc: {
                    kind: "dev",
                    methods: {},
                    version: 1
                },
                userdoc: {
                    kind: "user",
                    methods: {},
                    version: 1
                }
            },
            settings: {
                compilationTarget: {
                    [contract.filename]: contract.contractName
                },
                evmVersion: evmVersion,
                libraries: {},
                metadata: {
                    bytecodeHash: "ipfs",
                    useLiteralContent: true
                },
                optimizer: {
                    enabled: true,
                    runs: 200
                },
                remappings: []
            },
            sources: {
                [contract.filename]: {
                    content: contract.source,
                    keccak256: `0x${Buffer.from(keccak256(utf8ToBytes(contract.source))).toString('hex')}`,
                    license: license
                }
            },
            version: 1
        };
    }

    _handleApiError(error, address) {
        if (error.response) {
            // Handle rate limiting
            if (error.response.status === 429) {
                this.verificationStats.rateLimited++;
                logger.warn(`Rate limited while checking ${address}`);
                return false;
            }

            // Handle 404s (not found)
            if (error.response.status === 404) {
                logger.debug(`Contract ${address} not found in Sourcify`);
                return false;
            }
        }

        // Log other errors
        logger.error(`API error checking ${address}:`, error.message);
        this.verificationStats.failed++;
        this.verificationStats.lastError = error.message;
        return false;
    }

    _validateContractData(contract) {
        // Validate required fields for submission
        const required = ['address', 'filename', 'source'];
        return required.every(field => {
            const hasField = !!contract[field];
            if (!hasField) {
                logger.warn(`Missing required field ${field} in contract data`);
            }
            return hasField;
        });
    }

    getStats() {
        return {
            ...this.verificationStats,
            timestamp: new Date().toISOString()
        };
    }

    async submitMissingContracts(chainId) {
        const missingContractsPath = path.join('chains', 'ethereum', 'mainnet', 'missing_contracts.json');

        try {
            // Read missing contracts
            const missingContracts = JSON.parse(await fs.readFile(missingContractsPath, 'utf8'));
            logger.info(`Processing ${missingContracts.length} contracts from file`);

            for (const contract of missingContracts) {
                try {
                    // Format contract data for submission
                    const contractData = {
                        address: contract.address,
                        contractName: contract.contractName,
                        source: contract.source,
                        filename: contract.filename
                    };

                    // Submit to Sourcify
                    const result = await this.submitContract(contractData);

                    if (result) {
                        logger.info(`Successfully verified ${contract.address}`);
                    } else {
                        logger.error(`Failed to verify ${contract.address}`);
                    }

                    // Optional: Add delay between submissions to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 1000));

                } catch (error) {
                    logger.error(`Error submitting contract ${contract.address}:`, error.message);
                }
            }

        } catch (error) {
            logger.error('Error processing missing contracts:', error);
            throw error;
        }
    }

    async saveMetadata(contract, metadata) {
        const metadataPath = path.join(
            'chains',
            this.chainId.toString(),
            'metadata',
            `${contract.address}.json`
        );

        try {
            await fs.mkdir(path.dirname(metadataPath), { recursive: true });
            await fs.writeFile(
                metadataPath,
                JSON.stringify(metadata, null, 2)
            );
            logger.debug(`Saved metadata for ${contract.address}`);
        } catch (error) {
            logger.error(`Error saving metadata for ${contract.address}:`, error);
        }
    }
}
