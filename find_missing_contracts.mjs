import { Config } from './config/config.mjs';
import { logger } from './utils/logger.mjs';
import { CacheManager } from './utils/cache.mjs';
import { SourcifyAPI } from './services/sourcify-api.mjs';
import { ContractProcessor } from './services/contract-processor.mjs';


async function extractCompilerVersion(sourceCode) {
  const versionRegex = /pragma solidity (\^?\d+\.\d+\.\d+)/;
  const match = sourceCode.match(versionRegex);
  return match ? match[1].replace('^', '') : null;
}

function isValidContract(source) {
  return source.includes('contract') &&
    source.includes('pragma solidity') &&
    source.length > 100; // Basic size check
}

function validateContract(contractData) {
  const required = ['address', 'source', 'compilerVersion'];
  for (const field of required) {
    if (!contractData[field]) {
      throw new Error(`Missing required field: ${field}`);
    }
  }
}

async function processingChain() {
  try {
    const config = await loadConfig();
    const repoPath = config.ethereum_repo || path.join(BASE_PATH, "..", "..", "smart-contract-sanctuary-ethereum", "contracts", "mainnet");
    const cache = await getCachedContracts();

    logger.info("Starting contract processing from:", repoPath);

    const contractFolders = await fs.readdir(repoPath);
    const missingContracts = [];

    // Initialize missing contracts file
    await fs.writeFile(MISSING_CONTRACTS_FILE, JSON.stringify([]));

    // Process folders in batches
    for (let i = 0; i < contractFolders.length; i += BATCH_SIZE) {
      const batch = contractFolders.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (folder) => {
        const folderPath = path.join(repoPath, folder);
        const stat = await fs.stat(folderPath);

        if (stat.isDirectory()) {
          const contractFiles = await fs.readdir(folderPath);

          await Promise.all(
            contractFiles
              .filter(file => file.endsWith(".sol"))
              .map(async (contractFile) => {
                const contractPath = path.join(folderPath, contractFile);
                const contractContent = await fs.readFile(contractPath, "utf8");
                const contractAddress = contractFile.replace(".sol", "").toLowerCase();

                progress.total++;

                if (!isValidContract(contractContent)) {
                  logger.warn(`Invalid contract found: ${contractAddress}`);
                  return;
                }

                if (cache[contractAddress]) {
                  logger.info(`Skipping cached contract: ${contractAddress}`);
                  return;
                }

                const existsInSourcify = await checkContract(contractAddress);

                if (!existsInSourcify) {
                  missingContracts.push({
                    address: contractAddress,
                    source: contractContent,
                    path: contractPath
                  });

                  cache[contractAddress] = {
                    processed: false,
                    timestamp: new Date().toISOString()
                  };
                }

                progress.processed++;
              })
          );
        }
      }));

      // Save progress periodically
      await saveCachedContracts(cache);
      await fs.writeFile(
        MISSING_CONTRACTS_FILE,
        JSON.stringify(missingContracts, null, 2)
      );

      logger.info(`Progress: ${progress.processed}/${progress.total} contracts processed`);

      // Pause between folder batches
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Process missing contracts
    if (missingContracts.length > 0) {
      logger.info(`Processing ${missingContracts.length} missing contracts`);
      const results = await processContractsInBatches(missingContracts);

      // Update cache with results
      results.forEach(result => {
        if (result.success) {
          cache[result.address].processed = true;
          cache[result.address].verificationTimestamp = new Date().toISOString();
        }
      });

      await saveCachedContracts(cache);
    }

  } catch (error) {
    logger.error("Error in processing chain:", error);
    throw error;
  }
}

async function processMissingContracts(missingContracts) {
  for (const contract of missingContracts) {
    const contractAddress = contract.address;
    const contractContent = contract.source;
    await contractSubmission(contractAddress, contractContent);
  }
}




async function contractSubmission(contractAddress, contractContent) {
  const compilerVersion = await extractCompilerVersion(contractContent);
  const sourcifyApiUrl = "https://repo.sourcify.dev/api/contracts";
  const headers = {
    "Content-Type": "application/json",
  };

  contractAddress = `0x${contractAddress}`;


  const contractData = {
    address: contractAddress,
    contractName: path.basename(contractFiles),
    source: contractContent,
    compiler: "solidity",
    compilerVersion: "0.8.10",
    network: "mainnet",
    deploymentTransactionHash: "0x..."
  };


  const body = JSON.stringify(contractData);

  const response = await fetch(sourcifyApiUrl, {
    method: "POST",
    headers,
    body,
  });

  const responseBody = await response.json();
  const status = responseBody.status;

  if (status === "success") {
    console.log(`Contract ${contractAddress} submitted successfully to Sourcify.`);
    return { success: true, contractAdddress: contractAddress };
  } else {
    console.error(`Error submitting contract ${contractAddress} to Sourcify: ${status}`);
    return { success: false, contractAdddress: contractAddress };
  }
}




async function main() {
  try {
    console.log("Starting contract checker...");

    const config = await loadConfig();
    console.log("Loaded configuration:", config);

    await processingChain();

    console.log("Contract checking completed.");
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

main().catch(console.error);

