import yaml from "js-yaml";
import fs from "node:fs/promises";
import path, { format } from "node:path";
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

async function checkContract(contractAddress) {
  try {
    const response = await fetch(
      `${SOURCIFY_API}/contracts/${contractAddress}`
    );
    return response.ok;
  } catch (error) {
    console.error("Error checking contract:", error);
    return false; // Return false on error to skip that contract
  }
}


/**
 * Compile a Solidity contract given its source code.
 * @param {string} contractSource - Source code of the contract.
 * @returns {Promise<object>} - The compiled contract, or throws an error if compilation fails.
 */
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

async function processContracts() {
  try {
    const config = await loadConfig();
    const repoPath = config.ethereum_repo;

    const contractFolders = await fs.readdir(repoPath);
    const formattedContracts = [];

    for (const folder of contractFolders) {
      const folderPath = path.join(repoPath, folder);
      const contractFiles = await fs.readdir(folderPath);

      for (const contractFile of contractFiles) {
        if (!contractFile.endsWith(".sol")) continue;

        const contractAddress = contractFile.replace(".sol", "").replace(/[^a-zA-Z0-9]/g, "");
        console.log(`Processing contract ${contractAddress}...`);

        const contractExists = await checkContractInSourcify(contractAddress);
        if (contractExists) {
          console.log(`Contract ${contractAddress} exists in Sourcify`);
          continue;
        }

        const contractContent = await fs.readFile(path.join(folderPath, contractFile), "utf8");
        const compiledContract = await compileContract(contractContent);
        const contractName = path.basename(contractFile);

        formattedContracts.push({
          name: contractName,
          address: contractAddress,
          bytecode: compiledContract.bytecode || '',
          abi: compiledContract.abi || []
        });

        console.log(`Contract ${contractAddress} missing, added to list.`);
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



async function main() {
  try {
    console.log("Starting contract checker...");

    const config = await loadConfig();
    console.log("Loaded configuration:", config);

    await processContracts();

    console.log("Contract checking completed.");
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

main().catch(console.error);
