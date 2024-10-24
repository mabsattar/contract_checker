import yaml from "js-yaml";
import fs from "node:fs/promises";
import fetch from "node-fetch";
import Bottleneck from "bottleneck";
import { Octokit } from '@octokit/rest';
import path from "node:path";


const GITHUB_TOKEN = 'process.env.GITHUB_TOKEN'; // Replace with your actual token
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const SOURCIFY_API = "https://repo.sourcify.dev/api";
const BASE_PATH = path.join(process.cwd(), "config");
const CONFIG_FILE = path.join(BASE_PATH, "paths.yaml");
const CACHE_FILE = path.join(BASE_PATH, "sourcify_cache.json");
const missingContractsFile = path.join(process.cwd(), "missing_contracts.json");

const limiter = new Bottleneck({
  minTime: 1000, // 1 seconds between requests
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

async function checkContract(contractAddress, config, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = `${SOURCIFY_API}/verify/${contractAddress}/${config.chain_id}`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        },
        timeout: 5000 // Set a 5-second timeout
      }, {
        body: JSON.stringify({
          address: contractAddress,
          chainId: config.chain_id,
          bytecode: contractBytecode,
          // other necessary fields...
        }),
      });

      if (!response.ok) {
        console.error(`Error checking contract (${attempt}/${maxRetries}): ${response.status} ${response.statusText}`);
        continue;
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const responseBody = await response.text(); // Read the response body for debugging
        console.error(`Unexpected content type (${attempt}/${maxRetries}): ${contentType}`);
        console.log(`Response body: ${responseBody}`);
        continue;
      }

      const data = await response.json();

      if (data[contractAddress]) {
        console.log(`Contract ${contractAddress} exists in Sourcify`);
        return true;
      } else {
        console.log(`Contract ${contractAddress} missing, added to list.`);
        return false;
      }
    } catch (error) {
      console.error(`Attempt ${attempt}/${maxRetries} failed: ${error.message}`);
      if (attempt < maxRetries) {
        console.log(`Retrying... (${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retrying
      } else {
        console.error(`Max retries reached. Giving up for contract ${contractAddress}.`);
        return false;
      }
    }
  }

  // If we reach here, all retries failed
  console.error(`All retries failed for contract ${contractAddress}`);
  return false;
}



async function processContracts(config) {
  try {
    const repoUrl = config.ethereum_repo;
    const parts = repoUrl.split('/');

    const owner = repoParts[3]; // e.g., "tintinweb"
    const repoName = repoParts[4]; // e.g., "smart-contract-sanctuary-ethereum"
    const path = repoParts.slice(5).join('/'); // e.g., "contracts/mainnet"


    // Fetch contents of the repository
    const response = await octokit.rest.repos.getContent({
      owner,
      repo: repoName,
      path,
    });


    if (!response.data || !Array.isArray(response.data)) {
      throw new Error('Failed to fetch repository contents');
    }

    const contents = response.data;

    let processedCount = 0;
    const formattedContracts = [];

    // Process contracts in the fetched contents
    for (const item of contents) {
      if (item.type === 'file' && item.name.endsWith('.sol')) {
        processedCount++;
        console.log(`Processing contract ${processedCount}/${contents.length}...`);

        const contractAddress = item.name.replace('.sol', '').replace(/[^a-zA-Z0-9]/g, '');
        const contractExists = await checkContract(contractAddress, config);

        if (!contractExists) {
          formattedContracts.push({
            name: item.name,
            address: contractAddress,
            bytecode: '',
            abi: [],
          });
          console.log(`Contract ${contractAddress} missing, added to list.`);
        }
      }
    }

    if (formattedContracts.length > 0) {
      await fs.writeFile(missingContractsFile, JSON.stringify(formattedContracts, null, 2));
      console.log(`Missing contracts data saved to ${missingContractsFile}.`);
    } else {
      console.log("No missing contracts found.");
    }
  } catch (error) {
    console.error("Error processing contracts:", error);
  }
}



// Update main function to pass config
async function main() {
  try {
    console.log("Starting contract checker...");

    const config = await loadConfig();
    console.log("Loaded configuration:", config);

    // Process all contracts in one go
    await processContracts(config);

    console.log("Contract checking completed.");
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

main().catch(console.error);
