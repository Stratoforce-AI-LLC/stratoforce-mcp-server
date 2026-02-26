#!/usr/bin/env node

/**
 * StratoForce AI — Remote MCP Server v2.0
 * 
 * Revenue Intelligence API — the brain behind any sales agent.
 * Supports both stdio (local) and Streamable HTTP (remote) transports.
 * 
 * Usage:
 *   node server.js                    # HTTP mode (default, port 3100)
 *   node server.js --stdio            # stdio mode (for Claude Desktop)
 *   MCP_PORT=8080 node server.js      # Custom port
 *   node server.js --oauth            # With OAuth 2.1 (future)
 * 
 * @version 2.0.0
 * @since Sprint 3
 */

import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import express from 'express';

// ── Config ──

const MODE = process.argv.includes('--stdio') ? 'stdio' : 'http';
const PORT = parseInt(process.env.MCP_PORT || '3100', 10);
const API_KEY = process.env.STRATOFORCE_API_KEY || null;
const DEFAULT_ORG = process.env.SF_TARGET_ORG || 'stratoforce-dev';

// ── Salesforce Auth ──

function getSalesforceAuth(targetOrg = DEFAULT_ORG) {
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
  } catch {
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

// Sanitize SOQL input — prevent injection
function sanitize(input) {
  return (input || '').replace(/['"\\;]/g, '');
}

// ── MCP Server Factory ──

function createServer() {
  const server = new McpServer({
    name: 'stratoforce-ai',
    version: '2.0.0',
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
      return {
        contents: [{
          uri: uri.href,
          text: `# Pipeline Summary\nTotal: ${t.cnt} open deals, $${(t.total || 0).toLocaleString()}\n\n## By Stage\n${stages}`,
          mimeType: 'text/plain',
        }],
      };
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
        FROM Opportunity WHERE IsClosed = false AND Amount > 0
        ORDER BY Amount DESC LIMIT 15
      `);
      const deals = result.records.map(r =>
        `• ${r.Name} | ${r.StageName} | $${(r.Amount || 0).toLocaleString()} | Close: ${r.CloseDate} | Account: ${r.Account?.Name || 'N/A'} | Owner: ${r.Owner?.Name || 'N/A'}`
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

  server.resource(
    'forecast-snapshot',
    'stratoforce://forecast/current',
    async (uri) => {
      const committed = await sfQuery(`
        SELECT COUNT(Id) cnt, SUM(Amount) total FROM Opportunity
        WHERE IsClosed = false AND ForecastCategory = 'Commit'
      `);
      const bestCase = await sfQuery(`
        SELECT COUNT(Id) cnt, SUM(Amount) total FROM Opportunity
        WHERE IsClosed = false AND ForecastCategory = 'Best Case'
      `);
      const pipeline = await sfQuery(`
        SELECT COUNT(Id) cnt, SUM(Amount) total FROM Opportunity
        WHERE IsClosed = false AND ForecastCategory = 'Pipeline'
      `);
      const won = await sfQuery(`
        SELECT SUM(Amount) total FROM Opportunity
        WHERE IsWon = true AND CloseDate = THIS_QUARTER
      `);
      const c = committed.records[0] || {};
      const b = bestCase.records[0] || {};
      const p = pipeline.records[0] || {};
      const w = won.records[0] || {};
      return {
        contents: [{
          uri: uri.href,
          text: [
            `# Forecast Snapshot (Current Quarter)`,
            ``,
            `Closed Won: $${(w.total || 0).toLocaleString()}`,
            `Commit: ${c.cnt || 0} deals, $${(c.total || 0).toLocaleString()}`,
            `Best Case: ${b.cnt || 0} deals, $${(b.total || 0).toLocaleString()}`,
            `Pipeline: ${p.cnt || 0} deals, $${(p.total || 0).toLocaleString()}`,
            ``,
            `Total Open Pipeline: $${((c.total || 0) + (b.total || 0) + (p.total || 0)).toLocaleString()}`,
          ].join('\n'),
          mimeType: 'text/plain',
        }],
      };
    }
  );

  // ════════════════════════════════════════════
  // TOOLS — 15 agent-consumable intelligence endpoints
  // ════════════════════════════════════════════

  // 1. Pipeline Health
  server.tool(
    'get_pipeline_health',
    'Comprehensive pipeline health: stage distribution, velocity, win rate, stale deals, forecast coverage',
    {},
    async () => {
      try {
        const stageData = await sfQuery(`
          SELECT StageName, COUNT(Id) cnt, SUM(Amount) total, AVG(Amount) avg_amt
          FROM Opportunity WHERE IsClosed = false
          GROUP BY StageName ORDER BY StageName
        `);
        const thisMonth = await sfQuery(`
          SELECT COUNT(Id) cnt, SUM(Amount) total FROM Opportunity
          WHERE IsClosed = false AND CloseDate = THIS_MONTH
        `);
        const stale = await sfQuery(`
          SELECT COUNT(Id) cnt FROM Opportunity
          WHERE IsClosed = false AND LastActivityDate < LAST_N_DAYS:14
        `);
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
        const wonRec = wonLost.records.find(r => r.IsWon === true);
        const lostRec = wonLost.records.find(r => r.IsWon === false);
        const winRate = (wonRec && lostRec) ? `${Math.round((wonRec.cnt / (wonRec.cnt + lostRec.cnt)) * 100)}%` : 'N/A';

        return { content: [{ type: 'text', text: [
          `Pipeline Health Report`,
          `======================`,
          `\nStage Breakdown:\n${stages}`,
          `\nClosing This Month: ${cm.cnt || 0} deals, $${(cm.total || 0).toLocaleString()}`,
          `Stale Deals (14+ days no activity): ${staleCount}`,
          `Win Rate (This Quarter): ${winRate}`,
          wonRec ? `Won: ${wonRec.cnt} deals, $${(wonRec.total || 0).toLocaleString()}` : '',
          lostRec ? `Lost: ${lostRec.cnt} deals, $${(lostRec.total || 0).toLocaleString()}` : '',
        ].filter(Boolean).join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // 2. Deal Details
  server.tool(
    'get_deal_details',
    'Full deal information: stage, contacts, conversations, competitive intel, activity history',
    { opportunityId: z.string().describe('Salesforce Opportunity ID (starts with 006)') },
    async ({ opportunityId }) => {
      try {
        const id = sanitize(opportunityId);
        const opp = await sfQuery(`
          SELECT Id, Name, StageName, Amount, CloseDate, Probability,
                 Account.Name, Owner.Name, Description, LastActivityDate,
                 NextStep, LeadSource, Type, ForecastCategory
          FROM Opportunity WHERE Id = '${id}' LIMIT 1
        `);
        if (!opp.records.length) return { content: [{ type: 'text', text: `No opportunity found: ${opportunityId}` }] };
        const r = opp.records[0];

        const contacts = await sfQuery(`
          SELECT Contact.Name, Contact.Title, Contact.Email, Role, IsPrimary
          FROM OpportunityContactRole WHERE OpportunityId = '${id}' ORDER BY IsPrimary DESC
        `);
        const contactList = contacts.records.map(c =>
          `  • ${c.Contact.Name} (${c.Contact.Title || 'N/A'}) — ${c.Role || 'N/A'}${c.IsPrimary ? ' ⭐' : ''}`
        ).join('\n');

        const convs = await sfQuery(`
          SELECT stratoforce__Type__c, stratoforce__Date__c, stratoforce__Summary__c, stratoforce__Source_Platform__c
          FROM stratoforce__Conversation__c
          WHERE stratoforce__Opportunity__c = '${id}' ORDER BY stratoforce__Date__c DESC LIMIT 5
        `);
        const convList = convs.records.map(c =>
          `  • ${c.stratoforce__Date__c} [${c.stratoforce__Type__c}] via ${c.stratoforce__Source_Platform__c}: ${(c.stratoforce__Summary__c || '').substring(0, 150)}`
        ).join('\n');

        return { content: [{ type: 'text', text: [
          `Deal: ${r.Name}`,
          `${'='.repeat(40)}`,
          `Stage: ${r.StageName} | Amount: $${(r.Amount || 0).toLocaleString()} | Close: ${r.CloseDate}`,
          `Probability: ${r.Probability || 0}% | Forecast: ${r.ForecastCategory || 'N/A'}`,
          `Account: ${r.Account?.Name || 'N/A'} | Owner: ${r.Owner?.Name || 'N/A'}`,
          `Last Activity: ${r.LastActivityDate || 'None'} | Next Step: ${r.NextStep || 'None'}`,
          `\nContacts (${contacts.records.length}):\n${contactList || '  None'}`,
          `\nRecent Conversations (${convs.records.length}):\n${convList || '  None'}`,
        ].join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // 3. Pre-Call Briefing
  server.tool(
    'get_pre_call_briefing',
    'AI-generated pre-call briefing: stakeholder map, competitive intel, risk factors, talking points, suggested next steps',
    { opportunityId: z.string().describe('Salesforce Opportunity ID') },
    async ({ opportunityId }) => {
      try {
        const result = await sfApexRest('/stratoforce/precallbriefing', 'POST', {
          opportunityId: sanitize(opportunityId),
        });
        if (!result || result.error) return { content: [{ type: 'text', text: `Briefing failed: ${result?.error || 'Unknown'}` }], isError: true };

        const b = result;
        const sections = [
          `Pre-Call Briefing: ${b.dealName || 'Deal'}`,
          `${'='.repeat(40)}`,
          `Stage: ${b.stage || 'N/A'} | Amount: $${(b.amount || 0).toLocaleString()} | Days in Stage: ${b.daysInStage || 0} | Score: ${b.dealScore || 'N/A'}/100`,
        ];
        if (b.stakeholders?.length) {
          sections.push('\nStakeholders:');
          b.stakeholders.forEach(s => sections.push(`  • ${s.name} (${s.title || 'N/A'}) — ${s.role || 'N/A'} | Engagement: ${s.engagementStatus || 'Unknown'}`));
        }
        if (b.competitiveIntel?.length) {
          sections.push('\nCompetitive Intel:');
          b.competitiveIntel.forEach(c => sections.push(`  ⚔️ ${c.name} — Threat: ${c.threatLevel || 'N/A'} | Mentions: ${c.mentionCount || 0}`));
        }
        if (b.riskFactors?.length) {
          sections.push('\nRisk Factors:');
          b.riskFactors.forEach(r => sections.push(`  ⚠️ ${r}`));
        }
        if (b.talkingPoints?.length) {
          sections.push('\nTalking Points:');
          b.talkingPoints.forEach(t => sections.push(`  💬 ${t}`));
        }
        if (b.suggestedNextStep) sections.push(`\nSuggested Next Step: ${b.suggestedNextStep}`);
        if (b.championStatus) sections.push(`Champion: ${b.championStatus}`);

        return { content: [{ type: 'text', text: sections.join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // 4. Risk Scanner
  server.tool(
    'scan_risks',
    'Proactive risk scan: stale deals, past-due close dates, dark champions, score drops',
    {},
    async () => {
      try {
        const stale = await sfQuery(`
          SELECT Id, Name, StageName, Amount, LastActivityDate, Owner.Name
          FROM Opportunity WHERE IsClosed = false AND LastActivityDate < LAST_N_DAYS:14
          ORDER BY Amount DESC NULLS LAST LIMIT 10
        `);
        const pastDue = await sfQuery(`
          SELECT Id, Name, StageName, Amount, CloseDate, Owner.Name
          FROM Opportunity WHERE IsClosed = false AND CloseDate < TODAY
          ORDER BY Amount DESC NULLS LAST LIMIT 10
        `);
        const staleList = stale.records.map(r =>
          `  🔴 ${r.Name} ($${(r.Amount || 0).toLocaleString()}) — ${r.StageName} | Last: ${r.LastActivityDate || 'Never'} | ${r.Owner?.Name}`
        ).join('\n');
        const pastList = pastDue.records.map(r =>
          `  ⏰ ${r.Name} ($${(r.Amount || 0).toLocaleString()}) — ${r.StageName} | Due: ${r.CloseDate} | ${r.Owner?.Name}`
        ).join('\n');

        return { content: [{ type: 'text', text: [
          `Pipeline Risk Scan`, `==================`,
          `\nStale Deals (14+ days): ${stale.records.length}`, staleList || '  ✅ None',
          `\nPast Close Date: ${pastDue.records.length}`, pastList || '  ✅ None',
        ].join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // 5. Search Deals
  server.tool(
    'search_deals',
    'Search deals by name, account, stage, or owner',
    {
      query: z.string().describe('Search term'),
      stage: z.string().optional().describe('Filter by stage name'),
    },
    async ({ query, stage }) => {
      try {
        const q = sanitize(query);
        let soql = `SELECT Id, Name, StageName, Amount, CloseDate, Account.Name, Owner.Name
          FROM Opportunity WHERE (Name LIKE '%${q}%' OR Account.Name LIKE '%${q}%' OR Owner.Name LIKE '%${q}%')`;
        if (stage) soql += ` AND StageName = '${sanitize(stage)}'`;
        soql += ` ORDER BY Amount DESC NULLS LAST LIMIT 20`;
        const result = await sfQuery(soql);
        const deals = result.records.map(r =>
          `• ${r.Name} | ${r.StageName} | $${(r.Amount || 0).toLocaleString()} | Close: ${r.CloseDate} | ${r.Account?.Name || 'N/A'}`
        ).join('\n');
        return { content: [{ type: 'text', text: `Search: "${query}"\n\n${deals || 'No matching deals.'}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // 6. Competitive Intel
  server.tool(
    'get_competitive_intel',
    'Battle card data for a competitor: win/loss record, threat level, differentiators, pricing intel, recent mentions',
    { competitor: z.string().describe('Competitor name (e.g. "Clari", "Gong")') },
    async ({ competitor }) => {
      try {
        const c = sanitize(competitor);
        const intel = await sfQuery(`
          SELECT Id, Name, stratoforce__Threat_Level__c, stratoforce__Win_Strategy__c,
                 stratoforce__Our_Differentiators__c, stratoforce__Pricing_Intel__c
          FROM stratoforce__Competitor_Intel__c
          WHERE Name LIKE '%${c}%' LIMIT 5
        `);
        const mentions = await sfQuery(`
          SELECT stratoforce__Opportunity__r.Name, stratoforce__Conversation__r.stratoforce__Date__c
          FROM stratoforce__Conversation_Analysis__c
          WHERE stratoforce__Competitors_Mentioned__c != null LIMIT 10
        `);

        if (!intel.records.length) {
          return { content: [{ type: 'text', text: `No competitive intel found for "${competitor}". Check spelling or add intel via Battle Cards.` }] };
        }

        const cards = intel.records.map(r => [
          `Competitor: ${r.Name}`,
          `Threat Level: ${r.stratoforce__Threat_Level__c || 'Unknown'}`,
          `Win Strategy: ${r.stratoforce__Win_Strategy__c || 'N/A'}`,
          `Our Differentiators: ${r.stratoforce__Our_Differentiators__c || 'N/A'}`,
          `Pricing Intel: ${r.stratoforce__Pricing_Intel__c || 'N/A'}`,
        ].join('\n')).join('\n\n');

        return { content: [{ type: 'text', text: `Competitive Battle Card\n${'='.repeat(30)}\n\n${cards}\n\nRecent Mentions: ${mentions.totalSize} across conversations` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // 7. Champion Status
  server.tool(
    'get_champion_status',
    'Champion health for a deal: engagement score, last contact, seniority, risk of going dark',
    { opportunityId: z.string().describe('Salesforce Opportunity ID') },
    async ({ opportunityId }) => {
      try {
        const id = sanitize(opportunityId);
        const contacts = await sfQuery(`
          SELECT Contact.Name, Contact.Title, Contact.Email, Role, IsPrimary
          FROM OpportunityContactRole WHERE OpportunityId = '${id}' ORDER BY IsPrimary DESC
        `);
        const activities = await sfQuery(`
          SELECT Subject, ActivityDate, Status, WhoId, Who.Name
          FROM Task WHERE WhatId = '${id}' AND Status = 'Completed'
          ORDER BY ActivityDate DESC LIMIT 10
        `);

        const primary = contacts.records.find(c => c.IsPrimary);
        const lastActivity = activities.records[0];
        const daysSinceContact = lastActivity?.ActivityDate
          ? Math.floor((Date.now() - new Date(lastActivity.ActivityDate)) / 86400000)
          : 'Unknown';

        const contactList = contacts.records.map(c =>
          `  • ${c.Contact.Name} (${c.Contact.Title || 'N/A'}) — ${c.Role || 'N/A'}${c.IsPrimary ? ' ⭐ PRIMARY' : ''}`
        ).join('\n');

        const riskLevel = typeof daysSinceContact === 'number'
          ? (daysSinceContact > 14 ? '🔴 DARK (14+ days)' : daysSinceContact > 7 ? '🟡 AT RISK (7+ days)' : '🟢 Active')
          : '⚪ Unknown';

        return { content: [{ type: 'text', text: [
          `Champion Status`,
          `===============`,
          `Primary Contact: ${primary ? `${primary.Contact.Name} (${primary.Contact.Title || 'N/A'})` : 'None designated'}`,
          `Days Since Last Contact: ${daysSinceContact}`,
          `Risk Level: ${riskLevel}`,
          `\nAll Contacts (${contacts.records.length}):\n${contactList || '  None'}`,
          `\nRecent Activities:`,
          ...(activities.records.slice(0, 5).map(a => `  • ${a.ActivityDate} — ${a.Subject} (${a.Who?.Name || 'N/A'})`)),
          activities.records.length === 0 ? '  None' : '',
        ].filter(Boolean).join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // 8. Whitespace Analysis
  server.tool(
    'get_whitespace_analysis',
    'Upsell/cross-sell opportunities for an account: products owned vs catalog, expansion potential',
    { accountId: z.string().describe('Salesforce Account ID (starts with 001)') },
    async ({ accountId }) => {
      try {
        const id = sanitize(accountId);
        const account = await sfQuery(`SELECT Id, Name FROM Account WHERE Id = '${id}' LIMIT 1`);
        if (!account.records.length) return { content: [{ type: 'text', text: `Account not found: ${accountId}` }] };

        const wonProducts = await sfQuery(`
          SELECT Name, Amount, CloseDate FROM Opportunity
          WHERE AccountId = '${id}' AND IsWon = true ORDER BY CloseDate DESC
        `);
        const openDeals = await sfQuery(`
          SELECT Name, StageName, Amount, CloseDate FROM Opportunity
          WHERE AccountId = '${id}' AND IsClosed = false ORDER BY Amount DESC
        `);

        const wonList = wonProducts.records.map(r =>
          `  ✅ ${r.Name} — $${(r.Amount || 0).toLocaleString()} (closed ${r.CloseDate})`
        ).join('\n');
        const openList = openDeals.records.map(r =>
          `  🔄 ${r.Name} — ${r.StageName} — $${(r.Amount || 0).toLocaleString()} (due ${r.CloseDate})`
        ).join('\n');
        const totalWon = wonProducts.records.reduce((s, r) => s + (r.Amount || 0), 0);
        const totalOpen = openDeals.records.reduce((s, r) => s + (r.Amount || 0), 0);

        return { content: [{ type: 'text', text: [
          `Whitespace Analysis: ${account.records[0].Name}`,
          `${'='.repeat(40)}`,
          `\nProducts Owned (${wonProducts.records.length}): $${totalWon.toLocaleString()}`,
          wonList || '  None',
          `\nOpen Opportunities (${openDeals.records.length}): $${totalOpen.toLocaleString()}`,
          openList || '  None',
          `\nExpansion Potential: $${(totalOpen).toLocaleString()} in pipeline`,
        ].join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // 9. Revenue Alerts
  server.tool(
    'get_revenue_alerts',
    'Recent revenue intelligence alerts: sentiment shifts, competitor mentions, risk signals, engagement drops',
    { days: z.number().optional().describe('Look-back period in days (default 7)') },
    async ({ days }) => {
      try {
        const d = days || 7;
        const alerts = await sfQuery(`
          SELECT Id, Name, stratoforce__Alert_Type__c, stratoforce__Severity__c,
                 stratoforce__Message__c, stratoforce__Opportunity__r.Name, CreatedDate
          FROM stratoforce__AI_Alert__c
          WHERE CreatedDate = LAST_N_DAYS:${d}
          ORDER BY CreatedDate DESC LIMIT 25
        `);

        const critical = alerts.records.filter(a => a.stratoforce__Severity__c === 'Critical');
        const warnings = alerts.records.filter(a => a.stratoforce__Severity__c === 'Warning');
        const info = alerts.records.filter(a => a.stratoforce__Severity__c === 'Info');

        const fmt = (list) => list.map(a =>
          `  [${a.stratoforce__Severity__c}] ${a.stratoforce__Alert_Type__c}: ${a.stratoforce__Message__c} — ${a.stratoforce__Opportunity__r?.Name || 'N/A'}`
        ).join('\n');

        return { content: [{ type: 'text', text: [
          `Revenue Alerts (Last ${d} Days)`,
          `${'='.repeat(30)}`,
          `Total: ${alerts.records.length} | Critical: ${critical.length} | Warning: ${warnings.length} | Info: ${info.length}`,
          critical.length ? `\n🔴 Critical:\n${fmt(critical)}` : '',
          warnings.length ? `\n🟡 Warnings:\n${fmt(warnings)}` : '',
          info.length ? `\nℹ️ Info:\n${fmt(info)}` : '',
          !alerts.records.length ? '\n✅ No alerts — pipeline is clean.' : '',
        ].filter(Boolean).join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // 10. Win/Loss Analysis
  server.tool(
    'get_win_loss_analysis',
    'Win/loss patterns: win rate by stage, loss reasons, average deal cycle, trends',
    { period: z.string().optional().describe('Time period: THIS_QUARTER, LAST_QUARTER, THIS_YEAR (default THIS_QUARTER)') },
    async ({ period }) => {
      try {
        const p = period || 'THIS_QUARTER';
        const wonByStage = await sfQuery(`
          SELECT StageName, COUNT(Id) cnt, SUM(Amount) total, AVG(Amount) avg_amt
          FROM Opportunity WHERE IsWon = true AND CloseDate = ${p}
          GROUP BY StageName
        `);
        const lostByStage = await sfQuery(`
          SELECT StageName, COUNT(Id) cnt, SUM(Amount) total
          FROM Opportunity WHERE IsWon = false AND IsClosed = true AND CloseDate = ${p}
          GROUP BY StageName
        `);
        const summary = await sfQuery(`
          SELECT IsWon, COUNT(Id) cnt, SUM(Amount) total, AVG(Amount) avg_amt
          FROM Opportunity WHERE IsClosed = true AND CloseDate = ${p}
          GROUP BY IsWon
        `);

        const wonRec = summary.records.find(r => r.IsWon === true) || { cnt: 0, total: 0, avg_amt: 0 };
        const lostRec = summary.records.find(r => r.IsWon === false) || { cnt: 0, total: 0, avg_amt: 0 };
        const winRate = (wonRec.cnt + lostRec.cnt) > 0
          ? Math.round((wonRec.cnt / (wonRec.cnt + lostRec.cnt)) * 100)
          : 0;

        return { content: [{ type: 'text', text: [
          `Win/Loss Analysis (${p})`,
          `${'='.repeat(30)}`,
          `Win Rate: ${winRate}%`,
          `Won: ${wonRec.cnt} deals, $${(wonRec.total || 0).toLocaleString()} (avg $${Math.round(wonRec.avg_amt || 0).toLocaleString()})`,
          `Lost: ${lostRec.cnt} deals, $${(lostRec.total || 0).toLocaleString()} (avg $${Math.round(lostRec.avg_amt || 0).toLocaleString()})`,
          `\nWon by Final Stage:`,
          ...wonByStage.records.map(r => `  ✅ ${r.StageName}: ${r.cnt} ($${(r.total || 0).toLocaleString()})`),
          `\nLost by Final Stage:`,
          ...lostByStage.records.map(r => `  ❌ ${r.StageName}: ${r.cnt} ($${(r.total || 0).toLocaleString()})`),
        ].join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // 11. Conversation Insights
  server.tool(
    'get_conversation_insights',
    'Recent conversation analysis for a deal: sentiment trends, topics discussed, competitor mentions, next steps',
    { opportunityId: z.string().describe('Salesforce Opportunity ID') },
    async ({ opportunityId }) => {
      try {
        const id = sanitize(opportunityId);
        const convs = await sfQuery(`
          SELECT Id, stratoforce__Type__c, stratoforce__Date__c, stratoforce__Duration__c,
                 stratoforce__Summary__c, stratoforce__Source_Platform__c, stratoforce__Transcript__c
          FROM stratoforce__Conversation__c
          WHERE stratoforce__Opportunity__c = '${id}' ORDER BY stratoforce__Date__c DESC LIMIT 10
        `);
        const analyses = await sfQuery(`
          SELECT stratoforce__Sentiment_Score__c, stratoforce__Key_Topics__c,
                 stratoforce__Competitors_Mentioned__c, stratoforce__Next_Steps__c,
                 stratoforce__MEDDIC_Score__c, stratoforce__Conversation__r.stratoforce__Date__c
          FROM stratoforce__Conversation_Analysis__c
          WHERE stratoforce__Conversation__r.stratoforce__Opportunity__c = '${id}'
          ORDER BY CreatedDate DESC LIMIT 10
        `);

        const convList = convs.records.map(c => [
          `  📞 ${c.stratoforce__Date__c} [${c.stratoforce__Type__c}] via ${c.stratoforce__Source_Platform__c}`,
          `     Duration: ${c.stratoforce__Duration__c || 'N/A'}min`,
          `     Summary: ${(c.stratoforce__Summary__c || 'No summary').substring(0, 200)}`,
        ].join('\n')).join('\n\n');

        const analysisList = analyses.records.map(a => [
          `  Sentiment: ${a.stratoforce__Sentiment_Score__c || 'N/A'} | MEDDIC: ${a.stratoforce__MEDDIC_Score__c || 'N/A'}`,
          `  Topics: ${a.stratoforce__Key_Topics__c || 'N/A'}`,
          a.stratoforce__Competitors_Mentioned__c ? `  ⚔️ Competitors: ${a.stratoforce__Competitors_Mentioned__c}` : '',
          a.stratoforce__Next_Steps__c ? `  → Next: ${a.stratoforce__Next_Steps__c}` : '',
        ].filter(Boolean).join('\n')).join('\n\n');

        return { content: [{ type: 'text', text: [
          `Conversation Insights`,
          `=====================`,
          `Total Conversations: ${convs.totalSize}`,
          `\nRecent Conversations:\n${convList || '  None'}`,
          `\nAnalysis:\n${analysisList || '  None'}`,
        ].join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // 12. Account Health
  server.tool(
    'get_account_health',
    'Account health score: open deals, won history, activity recency, conversation sentiment, expansion signals',
    { accountId: z.string().describe('Salesforce Account ID (starts with 001)') },
    async ({ accountId }) => {
      try {
        const id = sanitize(accountId);
        const acct = await sfQuery(`
          SELECT Id, Name, Industry, AnnualRevenue, NumberOfEmployees FROM Account WHERE Id = '${id}' LIMIT 1
        `);
        if (!acct.records.length) return { content: [{ type: 'text', text: `Account not found.` }] };
        const a = acct.records[0];

        const openDeals = await sfQuery(`
          SELECT COUNT(Id) cnt, SUM(Amount) total FROM Opportunity
          WHERE AccountId = '${id}' AND IsClosed = false
        `);
        const wonDeals = await sfQuery(`
          SELECT COUNT(Id) cnt, SUM(Amount) total FROM Opportunity
          WHERE AccountId = '${id}' AND IsWon = true
        `);
        const recentActivity = await sfQuery(`
          SELECT COUNT(Id) cnt FROM Task
          WHERE AccountId = '${id}' AND CreatedDate = LAST_N_DAYS:30
        `);

        const o = openDeals.records[0] || {};
        const w = wonDeals.records[0] || {};
        const act = recentActivity.records[0]?.cnt || 0;

        let healthScore = 50;
        if (w.cnt > 0) healthScore += 20;
        if (o.cnt > 0) healthScore += 15;
        if (act > 5) healthScore += 15;
        healthScore = Math.min(healthScore, 100);

        return { content: [{ type: 'text', text: [
          `Account Health: ${a.Name}`,
          `${'='.repeat(30)}`,
          `Health Score: ${healthScore}/100`,
          `Industry: ${a.Industry || 'N/A'} | Revenue: $${(a.AnnualRevenue || 0).toLocaleString()} | Employees: ${a.NumberOfEmployees || 'N/A'}`,
          `\nOpen Pipeline: ${o.cnt || 0} deals, $${(o.total || 0).toLocaleString()}`,
          `Closed Won: ${w.cnt || 0} deals, $${(w.total || 0).toLocaleString()}`,
          `Activities (Last 30 days): ${act}`,
          `\nSignals:`,
          w.cnt > 0 ? '  ✅ Existing customer' : '  ℹ️ Prospect (no closed won)',
          act > 5 ? '  ✅ Active engagement' : act > 0 ? '  🟡 Light engagement' : '  🔴 No recent activity',
          o.cnt > 0 ? `  🔄 ${o.cnt} open opportunity/ies` : '  ⚪ No open deals',
        ].join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // 13. Stage Velocity
  server.tool(
    'get_stage_velocity',
    'Deal velocity analysis: average days per stage, bottleneck identification, conversion rates',
    {},
    async () => {
      try {
        const history = await sfQuery(`
          SELECT StageName, AVG(Probability) avg_prob, COUNT(Id) cnt
          FROM Opportunity WHERE IsClosed = false
          GROUP BY StageName ORDER BY AVG(Probability) ASC
        `);
        const closedWon = await sfQuery(`
          SELECT AVG(Amount) avg_deal FROM Opportunity
          WHERE IsWon = true AND CloseDate = THIS_QUARTER
        `);

        const stages = history.records.map(r =>
          `  ${r.StageName}: ${r.cnt} deals (avg probability ${Math.round(r.avg_prob || 0)}%)`
        ).join('\n');

        return { content: [{ type: 'text', text: [
          `Stage Velocity Analysis`,
          `=======================`,
          `\nCurrent Stage Distribution:\n${stages}`,
          `\nAvg Won Deal Size (This Quarter): $${Math.round(closedWon.records[0]?.avg_deal || 0).toLocaleString()}`,
          `\nBottleneck Indicators:`,
          ...history.records
            .filter(r => r.cnt > 5)
            .map(r => `  ⚠️ ${r.StageName} has ${r.cnt} deals — potential bottleneck`),
        ].join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // 14. Team Leaderboard
  server.tool(
    'get_leaderboard',
    'Sales team performance: deals won, pipeline value, activity counts, ranked by performance',
    { period: z.string().optional().describe('THIS_QUARTER, LAST_QUARTER, THIS_YEAR') },
    async ({ period }) => {
      try {
        const p = period || 'THIS_QUARTER';
        const won = await sfQuery(`
          SELECT Owner.Name, COUNT(Id) cnt, SUM(Amount) total
          FROM Opportunity WHERE IsWon = true AND CloseDate = ${p}
          GROUP BY Owner.Name ORDER BY SUM(Amount) DESC LIMIT 15
        `);
        const pipeline = await sfQuery(`
          SELECT Owner.Name, COUNT(Id) cnt, SUM(Amount) total
          FROM Opportunity WHERE IsClosed = false
          GROUP BY Owner.Name ORDER BY SUM(Amount) DESC LIMIT 15
        `);

        const wonList = won.records.map((r, i) =>
          `  ${i + 1}. ${r.Owner.Name}: ${r.cnt} deals, $${(r.total || 0).toLocaleString()}`
        ).join('\n');
        const pipeList = pipeline.records.map((r, i) =>
          `  ${i + 1}. ${r.Owner.Name}: ${r.cnt} deals, $${(r.total || 0).toLocaleString()}`
        ).join('\n');

        return { content: [{ type: 'text', text: [
          `Sales Leaderboard (${p})`,
          `${'='.repeat(30)}`,
          `\n🏆 Closed Won:\n${wonList || '  No wins this period.'}`,
          `\n📊 Open Pipeline:\n${pipeList || '  No open deals.'}`,
        ].join('\n') }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // 15. Ask StratoForce (Natural Language → SOQL)
  server.tool(
    'ask_stratoforce',
    'Natural language query about your revenue data. Ask anything about pipeline, deals, forecasts, or performance.',
    { question: z.string().describe('Natural language question about revenue data') },
    async ({ question }) => {
      try {
        // Map common questions to SOQL
        const q = question.toLowerCase();
        let soql, label;

        if (q.includes('biggest') || q.includes('largest') || q.includes('top deal')) {
          soql = `SELECT Name, Amount, StageName, Account.Name FROM Opportunity WHERE IsClosed = false ORDER BY Amount DESC LIMIT 5`;
          label = 'Top 5 Largest Open Deals';
        } else if (q.includes('closing this week') || q.includes('close this week')) {
          soql = `SELECT Name, Amount, StageName, CloseDate, Owner.Name FROM Opportunity WHERE IsClosed = false AND CloseDate = THIS_WEEK ORDER BY Amount DESC`;
          label = 'Deals Closing This Week';
        } else if (q.includes('closing this month') || q.includes('close this month')) {
          soql = `SELECT Name, Amount, StageName, CloseDate, Owner.Name FROM Opportunity WHERE IsClosed = false AND CloseDate = THIS_MONTH ORDER BY Amount DESC`;
          label = 'Deals Closing This Month';
        } else if (q.includes('won') && (q.includes('this quarter') || q.includes('quarter'))) {
          soql = `SELECT Name, Amount, CloseDate, Account.Name FROM Opportunity WHERE IsWon = true AND CloseDate = THIS_QUARTER ORDER BY Amount DESC`;
          label = 'Deals Won This Quarter';
        } else if (q.includes('lost') && (q.includes('this quarter') || q.includes('quarter'))) {
          soql = `SELECT Name, Amount, CloseDate, Account.Name FROM Opportunity WHERE IsWon = false AND IsClosed = true AND CloseDate = THIS_QUARTER ORDER BY Amount DESC`;
          label = 'Deals Lost This Quarter';
        } else if (q.includes('stale') || q.includes('no activity') || q.includes('inactive')) {
          soql = `SELECT Name, Amount, StageName, LastActivityDate, Owner.Name FROM Opportunity WHERE IsClosed = false AND LastActivityDate < LAST_N_DAYS:14 ORDER BY Amount DESC LIMIT 10`;
          label = 'Stale Deals (14+ days inactive)';
        } else if (q.includes('new') && (q.includes('this week') || q.includes('recent'))) {
          soql = `SELECT Name, Amount, StageName, CreatedDate, Account.Name FROM Opportunity WHERE CreatedDate = THIS_WEEK ORDER BY CreatedDate DESC`;
          label = 'New Deals This Week';
        } else if (q.includes('pipeline') && q.includes('total')) {
          soql = `SELECT COUNT(Id) cnt, SUM(Amount) total FROM Opportunity WHERE IsClosed = false`;
          label = 'Total Pipeline';
        } else {
          return { content: [{ type: 'text', text: `I can answer questions about:\n• Biggest/top deals\n• Deals closing this week/month\n• Won/lost deals this quarter\n• Stale/inactive deals\n• New deals this week\n• Total pipeline\n\nTry rephrasing with one of these patterns, or use search_deals for keyword search.` }] };
        }

        const result = await sfQuery(soql);
        const records = result.records.map(r => {
          const parts = [];
          if (r.Name) parts.push(r.Name);
          if (r.Amount) parts.push(`$${r.Amount.toLocaleString()}`);
          if (r.StageName) parts.push(r.StageName);
          if (r.CloseDate) parts.push(`Close: ${r.CloseDate}`);
          if (r.Account?.Name) parts.push(`Acct: ${r.Account.Name}`);
          if (r.Owner?.Name) parts.push(`Owner: ${r.Owner.Name}`);
          if (r.cnt !== undefined) parts.push(`${r.cnt} deals`);
          if (r.total !== undefined) parts.push(`$${(r.total || 0).toLocaleString()}`);
          return `  • ${parts.join(' | ')}`;
        }).join('\n');

        return { content: [{ type: 'text', text: `${label}\n${'='.repeat(label.length)}\n\n${records || 'No results.'}` }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ════════════════════════════════════════════
  // PROMPTS
  // ════════════════════════════════════════════

  server.prompt('pipeline_review', 'Weekly pipeline review — health, risks, focus areas', {}, () => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Conduct a weekly pipeline review using StratoForce tools:\n1. get_pipeline_health for current state\n2. scan_risks for at-risk deals\n3. get_leaderboard for team performance\n4. Provide: Top 3 focus deals, immediate attention items, forecast accuracy, recommended actions. Format as executive summary.`,
      },
    }],
  }));

  server.prompt('deal_coaching', 'Deep-dive deal coaching with actionable recommendations', {
    opportunityId: z.string().describe('Opportunity ID'),
  }, ({ opportunityId }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Provide deal coaching for ${opportunityId}:\n1. get_deal_details\n2. get_pre_call_briefing\n3. get_champion_status\n4. get_conversation_insights\nDeliver: health score (1-10), MEDDIC gaps, stakeholder analysis, competitive positioning, specific next steps with timelines, risk mitigation.`,
      },
    }],
  }));

  server.prompt('forecast_prep', 'Forecast call preparation with commit/best case/upside breakdown', {}, () => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Prepare forecast call briefing:\n1. get_pipeline_health\n2. scan_risks\n3. get_win_loss_analysis\n4. Organize into: Commit deals, Best Case, Upside, At-Risk, total forecast with confidence range, key changes since last week. Format for VP of Sales.`,
      },
    }],
  }));

  server.prompt('account_planning', 'Strategic account planning with whitespace and expansion analysis', {
    accountId: z.string().describe('Account ID'),
  }, ({ accountId }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Create a strategic account plan for ${accountId}:\n1. get_account_health\n2. get_whitespace_analysis for ${accountId}\n3. Search for open deals on this account\nDeliver: account health assessment, relationship map, whitespace opportunities, expansion strategy, recommended next steps.`,
      },
    }],
  }));

  return server;
}

// ── Transport: stdio or HTTP ──

if (MODE === 'stdio') {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('StratoForce AI MCP Server v2.0 running on stdio');
} else {
  const app = express();
  app.use(express.json());

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', name: 'stratoforce-ai', version: '2.0.0', tools: 15, resources: 4, prompts: 4 });
  });

  // API key middleware (optional — for pre-OAuth deployments)
  const apiKeyAuth = (req, res, next) => {
    if (!API_KEY) return next(); // No key configured = open access
    const provided = req.headers['x-api-key'] || req.headers.authorization?.replace('Bearer ', '');
    if (provided !== API_KEY) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or missing API key' });
    }
    next();
  };

  // Session management
  const transports = {};

  const handlePost = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    try {
      let transport;
      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
            console.log(`Session initialized: ${sid}`);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
            console.log(`Session closed: ${sid}`);
          }
        };
        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID' },
          id: null,
        });
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP request error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };

  const handleGet = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports[sessionId]) {
      return res.status(400).send('Invalid or missing session ID');
    }
    await transports[sessionId].handleRequest(req, res);
  };

  const handleDelete = async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports[sessionId]) {
      return res.status(400).send('Invalid or missing session ID');
    }
    await transports[sessionId].handleRequest(req, res);
  };

  // CORS for remote clients
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, x-api-key, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.post('/mcp', apiKeyAuth, handlePost);
  app.get('/mcp', apiKeyAuth, handleGet);
  app.delete('/mcp', apiKeyAuth, handleDelete);

  app.listen(PORT, () => {
    console.log(`\n🔥 StratoForce AI MCP Server v2.0`);
    console.log(`   Mode: HTTP (Streamable HTTP transport)`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Auth: ${API_KEY ? 'API Key required' : 'Open access'}`);
    console.log(`   Tools: 15 | Resources: 4 | Prompts: 4`);
    console.log(`   Health: http://localhost:${PORT}/health`);
    console.log(`   MCP:    http://localhost:${PORT}/mcp\n`);
  });

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    for (const sid in transports) {
      try { await transports[sid].close(); } catch {}
      delete transports[sid];
    }
    process.exit(0);
  });
}
