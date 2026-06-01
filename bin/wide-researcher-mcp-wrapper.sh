#!/bin/bash
# Wrapper that sets LLM env vars for the interpreter worker before spawning the MCP server

export WR_LLM_BASE_URL="https://api.minimax.io/anthropic/v1"
export WR_LLM_API_KEY="sk-cp-nqs60Hj946hUP-Z2eIpG3Kvhfh6_Mgz2xPnGFzKr6dO2whR45elLnqyPeYa8n5cX9HIdk16W_WzazFHOtPwWBoujBFoyDp0qt3CYqj9Y__9NELS0LnNCDzg"
export WR_LLM_MODEL="MiniMax-M2.7-highspeed"
export WR_LLM_API_KEY_HEADER="x-api-key"
export WR_LLM_TIMEOUT="30"

exec node /var/www/wide-researcher/bin/wide-researcher-mcp.js "$@"
