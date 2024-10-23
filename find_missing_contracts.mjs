import yaml from "js-yaml";
import fs from "node:fs/promises";
import { promises as fsPromises } from 'node:fs';
import path from "node:path";
import fetch from "node-fetch";
import Bottleneck from "bottleneck";
import pLimit from "p-limit";
import pkg from "solc";
const { compile } = pkg;

const SOURCIFY_API = "https://repo.sourcify.dev/api";
const BASE_PATH = path.join(process.cwd(), "config");
const CONFIG_FILE = path.join(BASE_PATH, "paths.yaml");
const CACHE_FILE = path.join(BASE_PATH, "sourcify_cache.json");

const limit = pLimit(5); // Set limit of 5 concurrent promises

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
            const response = await fetch(`${SOURCIFY_API}/contracts/${contractAddress}`);
            return response.ok;
        } catch (error) {
            if (error.code === 'ETIMEDOUT' && i < maxRetries - 1) {
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

const cache = await getCachedContracts();

const submittedContractsFile = path.join(BASE_PATH, "submitted_contracts.json");

async function submitContract(chain, contractAddress, contractSource) {
    console.log(`Submitting contract ${contractAddress} to Sourcify...`);

    // Check if the contract has already been submitted
    if (!contractSource || !contractAddress || !chain) {
        throw new Error("Missing required parameters");
    }

    // Ensure the submitted contracts file exists
    try {
        await fs.access(submittedContractsFile);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await fs.writeFile(submittedContractsFile, '[]'); // Create an empty JSON array
        } else {
            throw error;
        }
    }

    let contractList;

    try {
        const submittedContracts = await fs.readFile(submittedContractsFile, 'utf8');
        contractList = JSON.parse(submittedContracts);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File does not exist, create an empty array
            contractList = [];
        } else {
            throw error;
        }
    }


    // Log the contract address to the file
    if (!contractList.includes(contractAddress)) {
        contractList.push(contractAddress);
        await fs.writeFile(submittedContractsFile, JSON.stringify(contractList));

    }
    return limiter.schedule(async () => {
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const existingSource = await checkContract(contractAddress);
                if (existingSource) {
                    console.log(
                        `Skipping contract ${contractAddress} as it's already submitted.`
                    );
                    return true;
                }

                // This will compile only if the metadata is not available
                const compiledContract = await compileContract(contractSource);
                const contract = compiledContract?.contracts?.["contract.sol"];

                if (!contract) {
                    console.error(`Compilation failed for contract ${contractAddress}`);
                    return false; // Return false on failure
                }

                console.log(`Submitting ${contractAddress} on ${chain}`);

                const payload = {
                    address: contractAddress,
                    chain: chain,
                    files: [
                        { name: "contract.sol", content: contractSource },
                        {
                            name: "metadata.json",
                            content: JSON.stringify(contract.metadata),
                        },
                        { name: "abi.json", content: JSON.stringify(contract.abi) },
                        { name: "bytecode.txt", content: contract.evm.bytecode.object },
                    ],
                };

                const response = await fetch(`${SOURCIFY_API}/contracts`, {
                    method: "POST",
                    body: JSON.stringify(payload),
                    headers: { "Content-Type": "application/json" },
                });

                if (response.ok) {
                    console.log(`Successfully submitted ${contractAddress} on ${chain}`);
                    cache[contractAddress] = {
                        chain,
                        submitted: true,
                        timestamp: new Date().toISOString(),
                        metadata: {
                            abi: contract.abi,
                            bytecode: contract.evm.bytecode.object,
                            metadata: contract.metadata,
                        },
                    };
                    await saveCachedContracts(cache);
                    return true;
                } else {
                    const errorText = await response.text();
                    console.error(`Failed to submit ${contractAddress}: ${errorText}`);
                    return false; // Return false if submission fails
                }
            } catch (error) {
                console.error(`Error submitting contract ${contractAddress}:`, error);
                if (attempt < maxRetries) {
                    console.log(`Attempt ${attempt} failed. Retrying...`);
                    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
                } else {
                    throw error; // Throw error after max retries
                }
            }
        }
    });
}

async function logError(errorMessage) {
    const logFile = path.join(BASE_PATH, "error.log");
    const timestamp = new Date().toISOString();
    await fs.appendFile(logFile, `[${timestamp}] ${errorMessage}\n`);
}

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
                "contracts"
            );
        const cache = await getCachedContracts();

        console.log("Checking contracts in:", repoPath);

        const contractFolders = await fs.readdir(repoPath);
        let contractCount = 0;
        let missingContractCount = 0;
        let submittedContractCount = 0;
        let skippedContractCount = 0;

        let missingContracts = []; // Initialize an array to store missing contracts

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
                            const contractAddress = contractFile.replace(".sol", "");
                            const contractContent = await fs.readFile(
                                path.join(folderPath, contractFile),
                                "utf8"
                            );

                            if (cache[contractAddress]) {
                                console.log(
                                    `Skipping contract ${contractAddress} as it's already in the cache.`
                                );
                                skippedContractCount++;
                            } else {
                                try {
                                    console.log(`Processing contract ${contractAddress}...`);

                                    const existingSource = await checkContract(contractAddress);
                                    console.log(
                                        `Response status: ${existingSource ? "OK" : "Not Found"}`
                                    );

                                    if (!existingSource) {
                                        console.log(
                                            `Contract ${contractAddress} does not exist in Sourcify`
                                        );
                                        //adding the missing contract address to the array
                                        missingContracts.push(contractAddress);
                                        const submitted = await submitContract(
                                            "ethereum",
                                            contractAddress,
                                            contractContent
                                        );
                                        if (submitted) {
                                            missingContractCount++;
                                            submittedContractCount++;
                                        }
                                    } else {
                                        skippedContractCount++;
                                        console.log(
                                            `Contract ${contractAddress} exists in Sourcify`
                                        );
                                    }

                                    contractCount++;
                                    console.log(
                                        `Processed ${contractCount} contracts. Missing: ${missingContractCount}. Submitted: ${submittedContractCount}.`
                                    );
                                } catch (err) {
                                    console.error(
                                        `Error processing contract ${contractAddress}:`,
                                        err
                                    );
                                }
                            }
                        });

                    await Promise.all(contractPromises); // Wait for all contracts in this folder
                }
            });

            // Wait for the batch to complete before processing the next batch
            await Promise.all(batchPromises);
        }

        if (missingContracts.length > 0) {
            console.log(`Missing contracts: ${missingContracts.join(", ")}`);
        } else {
            console.log("No missing contracts found.");
        }
    } catch (error) {
        console.error("Error processing repos:", error);
        throw error; // Re-throw if you want to handle it further up the call stack
    }
}

async function retryFetch(fetchFunction, retries = MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fetchFunction();
        } catch (error) {
            if (error.code === "ETIMEDOUT" && i < retries - 1) {
                console.warn(`Retrying due to timeout... (${i + 1}/${retries})`);
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY)); // Wait before retrying
            } else {
                throw error; // Re-throw other errors or last retry error
            }
        }
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
