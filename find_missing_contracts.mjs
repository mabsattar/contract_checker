import yaml from 'js-yaml';
import fs from 'node:fs/promises';
import path from 'node:path';
import fetch from 'node-fetch';
import Bottleneck from 'bottleneck';
import pkg from 'solc';
const { compile } = pkg;


const SOURCIFY_API = 'https://repo.sourcify.dev/api';
const BASE_PATH = path.join(process.cwd(), 'config');
const CONFIG_FILE = path.join(BASE_PATH, 'paths.yaml');
const CACHE_FILE = path.join(BASE_PATH, 'sourcify_cache.json');


const limiter = new Bottleneck({
    minTime: 60000 // 60 seconds between requests
});


async function loadConfig() {
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf8');
        return yaml.load(data);
    } catch (error) {
        console.error('Error loading config:', error);
        throw error;
    }
}

async function getCachedContracts() {
    try {
        const cacheData = await fs.readFile(CACHE_FILE, 'utf8');
        return JSON.parse(cacheData);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // File does not exist, return empty object
            return {};
        } else {
            console.error('Error reading cache:', error);
            return {}; // Return empty object on other errors
        }
    }
}


async function saveCachedContracts(contracts) {
    await fs.writeFile(CACHE_FILE, JSON.stringify(contracts, null, 2));
}

async function checkContract(contractAddress) {
    try {
        const response = await fetch(`${SOURCIFY_API}/contracts/${contractAddress}`);
        if (response.ok) {
            return true;
        } else {
            return false;
        }
    } catch (error) {
        console.error('Error checking contract:', error);
        throw error;
    }
}


async function compileContract(contractSource) {
    try {
        const input = {
            language: 'Solidity',
            sources: {
                'contract.sol': {
                    content: contractSource,
                },
            },
            settings: {
                outputSelection: {
                    '*': {
                        '*': ['*'],
                    },
                },
            },
        };

        const output = compile(JSON.stringify(input));
        const contracts = output.contracts['contract.sol'];

        return contracts;
    } catch (error) {
        console.error('Error compiling contract:', error);
        throw error;
    }
}




async function submitContract(chain, contractAddress, contractSource) {
    if (!contractSource || !contractAddress || !chain) {
        throw new Error('Missing required parameters');
    }
    return limiter.schedule(async () => {
        const maxRetries = 3;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {

                const compiledContract = await compileContract(contractSource);
                const contract = compiledContract.contracts[contractAddress];

                const payload = {
                    address: contractAddress,
                    chain: chain,
                    files: [{ name: 'contract.sol', content: contractSource },
                    { name: 'metadata.json', content: JSON.stringify(contract.metadata) },
                    { name: 'abi.json', content: JSON.stringify(contract.abi) },
                    { name: 'bytecode.txt', content: contract.bytecode }
                    ]
                };

                const response = await fetch(`${SOURCIFY_API}/contracts`, {
                    method: 'POST',
                    body: JSON.stringify(payload),
                    headers: { 'Content-Type': 'application/json' }
                });

                if (response.ok) {
                    console.log(`Successfully submitted ${contractAddress} on ${chain}`);
                    return true;
                } else {
                    const errorText = await response.text();
                    console.error(`Failed to submit ${contractAddress}: ${errorText}`);
                }
            } catch (error) {
                if (attempt < maxRetries) {
                    console.log(`Attempt ${attempt} failed. Retrying...`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempt)); // Exponential backoff
                } else {
                    throw error;
                }
            }
        }
    });
}


async function processChainRepos() {
    try {
        const config = await loadConfig();
        const repoPath = config.ethereum_repo || path.join(BASE_PATH, '..', '..', 'smart-contract-sanctuary-ethereum', 'contracts');

        console.log("Checking contracts in:", repoPath);

        try {
            const contractFolders = await fs.readdir(repoPath);

            for (const folder of contractFolders) {
                const folderPath = path.join(repoPath, folder);
                const stat = await fs.stat(folderPath);

                if (stat.isDirectory()) {
                    // Read the .sol files within the folder
                    const contractFiles = await fs.readdir(folderPath);

                    for (const contractFile of contractFiles) {
                        if (contractFile.endsWith('.sol')) {
                            const contractAddress = contractFile.replace('.sol', '');
                            const contractContent = await fs.readFile(path.join(folderPath, contractFile), 'utf8');

                            console.log(`Processing contract ${contractAddress}...`);


                            const existingSource = await checkContract(contractAddress);
                            console.log(`Response status: ${existingSource ? 'OK' : 'Not Found'}`);

                            if (!existingSource) {
                                console.log(`Contract ${contractAddress} does not exist in Sourcify`);
                                await submitContract('ethereum', contractAddress, contractContent);
                            } else {
                                console.log(`Contract ${contractAddress} exists in Sourcify`);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error processing repos:', error);
        }
    }
    catch (error) {
        console.error('Error processing repos:', error);
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
        console.error('An error occurred:', error);
    }
}

main().catch(console.error);
