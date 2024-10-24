import yaml from "js-yaml";
import fs from "node:fs/promises";
import path from "node:path";
import fetch from "node-fetch";
import Bottleneck from "bottleneck";
import pkg from "solc";
const { compile } = pkg;

const SOURCIFY_API = "https://repo.sourcify.dev/api";
const BASE_PATH = path.join(process.cwd(), "config");
const CONFIG_FILE = path.join(BASE_PATH, "paths.yaml");
const CACHE_FILE = path.join(BASE_PATH, "sourcify_cache.json");
const missingContractsFile = path.join(process.cwd(), "missing_contracts.json");



const limiter = new Bottleneck({
  minTime: 5000, // 5 seconds between requests
});

async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, "utf8");
    return yaml.load(data);
  } catch (error) {
    console.error("Error loading config:", error);
    throw error;
  }
}

async function getCachedContracts() {
  try {
    const cacheData = await fs.readFile(CACHE_FILE, "utf8");
    return JSON.parse(cacheData);
  } catch (error) {
    if (error.code === "ENOENT") {
      // File does not exist, return empty object
      return {};
    } else {
      console.error("Error reading cache:", error);
      return {}; // Return empty object on other errors
    }
  }
}

async function saveCachedContracts(contracts) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(contracts, null, 2));
}

async function checkContract(contractAddress) {
  const maxRetries = 3;
  const retryDelay = 5000; // 5 seconds

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(
        `${SOURCIFY_API}/contracts/${contractAddress}`,
      );
      return response.ok;
    } catch (error) {
      if (error.code === "ETIMEDOUT" && i < maxRetries - 1) {
        console.log(`Retrying due to timeout... (${i + 1}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      } else {
        throw error;
      }
    }
  }
}

async function compileContract(contractSource) {
  try {
    const input = {
      language: "Solidity",
      sources: {
        "contract.sol": {
          content: contractSource,
        },
      },
      settings: {
        outputSelection: {
          "*": {
            "*": ["*"],
          },
        },
      },
    };

    const output = compile(JSON.stringify(input));
    if (output.errors) {
      console.error("Error compiling contract:", output.errors);
      throw new Error("Compilation failed");
    }

    const contracts = output.contracts["contract.sol"];
    return contracts;
  } catch (error) {
    console.error("Error compiling contract:", error);
    throw error;
  }
}


/*async function findMissingContracts() {
  try {
    const config = await loadConfig();
    const repoPath =
      config.ethereum_repo ||
      path.join(
        BASE_PATH,
        "..",
        "..",
        "smart-contract-sanctuary-ethereum",
        "contracts",
      );
    const cache = await getCachedContracts();

    const contractFolders = await fs.readdir(repoPath);
    const missingContracts = contractFolders
      .filter((folder) => !cache[folder])
      .map((folder) => path.join(repoPath, folder));

    return missingContracts;
  } catch (error) {
    console.error("Error finding missing contracts:", error);
    throw error;
  }
}
*/
const BATCH_SIZE = 10; // Set your desired batch size
const MAX_RETRIES = 3; // Maximum number of retries for failed requests
const RETRY_DELAY = 2000; // Delay between retries in milliseconds

async function processChainRepos() {
  try {
    const config = await loadConfig();
    const repoPath =
      config.ethereum_repo ||
      path.join(
        BASE_PATH,
        "..",
        "..",
        "smart-contract-sanctuary-ethereum",
        "contracts",
      );
    const cache = await getCachedContracts();

    console.log("Checking contracts in:", repoPath);

    const contractFolders = await fs.readdir(repoPath);
    let contractCount = 0;
    let missingContractCount = 0;
    let skippedContractCount = 0;

    const missingContracts = {}; // object to store missing contracts
    const formattedContracts = [];

    for (let i = 0; i < contractFolders.length; i += BATCH_SIZE) {
      const batch = contractFolders.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map(async (folder) => {
        const folderPath = path.join(repoPath, folder);
        const stat = await fs.stat(folderPath);

        if (stat.isDirectory()) {
          const contractFiles = await fs.readdir(folderPath);
          const contractPromises = contractFiles
            .filter((file) => file.endsWith(".sol"))
            .map(async (contractFile) => {
              const contractAddress = contractFile.replace(".sol", "").replace(/[^a-zA-Z0-9]/g, "");
              const contractContent = await fs.readFile(path.join(folderPath, contractFile), "utf8");

              if (cache[contractAddress]) {
                console.log(`Skipping contract ${contractAddress} as it's already in the cache.`);
                skippedContractCount++;
              } else {
                try {
                  console.log(`Processing contract ${contractAddress}...`);

                  const existingSource = await checkContract(contractAddress);
                  console.log(`Response status: ${existingSource ? "OK" : "Not Found"}`);

                  if (!existingSource) {
                    console.log(`Contract ${contractAddress} does not exist in Sourcify`);
                    missingContracts[contractAddress] = {
                      name: contractFile,
                      address: contractAddress,
                      content: contractContent,
                    };
                    missingContractCount++;

                    // Add contract data to submittedContracts array
                    formattedContracts.push({
                      name: contractFile,
                      address: contractAddress,
                      content: contractContent, // Include contract content
                    });
                  } else {
                    skippedContractCount++;
                    console.log(`Contract ${contractAddress} exists in Sourcify`);
                  }

                  contractCount++;
                  console.log(`Processed ${contractCount} contracts. Missing: ${missingContractCount}. Skipped: ${skippedContractCount}.`);
                } catch (err) {
                  console.error(`Error processing contract ${contractAddress}:`, err);
                }
              }
            });

          await Promise.all(contractPromises); // Wait for all contracts in this folder
        }
      });

      await Promise.all(batchPromises);
    }

    console.log(`Found ${missingContractCount} missing contracts.`);



    // Save missing contracts data to missing_contracts.json
    if (Object.keys(missingContracts).length > 0) {
      await fs.writeFile(missingContractsFile, JSON.stringify(missingContracts, null, 2));
      console.log(`Missing contracts data saved to missing_contracts.json.`);
    } else {
      console.log("No missing contracts found.");
    }
  } catch (error) {
    console.error("Error processing repos:", error);
    throw error;
  }
}

async function main() {
  try {
    console.log("Starting contract checker...");

    const config = await loadConfig();
    console.log("Loaded configuration:", config);

    await processChainRepos();

    console.log("Contract checking completed.");
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

main().catch(console.error);
