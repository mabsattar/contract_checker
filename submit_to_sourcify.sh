#!/bin/bash

# Configuration
PROJECT_PATH="/home/absystem/opensource/smart-contract-sanctuary-ethereum"
CONTRACTS_JSON="$PROJECT_PATH/mainnet/contracts/contracts.json"
MAINNET_DIR="$PROJECT_PATH/mainnet"
OUTPUT_FILE="$home/absyste/opensource/contract_checker/sourcify_submission_results.json"
CHAIN_ID=1  # Mainnet chain ID

# Ensure output file exists
echo "[]" > "$OUTPUT_FILE"

# Helper function to log results
log_result() {
  local address=$1
  local status=$2
  jq ". += [{\"address\": \"$address\", \"status\": \"$status\"}]" "$OUTPUT_FILE" > tmp.json && mv tmp.json "$OUTPUT_FILE"
}

# Process contracts.json line by line
while IFS= read -r line; do
  # Parse JSON fields
  name=$(echo "$line" | jq -r '.name')
  address=$(echo "$line" | jq -r '.address')
  compiler=$(echo "$line" | jq -r '.compiler')

  echo "Processing contract: $name at $address with compiler $compiler"

  # Locate corresponding Solidity source file
  source_file=$(find "$MAINNET_DIR" -name "$name.sol")
  if [ -z "$source_file" ]; then
    echo "Source file not found for $name ($address)"
    log_result "$address" "source file not found"
    continue
  fi

  # Recompile contract using Foundry to regenerate metadata
  echo "Recompiling $source_file with $compiler..."
  export SOLC_VERSION="${compiler/v/}"  # Strip the 'v' from compiler version
  forge build --use "$source_file" --compiler-version "$SOLC_VERSION" || {
    echo "Failed to recompile $name ($address)"
    log_result "$address" "compilation failed"
    continue
  }

  # Locate metadata
  metadata_file="out/$name.metadata.json"
  if [ ! -f "$metadata_file" ]; then
    echo "Metadata not generated for $name ($address)"
    log_result "$address" "metadata not found"
    continue
  fi

  # Submit to Sourcify
  echo "Submitting $name ($address) to Sourcify..."
  response=$(curl -s -o /dev/null -w "%{http_code}" -X POST "https://sourcify.dev/api/v1/verify" \
    -H "Content-Type: multipart/form-data" \
    -F "address=$address" \
    -F "chain=$CHAIN_ID" \
    -F "contractName=$name" \
    -F "metadata=@$metadata_file" \
    -F "source=@$source_file")

  if [ "$response" -eq 200 ] || [ "$response" -eq 201 ]; then
    echo "Successfully submitted $name ($address) to Sourcify."
    log_result "$address" "success"
  else
    echo "Failed to submit $name ($address) to Sourcify. HTTP status: $response"
    log_result "$address" "submission failed"
  fi
done < <(jq -c '.' "$CONTRACTS_JSON")

echo "Submission process completed. Results saved to $OUTPUT_FILE."
