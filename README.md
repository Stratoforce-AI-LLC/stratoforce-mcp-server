# StratoForce AI — MCP Server

Revenue intelligence from your Salesforce pipeline, accessible to any AI assistant.

## What It Does

Connects your Salesforce revenue data to any MCP-compatible AI client — Claude Desktop, VS Code, Cursor, Windsurf, and more. Ask natural-language questions about your pipeline and get real answers from real data.

## Capabilities

### Resources (read-only data)
| Resource | URI | Description |
|----------|-----|-------------|
| Pipeline Summary | `stratoforce://pipeline/summary` | Open deals by stage with totals |
| Top Deals | `stratoforce://pipeline/top-deals` | Top 15 opportunities by value |
| Active Alerts | `stratoforce://alerts/active` | Revenue intelligence alerts (last 7 days) |

### Tools (LLM-invokable functions)
| Tool | Description |
|------|-------------|
| `get_pipeline_health` | Comprehensive pipeline health: stages, velocity, win rate, stale deals |
| `get_deal_details` | Deep dive on any opportunity: contacts, conversations, scores |
| `generate_briefing` | AI pre-call briefing: stakeholders, competitive intel, talking points |
| `scan_risks` | Pipeline risk scan: stale deals, past-due close dates, dark champions |
| `search_deals` | Search deals by name, account, stage, or owner |

### Prompts (pre-built templates)
| Prompt | Description |
|--------|-------------|
| `pipeline_review` | Weekly pipeline review for sales meetings |
| `deal_coaching` | Deal-specific coaching with MEDDIC analysis |
| `forecast_prep` | Forecast call preparation briefing |

## Setup

### Prerequisites
- Node.js 20+
- Salesforce CLI (`sf`) with an authenticated org
- StratoForce AI managed package installed in your Salesforce org

### Install
```bash
cd stratoforce-mcp-server
npm install
```

### Configure Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "stratoforce": {
      "command": "node",
      "args": ["/path/to/stratoforce-mcp-server/index.js"],
      "env": {
        "SF_TARGET_ORG": "stratoforce-dev"
      }
    }
  }
}
```

### Test
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | node index.js
```

## Example Conversations

**"How's my pipeline looking?"**
→ Uses `get_pipeline_health` → Returns stage breakdown, win rate, stale deals, forecast

**"Generate a briefing for the Acme deal"**
→ Uses `search_deals` → finds Acme → Uses `generate_briefing` → Full pre-call prep

**"What deals are at risk?"**
→ Uses `scan_risks` → Returns stale deals, past-due close dates, score drops

**"Run the pipeline_review prompt"**
→ Executes full pipeline review combining all tools → Executive summary

## Architecture

```
AI Client (Claude/VS Code/Cursor)
    ↕ MCP Protocol (JSON-RPC over stdio)
StratoForce MCP Server (Node.js)
    ↕ Salesforce REST API + Apex REST
StratoForce Managed Package (data layer)
```

## License

MIT — StratoForce AI, LLC
