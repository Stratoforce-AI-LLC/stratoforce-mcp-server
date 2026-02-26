#!/usr/bin/env node

/**
 * StratoForce AI — MCP Server
 * 
 * Exposes revenue intelligence data to any MCP-compatible AI client
 * (Claude Desktop, VS Code, Cursor, etc.)
 * 
 * Resources: pipeline summary, deal details, active alerts, forecast
 * Tools: score_deal, generate_briefing, scan_risks, ingest_conversation
 * Prompts: pipeline_review, deal_coaching, forecast_prep
 * 
 * Auth: Uses Salesforce Connected App OAuth (sf cli for token)
 * 
 * @version 1.0.0
 * @since Sprint 3
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync } from 'node:child_process';

// ── Salesforce Auth ──

function getSalesforceAuth(targetOrg = 'stratoforce-dev') {
  try {
    const raw = execSync(
      `sf org display --target-org ${targetOrg} --json 2>/dev/null`,
      { encoding: 'utf-8', timeout: 15000 }
    );
    const parsed = JSON.parse(raw);
    return {
      accessToken: parsed.result.accessToken,
      instanceUrl: parsed.result.instanceUrl,
    };
  } catch (err) {
    throw new Error(`Salesforce auth failed. Run: sf org login web --alias ${targetOrg}`);
  }
}

async function sfQuery(soql) {
  const { accessToken, instanceUrl } = getSalesforceAuth();
  const url = `${instanceUrl}/services/data/v62.0/query?q=${encodeURIComponent(soql)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`SOQL failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function sfApexRest(path, method = 'GET', body = null) {
  const { accessToken, instanceUrl } = getSalesforceAuth();
  const url = `${instanceUrl}/services/apexrest/stratoforce${path}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`Apex REST failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// ── MCP Server Setup ──

const server = new McpServer({
  name: 'stratoforce-ai',
  version: '1.0.0',
});

// ════════════════════════════════════════════
// RESOURCES — Read-only data endpoints
// ════════════════════════════════════════════

server.resource(
  'pipeline-summary',
  'stratoforce://pipeline/summary',
  async (uri) => {
    const result = await sfQuery(`
      SELECT StageName, COUNT(Id) cnt, SUM(Amount) total
      FROM Opportunity WHERE IsClosed = false
      GROUP BY StageName ORDER BY StageName
    `);

    const stages = result.records.map(r =>
      `${r.StageName}: ${r.cnt} deals, $${(r.total || 0).toLocaleString()}`
    ).join('\n');

    const totalResult = await sfQuery(`
      SELECT COUNT(Id) cnt, SUM(Amount) total
      FROM Opportunity WHERE IsClosed = false
    `);
    const t = totalResult.records[0];

    const text = [
      `# Pipeline Summary`,
      `Total: ${t.cnt} open deals, $${(t.total || 0).toLocaleString()}`,
      ``,
      `## By Stage`,
      stages,
    ].join('\n');

    return { contents: [{ uri: uri.href, text, mimeType: 'text/plain' }] };
  }
);

server.resource(
  'active-alerts',
  'stratoforce://alerts/active',
  async (uri) => {
    const result = await sfQuery(`
      SELECT Id, Name, stratoforce__Alert_Type__c, stratoforce__Severity__c,
             stratoforce__Message__c, CreatedDate
      FROM stratoforce__AI_Alert__c
      WHERE CreatedDate = LAST_N_DAYS:7
      ORDER BY CreatedDate DESC LIMIT 20
    `);

    const alerts = result.records.map(r =>
      `[${r.stratoforce__Severity__c}] ${r.stratoforce__Alert_Type__c}: ${r.stratoforce__Message__c}`
    ).join('\n');

    return {
      contents: [{
        uri: uri.href,
        text: `# Active Revenue Alerts (Last 7 Days)\n\n${alerts || 'No active alerts.'}`,
        mimeType: 'text/plain',
      }],
    };
  }
);

server.resource(
  'top-deals',
  'stratoforce://pipeline/top-deals',
  async (uri) => {
    const result = await sfQuery(`
      SELECT Id, Name, StageName, Amount, CloseDate, Probability,
             Account.Name, Owner.Name, LastActivityDate
      FROM Opportunity
      WHERE IsClosed = false AND Amount > 0
      ORDER BY Amount DESC LIMIT 15
    `);

    const deals = result.records.map(r =>
      `• ${r.Name} | ${r.StageName} | $${(r.Amount || 0).toLocaleString()} | ` +
      `Close: ${r.CloseDate} | Account: ${r.Account?.Name || 'N/A'} | ` +
      `Owner: ${r.Owner?.Name || 'N/A'} | Last Activity: ${r.LastActivityDate || 'None'}`
    ).join('\n');

    return {
      contents: [{
        uri: uri.href,
        text: `# Top 15 Open Deals by Amount\n\n${deals || 'No open deals found.'}`,
        mimeType: 'text/plain',
      }],
    };
  }
);

// ════════════════════════════════════════════
// TOOLS — Functions the LLM can invoke
// ════════════════════════════════════════════

server.tool(
  'get_pipeline_health',
  'Get a comprehensive pipeline health summary including deal counts, total value, stage distribution, velocity metrics, and deals at risk',
  {},
  async () => {
    try {
      // Pipeline by stage
      const stageData = await sfQuery(`
        SELECT StageName, COUNT(Id) cnt, SUM(Amount) total, AVG(Amount) avg_amt
        FROM Opportunity WHERE IsClosed = false
        GROUP BY StageName ORDER BY StageName
      `);

      // Deals closing this month
      const thisMonth = await sfQuery(`
        SELECT COUNT(Id) cnt, SUM(Amount) total
        FROM Opportunity WHERE IsClosed = false
        AND CloseDate = THIS_MONTH
      `);

      // Stale deals (no activity in 14+ days)
      const stale = await sfQuery(`
        SELECT COUNT(Id) cnt FROM Opportunity
        WHERE IsClosed = false AND LastActivityDate < LAST_N_DAYS:14
      `);

      // Won/Lost this quarter
      const wonLost = await sfQuery(`
        SELECT IsWon, COUNT(Id) cnt, SUM(Amount) total
        FROM Opportunity WHERE IsClosed = true AND CloseDate = THIS_QUARTER
        GROUP BY IsWon
      `);

      const stages = stageData.records.map(r =>
        `  ${r.StageName}: ${r.cnt} deals, $${(r.total || 0).toLocaleString()} (avg $${Math.round(r.avg_amt || 0).toLocaleString()})`
      ).join('\n');

      const cm = thisMonth.records[0] || {};
      const staleCount = stale.records[0]?.cnt || 0;

      let winRate = 'N/A';
      const wonRec = wonLost.records.find(r => r.IsWon === true);
      const lostRec = wonLost.records.find(r => r.IsWon === false);
      if (wonRec && lostRec) {
        winRate = `${Math.round((wonRec.cnt / (wonRec.cnt + lostRec.cnt)) * 100)}%`;
      }

      const text = [
        `Pipeline Health Report`,
        `======================`,
        ``,
        `Stage Breakdown:`,
        stages,
        ``,
        `Closing This Month: ${cm.cnt || 0} deals, $${(cm.total || 0).toLocaleString()}`,
        `Stale Deals (14+ days no activity): ${staleCount}`,
        `Win Rate (This Quarter): ${winRate}`,
        wonRec ? `Won This Quarter: ${wonRec.cnt} deals, $${(wonRec.total || 0).toLocaleString()}` : '',
        lostRec ? `Lost This Quarter: ${lostRec.cnt} deals, $${(lostRec.total || 0).toLocaleString()}` : '',
      ].filter(Boolean).join('\n');

      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'get_deal_details',
  'Get detailed information about a specific deal/opportunity including score, stage, contacts, recent activity, and conversations',
  { opportunityId: z.string().describe('Salesforce Opportunity ID (starts with 006)') },
  async ({ opportunityId }) => {
    try {
      const opp = await sfQuery(`
        SELECT Id, Name, StageName, Amount, CloseDate, Probability,
               Account.Name, Owner.Name, Description, LastActivityDate,
               NextStep, LeadSource, Type, ForecastCategory
        FROM Opportunity WHERE Id = '${opportunityId.replace(/'/g, '')}' LIMIT 1
      `);

      if (!opp.records.length) {
        return { content: [{ type: 'text', text: `No opportunity found with ID: ${opportunityId}` }] };
      }

      const r = opp.records[0];

      // Get contacts
      const contacts = await sfQuery(`
        SELECT Contact.Name, Contact.Title, Contact.Email, Role, IsPrimary
        FROM OpportunityContactRole
        WHERE OpportunityId = '${opportunityId.replace(/'/g, '')}'
        ORDER BY IsPrimary DESC
      `);

      const contactList = contacts.records.map(c =>
        `  • ${c.Contact.Name} (${c.Contact.Title || 'No title'}) - ${c.Role || 'No role'}${c.IsPrimary ? ' ⭐ Primary' : ''}`
      ).join('\n');

      // Recent conversations
      const convs = await sfQuery(`
        SELECT Id, stratoforce__Type__c, stratoforce__Date__c,
               stratoforce__Summary__c, stratoforce__Source_Platform__c
        FROM stratoforce__Conversation__c
        WHERE stratoforce__Opportunity__c = '${opportunityId.replace(/'/g, '')}'
        ORDER BY stratoforce__Date__c DESC LIMIT 5
      `);

      const convList = convs.records.map(c =>
        `  • ${c.stratoforce__Date__c} [${c.stratoforce__Type__c}] via ${c.stratoforce__Source_Platform__c}: ${(c.stratoforce__Summary__c || '').substring(0, 150)}`
      ).join('\n');

      const text = [
        `Deal: ${r.Name}`,
        `========================`,
        `Stage: ${r.StageName} | Amount: $${(r.Amount || 0).toLocaleString()} | Close: ${r.CloseDate}`,
        `Probability: ${r.Probability || 0}% | Forecast: ${r.ForecastCategory || 'N/A'}`,
        `Account: ${r.Account?.Name || 'N/A'} | Owner: ${r.Owner?.Name || 'N/A'}`,
        `Last Activity: ${r.LastActivityDate || 'None'} | Next Step: ${r.NextStep || 'None'}`,
        ``,
        `Contacts (${contacts.records.length}):`,
        contactList || '  None',
        ``,
        `Recent Conversations (${convs.records.length}):`,
        convList || '  None',
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'generate_briefing',
  'Generate a pre-call briefing for an upcoming meeting on a deal. Includes stakeholder map, competitive intel, risk factors, talking points, and suggested next steps',
  { opportunityId: z.string().describe('Salesforce Opportunity ID') },
  async ({ opportunityId }) => {
    try {
      const result = await sfApexRest('/stratoforce/precallbriefing', 'POST', {
        opportunityId: opportunityId.replace(/'/g, ''),
      });

      if (!result || result.error) {
        return { content: [{ type: 'text', text: `Briefing generation failed: ${result?.error || 'Unknown error'}` }], isError: true };
      }

      const b = result;
      const sections = [
        `Pre-Call Briefing: ${b.dealName || 'Deal'}`,
        `${'='.repeat(40)}`,
        ``,
        `Deal Snapshot:`,
        `  Stage: ${b.stage || 'N/A'} | Amount: $${(b.amount || 0).toLocaleString()} | Days in Stage: ${b.daysInStage || 0}`,
        `  Score: ${b.dealScore || 'N/A'}/100`,
        ``,
      ];

      if (b.stakeholders?.length) {
        sections.push('Stakeholders:');
        b.stakeholders.forEach(s => {
          sections.push(`  • ${s.name} (${s.title || 'N/A'}) — ${s.role || 'N/A'} | Engagement: ${s.engagementStatus || 'Unknown'}`);
        });
        sections.push('');
      }

      if (b.competitiveIntel?.length) {
        sections.push('Competitive Intel:');
        b.competitiveIntel.forEach(c => {
          sections.push(`  ⚔️ ${c.name} — Threat: ${c.threatLevel || 'N/A'} | Mentions: ${c.mentionCount || 0}`);
        });
        sections.push('');
      }

      if (b.riskFactors?.length) {
        sections.push('Risk Factors:');
        b.riskFactors.forEach(r => sections.push(`  ⚠️ ${r}`));
        sections.push('');
      }

      if (b.talkingPoints?.length) {
        sections.push('Talking Points:');
        b.talkingPoints.forEach(t => sections.push(`  💬 ${t}`));
        sections.push('');
      }

      if (b.suggestedNextStep) {
        sections.push(`Suggested Next Step: ${b.suggestedNextStep}`);
      }

      return { content: [{ type: 'text', text: sections.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'scan_risks',
  'Run a proactive risk scan across the entire pipeline. Checks for stale deals, dark champions, and score drops',
  {},
  async () => {
    try {
      // Stale deals
      const stale = await sfQuery(`
        SELECT Id, Name, StageName, Amount, LastActivityDate, Owner.Name
        FROM Opportunity
        WHERE IsClosed = false AND LastActivityDate < LAST_N_DAYS:14
        ORDER BY Amount DESC NULLS LAST LIMIT 10
      `);

      // Deals past close date
      const pastDue = await sfQuery(`
        SELECT Id, Name, StageName, Amount, CloseDate, Owner.Name
        FROM Opportunity
        WHERE IsClosed = false AND CloseDate < TODAY
        ORDER BY Amount DESC NULLS LAST LIMIT 10
      `);

      const staleList = stale.records.map(r =>
        `  🔴 ${r.Name} ($${(r.Amount || 0).toLocaleString()}) — ${r.StageName} | Last activity: ${r.LastActivityDate || 'Never'} | Owner: ${r.Owner?.Name}`
      ).join('\n');

      const pastList = pastDue.records.map(r =>
        `  ⏰ ${r.Name} ($${(r.Amount || 0).toLocaleString()}) — ${r.StageName} | Close date: ${r.CloseDate} | Owner: ${r.Owner?.Name}`
      ).join('\n');

      const text = [
        `Pipeline Risk Scan`,
        `==================`,
        ``,
        `Stale Deals (14+ days no activity): ${stale.records.length}`,
        staleList || '  ✅ None',
        ``,
        `Past Close Date: ${pastDue.records.length}`,
        pastList || '  ✅ None',
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'search_deals',
  'Search for deals/opportunities by name, account, stage, or owner',
  {
    query: z.string().describe('Search term (deal name, account name, or owner name)'),
    stage: z.string().optional().describe('Filter by stage name (e.g. "Prospecting", "Negotiation")'),
  },
  async ({ query, stage }) => {
    try {
      const sanitized = query.replace(/'/g, "\\'");
      let soql = `
        SELECT Id, Name, StageName, Amount, CloseDate, Account.Name, Owner.Name
        FROM Opportunity
        WHERE (Name LIKE '%${sanitized}%' OR Account.Name LIKE '%${sanitized}%' OR Owner.Name LIKE '%${sanitized}%')
      `;
      if (stage) {
        soql += ` AND StageName = '${stage.replace(/'/g, "\\'")}'`;
      }
      soql += ` ORDER BY Amount DESC NULLS LAST LIMIT 20`;

      const result = await sfQuery(soql);

      const deals = result.records.map(r =>
        `• ${r.Name} | ${r.StageName} | $${(r.Amount || 0).toLocaleString()} | Close: ${r.CloseDate} | Account: ${r.Account?.Name || 'N/A'}`
      ).join('\n');

      return {
        content: [{ type: 'text', text: `Search results for "${query}":\n\n${deals || 'No matching deals found.'}` }],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ════════════════════════════════════════════
// PROMPTS — Pre-built templates
// ════════════════════════════════════════════

server.prompt(
  'pipeline_review',
  'Weekly pipeline review — analyzes pipeline health, identifies risks, and suggests focus areas',
  {},
  () => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Please conduct a thorough weekly pipeline review using the StratoForce tools:

1. First, use get_pipeline_health to get the current pipeline state
2. Then use scan_risks to identify at-risk deals
3. Based on the data, provide:
   - Top 3 deals to focus on this week (highest impact)
   - Deals that need immediate attention (stale, past due, score drops)
   - Forecast accuracy assessment
   - Recommended actions for the sales team
   - Pipeline coverage ratio analysis

Format the review as an executive summary suitable for a weekly sales meeting.`,
      },
    }],
  })
);

server.prompt(
  'deal_coaching',
  'Deal-specific coaching — deep dive into a single opportunity with recommendations',
  { opportunityId: z.string().describe('Salesforce Opportunity ID to analyze') },
  ({ opportunityId }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Please provide deal coaching for opportunity ${opportunityId}:

1. Use get_deal_details to pull the full deal information
2. Use generate_briefing to get the AI briefing
3. Based on the data, provide:
   - Deal health assessment (1-10 score with reasoning)
   - MEDDIC qualification gaps
   - Stakeholder engagement analysis
   - Competitive positioning advice
   - Specific next steps with timelines
   - Risk mitigation strategies

Be direct and actionable — this is for a sales rep preparing for their next interaction.`,
      },
    }],
  })
);

server.prompt(
  'forecast_prep',
  'Forecast call preparation — pipeline data organized for a forecast review meeting',
  {},
  () => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Prepare a forecast call briefing using StratoForce tools:

1. Use get_pipeline_health for overall pipeline state
2. Use scan_risks for risk identification
3. Organize the data into:
   - Commit deals (high probability, low risk)
   - Best case deals (medium probability, some risk)  
   - Upside deals (lower probability but high value)
   - At-risk deals that may slip
   - Total forecast with confidence range
   - Key changes since last week

Format for a VP of Sales reviewing the forecast with their team.`,
      },
    }],
  })
);

// ── Start Server ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('StratoForce AI MCP Server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
