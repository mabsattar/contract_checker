# Contract Checker for Ethereum

This script compares contracts from the `smart-contract-sanctuary` repository against those in the Sourcify repository. It identifies and submits any missing contracts.

### Prerequisites

Node.js installed on your system
Playwright installed globally (npm install -g playwright)
Required npm packages installed in the project directory

### Installation

Clone the smart-contract-sanctuary-ethereum repository.
Navigate to the project directory:

```
cd ~/path/to/contract_checker
```

### Install project dependencies

```
npm install
```

### Usage

1. Ensure you're in the project directory:

`cd ~/path/to/contract_checker`

2. Run the script:

`node find_missing_contracts.js`

### Configuration

##### Edit config/paths.yaml to set the paths

ethereum_repo:

```
/path/to/smart-contract-sanctuary-ethereum/contracts
```

sourcify_repo:

```
/path/to/sourcify
```
