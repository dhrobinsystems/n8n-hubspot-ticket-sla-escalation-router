'use strict';

/**
 * tests/workflow.test.js
 * Harness tests for workflow.json:
 *  - structural validation (nodes, connections, credentials, retry policy)
 *  - build consistency (workflow.json === output of scripts/build-workflow.js)
 *  - execution of every generated Code node inside an isolated VM context that
 *    mimics the n8n Code node runtime ($input, $env, $execution, console)
 *  - repository hygiene (no secrets or real addresses committed)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildWorkflow, serialize } = require('../scripts/build-workflow');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'workflow.json');
const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
const HOUR = 3600 * 1000;

function node(name) {
  const found = workflow.nodes.find((n) => n.name === name);
  assert.ok(found, `node "${name}" not found`);
  return found;
}

/** Plain-JSON copy so values created inside the VM realm compare cleanly. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Execute an n8n Code node ("Run Once for All Items" mode) the way n8n does:
 * the code is the body of an async function with n8n globals in scope.
 */
async function runCodeNode(name, inputJsons, options) {
  const opts = options || {};
  const logs = [];
  const items = (inputJsons || []).map((json) => ({ json }));
  const context = {
    $input: { all: () => items, first: () => items[0], last: () => items[items.length - 1] },
    $execution: { id: opts.executionId || 'exec-test-1' },
    console: { log: (...args) => logs.push(args.join(' ')), warn: () => {}, error: () => {} },
  };
  if (opts.blockEnv) {
    Object.defineProperty(context, '$env', {
      get() {
        throw new Error('access to env vars denied');
      },
    });
  } else {
    context.$env = opts.env || {};
  }
  const code = node(name).parameters.jsCode;
  const result = await vm.runInNewContext(`(async () => {\n${code}\n})()`, context, { timeout: 5000 });
  return { output: plain(result), logs };
}

function hoursAgo(h) {
  return new Date(Date.now() - h * HOUR).toISOString();
}

/** A synthetic HubSpot search response page. */
function searchPage(tickets, after) {
  return { total: tickets.length, results: tickets, paging: after ? { next: { after } } : undefined };
}

function t(id, props) {
  return { id: String(id), properties: Object.assign({ hs_object_id: String(id), subject: `Synthetic ticket ${id}` }, props), archived: false };
}

const LIVE_ENV = {
  SANDBOX_MODE: 'false',
  HUBSPOT_PORTAL_ID: '12345678',
  SLACK_CHANNEL: '#support-escalations',
  ESCALATION_EMAIL_FROM: 'sla-bot@example.com',
  ESCALATION_EMAIL_TO: 'support-leads@example.com',
  SENIOR_MANAGER_EMAILS: 'senior-manager@example.com',
};

// ---------------------------------------------------------------------------
// Structure and build consistency
// ---------------------------------------------------------------------------

test('workflow.json is up to date with src/ (build consistency)', () => {
  assert.equal(fs.readFileSync(WORKFLOW_PATH, 'utf8'), serialize(buildWorkflow()), 'run `npm run build`');
});

test('workflow contains every required node with the expected type', () => {
  const expected = {
    'Every 15 Minutes': 'n8n-nodes-base.scheduleTrigger',
    'Manual Run': 'n8n-nodes-base.manualTrigger',
    'Build Search Request': 'n8n-nodes-base.code',
    'HubSpot Ticket Search': 'n8n-nodes-base.httpRequest',
    'Evaluate SLA & Plan Escalations': 'n8n-nodes-base.code',
    'Sandbox Mode?': 'n8n-nodes-base.if',
    'Dry-Run Telemetry': 'n8n-nodes-base.code',
    'Route Escalation Actions': 'n8n-nodes-base.switch',
    'HubSpot Update Ticket': 'n8n-nodes-base.httpRequest',
    'HubSpot Create Task': 'n8n-nodes-base.httpRequest',
    'Slack Block Kit Builder': 'n8n-nodes-base.code',
    'Slack Escalation Alert': 'n8n-nodes-base.slack',
    'Slack Fallback Webhook': 'n8n-nodes-base.httpRequest',
    'Email Senior Managers': 'n8n-nodes-base.emailSend',
  };
  Object.entries(expected).forEach(([name, type]) => assert.equal(node(name).type, type, name));
  assert.equal(workflow.active, false, 'workflow must be imported inactive');
  assert.equal(new Set(workflow.nodes.map((n) => n.id)).size, workflow.nodes.length, 'node IDs must be unique');
  assert.equal(new Set(workflow.nodes.map((n) => n.name)).size, workflow.nodes.length, 'node names must be unique');
});

test('connections reference existing nodes and every action node is reachable', () => {
  const names = new Set(workflow.nodes.map((n) => n.name));
  const targets = new Set();
  Object.entries(workflow.connections).forEach(([source, value]) => {
    assert.ok(names.has(source), `unknown source ${source}`);
    value.main.forEach((branch) =>
      branch.forEach((c) => {
        assert.ok(names.has(c.node), `unknown target ${c.node}`);
        targets.add(c.node);
      })
    );
  });
  workflow.nodes
    .filter((n) => !/Trigger$|stickyNote$/.test(n.type))
    .forEach((n) => assert.ok(targets.has(n.name), `${n.name} has no incoming connection`));
  // Sandbox IF: true → dry run, false → live router.
  assert.equal(workflow.connections['Sandbox Mode?'].main[0][0].node, 'Dry-Run Telemetry');
  assert.equal(workflow.connections['Sandbox Mode?'].main[1][0].node, 'Route Escalation Actions');
  // Slack error output feeds the fallback webhook.
  assert.equal(workflow.connections['Slack Escalation Alert'].main[1][0].node, 'Slack Fallback Webhook');
});

test('switch rules cover every action kind the engine emits', () => {
  const kinds = node('Route Escalation Actions').parameters.rules.values.map((r) => r.conditions.conditions[0].rightValue);
  assert.deepEqual(kinds, ['ticket_update', 'task_create', 'slack_digest', 'email_digest']);
});

test('credentials are placeholders and outbound nodes retry and tolerate errors', () => {
  workflow.nodes
    .filter((n) => n.credentials)
    .forEach((n) =>
      Object.values(n.credentials).forEach((cred) => {
        assert.match(cred.id, /^REPLACE_WITH_/, `${n.name} has a non-placeholder credential id`);
        assert.match(cred.name, /placeholder/i);
      })
    );
  ['HubSpot Ticket Search', 'HubSpot Update Ticket', 'HubSpot Create Task', 'Slack Escalation Alert', 'Slack Fallback Webhook', 'Email Senior Managers'].forEach((name) => {
    const n = node(name);
    assert.equal(n.retryOnFail, true, `${name} retryOnFail`);
    assert.ok(n.maxTries >= 2, `${name} maxTries`);
    assert.ok(n.onError, `${name} onError`);
  });
  const search = node('HubSpot Ticket Search').parameters;
  assert.equal(search.url, 'https://api.hubapi.com/crm/v3/objects/tickets/search');
  assert.equal(search.options.pagination.pagination.limitPagesFetched, true);
});

// ---------------------------------------------------------------------------
// Code node execution
// ---------------------------------------------------------------------------

test('Build Search Request: defaults to sandbox and emits a valid search body', async () => {
  const { output } = await runCodeNode('Build Search Request', [{}], { env: {} });
  assert.equal(output.length, 1);
  assert.equal(output[0].json.sandbox, true);
  assert.equal(output[0].json.runId, 'exec-test-1');
  assert.equal(output[0].json.searchBody.filterGroups[0].filters[0].operator, 'NOT_HAS_PROPERTY');
  assert.ok(output[0].json.configWarnings.length > 0);
});

test('Build Search Request: fails fast on invalid configuration', async () => {
  await assert.rejects(() => runCodeNode('Build Search Request', [{}], { env: { SLA_P1_FIRST_RESPONSE_HOURS: '-1' } }), /SLA_P1_FIRST_RESPONSE_HOURS/);
  await assert.rejects(
    () => runCodeNode('Build Search Request', [{}], { env: Object.assign({}, LIVE_ENV, { ESCALATION_EMAIL_FROM: '' }) }),
    /ESCALATION_EMAIL_FROM is required/
  );
});

test('Build Search Request: tolerates blocked $env access (N8N_BLOCK_ENV_ACCESS_IN_NODE)', async () => {
  const { output } = await runCodeNode('Build Search Request', [{}], { blockEnv: true });
  assert.equal(output[0].json.sandbox, true);
});

test('Evaluate node: paginated HubSpot results produce routed action items', async () => {
  const pages = [
    searchPage([t(1, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(20), hubspot_owner_id: '42' }), t(2, { hs_ticket_priority: 'MEDIUM', createdate: hoursAgo(3.5) })], '2'),
    searchPage([t(3, { hs_ticket_priority: 'LOW', createdate: hoursAgo(1) })]),
  ];
  const { output } = await runCodeNode('Evaluate SLA & Plan Escalations', pages, { env: LIVE_ENV });
  const kinds = output.map((i) => i.json.kind);
  assert.deepEqual(kinds, ['run_summary', 'ticket_update', 'ticket_update', 'task_create', 'slack_digest', 'email_digest']);
  assert.equal(output[0].json.status, 'OK');
  assert.equal(output[0].json.telemetry.totals.evaluated, 3);
  output.forEach((i) => assert.equal(i.json.sandbox, false));
  const task = output.find((i) => i.json.kind === 'task_create').json;
  assert.equal(task.body.associations[0].to.id, '1');
});

test('Evaluate node: empty input and empty search results return a summary only', async () => {
  const empty = await runCodeNode('Evaluate SLA & Plan Escalations', [], { env: LIVE_ENV });
  assert.deepEqual(empty.output.map((i) => i.json.status), ['NO_INPUT']);
  const noResults = await runCodeNode('Evaluate SLA & Plan Escalations', [searchPage([])], { env: LIVE_ENV });
  assert.deepEqual(noResults.output.map((i) => i.json.kind), ['run_summary']);
  assert.equal(noResults.output[0].json.status, 'OK');
});

test('Evaluate node: HubSpot rate limits and errors degrade gracefully', async () => {
  const rateLimited = await runCodeNode(
    'Evaluate SLA & Plan Escalations',
    [searchPage([t(1, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(20) })]), { error: { message: 'Request failed with status code 429', httpCode: '429' } }],
    { env: LIVE_ENV }
  );
  assert.equal(rateLimited.output[0].json.status, 'PARTIAL_RATE_LIMITED');
  assert.ok(rateLimited.output.some((i) => i.json.kind === 'slack_digest'), 'tickets already fetched are still processed');

  const failed = await runCodeNode('Evaluate SLA & Plan Escalations', [{ error: { message: 'Unauthorized', httpCode: '401' } }], { env: LIVE_ENV });
  assert.equal(failed.output.length, 1);
  assert.equal(failed.output[0].json.status, 'FETCH_ERROR');
  assert.equal(failed.output[0].json.telemetry.fetchErrors[0].status, 401);
});

test('Evaluate node: malformed tickets and missing associations never crash the run', async () => {
  const { output } = await runCodeNode(
    'Evaluate SLA & Plan Escalations',
    [searchPage([null, 'bad', { id: '9' }, t(10, { createdate: 'nope' }), t(11, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(3) })])],
    { env: LIVE_ENV }
  );
  const summary = output[0].json;
  assert.equal(summary.status, 'OK');
  assert.equal(summary.telemetry.totals.evaluated, 1);
  assert.deepEqual(summary.telemetry.unassignedEscalations, ['11']);
});

test('Sandbox branch: dry-run telemetry logs planned actions without sending anything', async () => {
  const env = Object.assign({}, LIVE_ENV, { SANDBOX_MODE: 'true' });
  const evaluated = await runCodeNode('Evaluate SLA & Plan Escalations', [searchPage([t(1, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(20) })])], { env });
  evaluated.output.forEach((i) => assert.equal(i.json.sandbox, true));

  const { output, logs } = await runCodeNode('Dry-Run Telemetry', evaluated.output.map((i) => i.json), { env });
  assert.equal(output.length, 1);
  assert.equal(output[0].json.kind, 'dry_run_report');
  assert.deepEqual(output[0].json.planned.tasks, ['1']);
  assert.ok(logs.some((l) => l.includes('DRY RUN')));
  assert.ok(logs.every((l) => !l.includes('@')), 'dry-run logs must not include email addresses');
});

test('Slack Block Kit Builder: renders blocks and skips empty digests', async () => {
  const env = Object.assign({}, LIVE_ENV, { SANDBOX_MODE: 'true' });
  const evaluated = await runCodeNode('Evaluate SLA & Plan Escalations', [searchPage([t(1, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(20) })])], { env });
  const digest = evaluated.output.find((i) => i.json.kind === 'slack_digest').json;

  const { output } = await runCodeNode('Slack Block Kit Builder', [digest, { kind: 'slack_digest', escalations: [] }], { env });
  assert.equal(output.length, 1);
  const msg = output[0].json;
  assert.equal(msg.channel, '#support-escalations');
  assert.deepEqual(JSON.parse(msg.blocksJson).blocks, msg.blocks);
  assert.equal(msg.blocks[0].type, 'header');
  assert.ok(msg.blocks.length <= 50);
  assert.match(msg.fallbackText, /1 ticket/);
});

// ---------------------------------------------------------------------------
// Repository hygiene (privacy guardrails)
// ---------------------------------------------------------------------------

test('repository contains no secrets, real webhooks or non-placeholder email addresses', () => {
  const files = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      if (['node_modules', '.git', 'coverage'].includes(entry.name)) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|json|md|yml|yaml|example)$|^\.(env\.example|gitignore)$/.test(entry.name)) files.push(full);
    });
  })(ROOT);
  assert.ok(files.length >= 8, 'expected repository files to scan');

  const forbidden = [
    { label: 'Slack bot/user token', re: /xox[abposr]-\d{6,}/ },
    { label: 'Slack webhook', re: /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}/ },
    { label: 'HubSpot private app token', re: /pat-(na|eu|ap)\d-[0-9a-f]{8}-/ },
    { label: 'AWS key', re: /AKIA[0-9A-Z]{16}/ },
    { label: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  ];
  const allowedEmailDomains = /@(example\.(com|org|net)|domain\.com)$/i;
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  files.forEach((file) => {
    if (file === __filename) return; // this file contains the patterns themselves
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file);
    forbidden.forEach(({ label, re }) => assert.ok(!re.test(text), `${label} pattern found in ${rel}`));
    (text.match(emailRe) || []).forEach((addr) => assert.match(addr, allowedEmailDomains, `non-placeholder email "${addr}" in ${rel}`));
  });
});

test('.env.example is a valid sandbox configuration and documents every key', () => {
  const { loadConfig, ENV_KEYS } = require('../src/config');
  const env = {};
  fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .forEach((line) => {
      const i = line.indexOf('=');
      env[line.slice(0, i)] = line.slice(i + 1);
    });
  ENV_KEYS.forEach((key) => assert.ok(key in env, `${key} missing from .env.example`));
  assert.equal(env.SANDBOX_MODE, 'true', '.env.example must ship with SANDBOX_MODE=true');
  const config = loadConfig(env);
  assert.equal(config.sandboxMode, true);
  assert.equal(config.hubspot.portalId, '', 'placeholder portal ID must be treated as unset');
});
