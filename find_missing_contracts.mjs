import yaml from "js-yaml";
import fs from "node:fs/promises";
import fetch from "node-fetch";
import Bottleneck from "bottleneck";
import path from "node:path";

const SOURCIFY_API = "https://repo.sourcify.dev/api";
const BASE_PATH = path.join(process.cwd(), "config");
const CONFIG_FILE = path.join(BASE_PATH, "paths.yaml");
const CACHE_FILE = path.join(BASE_PATH, "sourcify_cache.json");
const missingContractsFile = path.join(process.cwd(), "missing_contracts.json");

const limiter = new Bottleneck({
  minTime: 3000, // 1 seconds between requests
});

async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, "utf8");
    console.log("Config data:", data);
    return yaml.load(data);
  } catch (error) {
    console.error("Error loading config:", error);
    throw error;
  }
}

async function getCachedContracts() {
  try {
    const cacheData = await fs.readFile(CACHE_FILE, "utf8");
    console.log("Loaded cached contracts:", cacheData);
    return JSON.parse(cacheData);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("Cache file not found. Starting with an empty cache.");
      return {};
    } else {
      console.error("Error reading cache:", error);
      return {};
    }
  }
}


async function saveCachedContracts(contracts) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(contracts, null, 2));
  console.log("Updated cache saved.");
}


async function checkContract(contractAddress, retries = 3) {
  try {
    const response = await limiter.schedule(() => fetch(`${SOURCIFY_API}/contracts/${contractAddress}`, { timeout: 5000 }));
    if (response.status === 429 && retries > 0) {
      console.log(`Sourcify API rate limit exceeded. Retrying in 5 seconds... (${retries} retries left)`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return checkContract(contractAddress, retries - 1);
    }
    console.log(`Sourcify API response for ${contractAddress}: ${response.status}`);
    return response.ok;
  } catch (error) {
    if (error.code === "ETIMEOUT" && retries > 0) {
      console.log(`Timeout for ${contractAddress}, Retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return checkContract(contractAddress, retries - 1);
    }
    console.error(`Error checking contract ${contractAddress}:`, error);
    return false;
  }
}




const BATCH_SIZE = 10; // Set your desired batch size

async function processContractsInBatches(contracts, batchSize = 100) {
  for (let i = 0; i < contracts.length; i += batchSize) {
    const batch = contracts.slice(i, i + batchSize);
    await Promise.all(batch.map(contractAddress => checkContract(contractAddress)));
    console.log(`Processed ${i + batchSize} contracts`);
    await new Promise(resolve => setTimeout(resolve, 10000)); // Pause for 10 seconds
  }
}



async function processChainRepos() {
  try {
    const config = await loadConfig();
    const repoPath = config.ethereum_repo || path.join(BASE_PATH, "..", "..", "smart-contract-sanctuary-ethereum", "contracts", "mainnet");
    const cache = await getCachedContracts();

    console.log("Checking contracts in:", repoPath);

    const contractFolders = await fs.readdir(repoPath);
    let contractCount = 0;
    let missingContractCount = 0;
    let skippedContractCount = 0;
    const missingContracts = [];

    await fs.writeFile(missingContractsFile, JSON.stringify([])); // Initialize missing contracts file

    // Loop through contract folders in batches
    for (let i = 0; i < contractFolders.length; i += 10) { // BATCH_SIZE = 10
      const batch = contractFolders.slice(i, i + 10);
      const batchPromises = batch.map(async (folder) => {
        const folderPath = path.join(repoPath, folder);
        const stat = await fs.stat(folderPath);

        if (stat.isDirectory()) {
          const contractFiles = await fs.readdir(folderPath);
          const contractPromises = contractFiles
            .filter((file) => file.endsWith(".sol"))
            .map(async (contractFile) => {
              const contractAddress = contractFile.replace(".sol", "").replace(/[^a-zA-Z0-9]/g, "");
              console.log(`Processing contract ${contractAddress}...`);


              try {
                const existingSource = await checkContract(contractAddress);

                if (!existingSource) {
                  console.log(`Contract ${contractAddress} does not exist in Sourcify`);
                  const missingContractData = {
                    name: path.basename(contractFile),
                    address: contractAddress,
                  };

                  missingContracts.push(missingContractData);
                  missingContractCount++;
                } else {
                  skippedContractCount++;
                  console.log(`Contract ${contractAddress} exists in Sourcify`);
                }
                contractCount++;
                console.log(`Processed ${contractCount} contracts. Missing: ${missingContractCount}. Skipped: ${skippedContractCount}.`);
              } catch (err) {
                console.error(`Error processing contract ${contractAddress}:`, err);
              }
            });
          await Promise.all(contractPromises);
        } else {
          console.log(`Skipping non-directory: ${folderPath}`);
        }
      });

      await Promise.all(batchPromises);
    }

    console.log(`Found ${missingContractCount} missing contracts.`);


    await processContractsInBatches(contractAddresses, BATCH_SIZE);

    console.log(`Processed ${contractCount} contracts. Missing: ${missingContractCount}. Skipped: ${skippedContractCount}.`);

    // Saves missing contracts data to missing_contracts.json
    if (missingContracts.length > 0) {
      console.log("Saving missing contracts data...");
      await fs.writeFile(missingContractsFile, JSON.stringify(missingContracts, null, 2));
      console.log(`Missing contracts data saved to missing_contracts.json.`);
    } else {
      console.log("No missing contracts found.");
    }

    // Update cache
    await saveCachedContracts(cache);

    // Log contents of missingContracts for verification
    console.log("Contents of missingContracts:", JSON.stringify(missingContracts, null, 2));
  } catch (error) {
    console.error("Error processing repos:", error);
    throw error;
  }
}



// Main function to initiate contract checking
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

