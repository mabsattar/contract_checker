#!/bin/bash

# Configuration
PROJECT_PATH="/home/absystem/opensource/smart-contract-sanctuary-ethereum/contracts"
CONTRACTS_JSON="$PROJECT_PATH/mainnet/contracts.json"
MAINNET_DIR="$PROJECT_PATH/mainnet"
OUTPUT_FILE="/home/absystem/opensource/contract_checker/sourcify_submission_results.json"
CHAIN_ID=1  # Mainnet chain ID

# Ensure output directory exists
mkdir -p "$(dirname "$OUTPUT_FILE")"
echo "[]" > "$OUTPUT_FILE"

# Enable full backtrace for Rust errors
export RUST_BACKTRACE=full

# Helper function to log results
log_result() {
  local address=$1
  local status=$2
  jq ". += [{\"address\": \"$address\", \"status\": \"$status\"}]" "$OUTPUT_FILE" > tmp.json && mv tmp.json "$OUTPUT_FILE"
}

# Helper function to check if the contract is verified using Foundry's Sourcify integration
check_if_verified() {
  local address=$1
  echo "Checking if $address is verified on Sourcify..."
  
  local result
  result=$(forge verify-check "$address" --chain-id "$CHAIN_ID" --verifier sourcify 2>&1)

  if echo "$result" | grep -q "is not verified"; then
    echo "$address is not verified on Sourcify, proceeding with submission..."
    return 1
  elif echo "$result" | grep -q "is already verified"; then
    echo "$address is already verified on Sourcify, skipping submission..."
    return 0
  else
    echo "Unexpected result from forge verify-check for $address: $result"
    return 1
  fi
}


# Process contracts.json line by line
while IFS= read -r line; do
  # Skip empty lines or malformed JSON
  if [ -z "$line" ] || ! echo "$line" | jq -e . > /dev/null 2>&1; then
    echo "Skipping malformed or empty line..."
    continue
  fi

  # Parse JSON fields
  name=$(echo "$line" | jq -r '.name // "Unknown"')
  address=$(echo "$line" | jq -r '.address // empty')
  compiler=$(echo "$line" | jq -r '.compiler // empty')

  if [ -z "$address" ]; then
    echo "Address missing for contract $name. Skipping..."
    log_result "Unknown" "address missing"
    continue
  fi

  echo "Processing contract: $name at $address with compiler $compiler"

  # Check if the contract is verified before compiling or submitting
  if check_if_verified "$address"; then
    log_result "$address" "already verified"
    continue
  fi

  # Extract the address without the '0x' prefix
  address_no_prefix=${address:2}

  # Locate corresponding Solidity source file recursively in the MAINNET_DIR
  source_file=$(find "$MAINNET_DIR" -type f -name "${address_no_prefix}_${name}.sol" | head -n 1)
  if [ -z "$source_file" ]; then
    echo "Source file not found for $name ($address)"
    log_result "$address" "source file not found"
    continue
  fi

  # Set the SOLC_VERSION environment variable
  export SOLC_VERSION="${compiler/v/}"  # Strip the 'v' from compiler version

  # Check if metadata already exists
  metadata_file="out/$name.metadata.json"
  if [ -f "$metadata_file" ]; then
    echo "Metadata already exists for $name ($address), skipping recompilation..."
  else
    # Recompile contract using Foundry to regenerate metadata
    echo "Recompiling $source_file with $compiler..."

    #compile using solc
    if compile_contract_with_solc "$source_file" "${compiler/v}" "$metadata_file"; then
      echo "Successfully compiled $name ($address) with $compiler"
    else
      echo "Failed to compile $name ($address) with $compiler"   
	log_result "$address" "compilation failed"
      continue
    fi
  fi

  # Check again if metadata was generated after compilation
  if [ ! -f "$metadata_file" ]; then
    echo "Metadata not generated for $name ($address)"
    log_result "$address" "metadata not found"
    continue
  fi

  # Submit to Sourcify using Foundry's built-in sourcify verifier
  echo "Submitting $name ($address) to Sourcify..."
  forge verify-contract "$address" "$source_file" --chain-id "$CHAIN_ID" --verifier sourcify || {
    echo "Failed to submit $name ($address) to Sourcify"
    log_result "$address" "submission failed"
    continue
  }

  echo "Successfully submitted $name ($address) to Sourcify."
  log_result "$address" "success"

done < <(jq -c '.' "$CONTRACTS_JSON")

echo "Submission process completed. Results saved to $OUTPUT_FILE."
