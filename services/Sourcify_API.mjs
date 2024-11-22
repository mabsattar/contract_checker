import axios from 'axios';
import { logger } from '../utils/logger.mjs';
import path from 'path';
import fs from 'fs/promises';
import { keccak256 } from 'ethereum-cryptography/keccak';
import { utf8ToBytes } from 'ethereum-cryptography/utils';

export class SourcifyAPI {
  constructor(config) {
    this.chainId = config.chain_id;
    this.apiUrl = config.sourcify_api;
    this.timeout = config.sourcify.timeout;

    logger.info('sourcifyApi initialized with:', {
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

  async submitMissingContracts() {
    const missingContractsPath = path.join(this.chainOutputDir, 'missing_contracts.json');
    const startTime = Date.now();

    try {
      const missingContracts = JSON.parse(await fs.readFile(missingContractsPath, 'utf8'));
      const totalContracts = missingContracts.length;

      logger.info(`Starting verification of ${totalContracts} contracts`);

      // Process in batches of 5 contracts concurrently
      const batchSize = 5;
      let successCount = 0;
      let failureCount = 0;

      for (let i = 0; i < missingContracts.length; i += batchSize) {
        const batch = missingContracts.slice(i, i + batchSize);
        const batchPromises = batch.map(async (contract) => {
          try {
            const contractData = {
              address: contract.address,
              contractName: contract.contractName,
              source: this._validateSourceCode(contract.source),
              filename: contract.filename
            };

            logger.info(`🔄 Submitting contract ${contract.address}`);
            const result = await this.submitContract(contractData);

            if (result.success) {
              successCount++;
              logger.info(`✅ Successfully verified ${contract.address}`);
              return true;
            } else {
              failureCount++;
              logger.error(`❌ Failed to verify ${contract.address}: ${result.error}`);
              return false;
            }
          } catch (error) {
            failureCount++;
            logger.error(`❌ Error processing ${contract.address}:`, error);
            return false;
          }
        });

        await Promise.all(batchPromises);

        // Progress update after each batch
        const processed = i + batchSize;
        const progress = Math.min((processed / totalContracts * 100), 100).toFixed(1);
        const timeElapsed = Math.round((Date.now() - startTime) / 1000 / 60);

        logger.info(`
Progress: ${progress}% (${processed}/${totalContracts})
✅ Success: ${successCount} | ❌ Failed: ${failureCount}
⏱️ Time Elapsed: ${timeElapsed} minutes
                `);

        // Small delay between batches to prevent rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      logger.info(`
=== Verification Complete ===
Total Contracts: ${totalContracts}
✅ Successful: ${successCount}
❌ Failed: ${failureCount}
⏱️ Total Time: ${Math.round((Date.now() - startTime) / 1000 / 60)} minutes
            `);

    } catch (error) {
      logger.error('Error processing contracts:', error);
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

  _validateSourceCode(source) {
    if (!source.includes('pragma solidity')) {
      // Add pragma if missing
      source = '// SPDX-License-Identifier: UNLICENSED\npragma solidity ^0.8.0;\n' + source;
    }
    return source;
  }
}
