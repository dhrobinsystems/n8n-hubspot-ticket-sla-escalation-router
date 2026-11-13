'use strict';

/**
 * tests/slaEngine.test.js
 * Unit tests for src/config.js and src/slaEngine.js using the native Node.js test runner.
 * All fixtures are synthetic: generic IDs, example.com addresses, placeholder portal IDs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, ConfigError, ENV_KEYS, DEFAULTS, parsePriorityMap, isPlaceholder } = require('../src/config');
const E = require('../src/slaEngine');

const NOW = new Date('2026-03-04T12:00:00.000Z'); // a Wednesday
const HOUR = 3600 * 1000;

/** Baseline env for a valid live configuration with example-only values. */
const LIVE_ENV = Object.freeze({
  SANDBOX_MODE: 'false',
  HUBSPOT_PORTAL_ID: '12345678',
  HUBSPOT_FALLBACK_OWNER_ID: '999',
  SLACK_CHANNEL: '#support-escalations',
  SLACK_SENIOR_MENTION: '<!subteam^S0000000000>',
  ESCALATION_EMAIL_FROM: 'sla-bot@example.com',
  ESCALATION_EMAIL_TO: 'support-leads@example.com',
  SENIOR_MANAGER_EMAILS: 'senior-manager@example.com',
});

function cfg(overrides) {
  return loadConfig(Object.assign({}, LIVE_ENV, overrides || {}));
}

function hoursAgo(h) {
  return new Date(NOW.getTime() - h * HOUR).toISOString();
}

function ticket(id, props) {
  return { id: String(id), properties: Object.assign({ hs_object_id: String(id), subject: `Synthetic ticket ${id}` }, props) };
}

// ---------------------------------------------------------------------------
// config.js
// ---------------------------------------------------------------------------

test('config: defaults are safe (sandbox on) and load without any env', () => {
  const c = loadConfig({});
  assert.equal(c.sandboxMode, true);
  assert.equal(c.sla.defaultTier, 'P3');
  assert.deepEqual(c.sla.tiers.P1, { firstResponseHours: 1, resolutionHours: 8 });
  assert.equal(c.sla.priorityMap.HIGH, 'P1');
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.sla.tiers.P1), 'config must be deeply frozen');
  assert.ok(c.warnings.some((w) => w.startsWith('[sandbox]')), 'sandbox should warn about missing live settings');
});

test('config: every default key is declared in ENV_KEYS', () => {
  Object.keys(DEFAULTS).forEach((key) => assert.ok(ENV_KEYS.includes(key), `${key} missing from ENV_KEYS`));
});

test('config: valid live configuration parses lists and numbers', () => {
  const c = cfg({ SLA_P2_RESOLUTION_HOURS: '36', ESCALATION_EMAIL_TO: 'a@example.com, b@example.com' });
  assert.equal(c.sandboxMode, false);
  assert.equal(c.sla.tiers.P2.resolutionHours, 36);
  assert.deepEqual(c.channels.emailTo, ['a@example.com', 'b@example.com']);
  assert.equal(c.hubspot.portalId, '12345678');
});

test('config: fail-fast collects every problem into one ConfigError', () => {
  assert.throws(
    () =>
      cfg({
        SANDBOX_MODE: 'maybe',
        SLA_P1_FIRST_RESPONSE_HOURS: 'abc',
        SLA_P2_FIRST_RESPONSE_HOURS: '30',
        SLA_P2_RESOLUTION_HOURS: '10',
        SLA_WARNING_THRESHOLD_PCT: '120',
        SLA_DEFAULT_TIER: 'P9',
        BUSINESS_HOURS_START: '18',
        ESCALATION_EMAIL_TO: 'not-an-email',
      }),
    (err) => {
      assert.ok(err instanceof ConfigError);
      const joined = err.problems.join('\n');
      ['SANDBOX_MODE', 'SLA_P1_FIRST_RESPONSE_HOURS', 'SLA_P2_RESOLUTION_HOURS', 'SLA_WARNING_THRESHOLD_PCT', 'SLA_DEFAULT_TIER', 'BUSINESS_HOURS_START', 'not-an-email'].forEach(
        (needle) => assert.ok(joined.includes(needle), `expected problem mentioning ${needle}`)
      );
      return true;
    }
  );
});

test('config: live mode requires channel settings; sandbox only warns', () => {
  assert.throws(() => cfg({ ESCALATION_EMAIL_FROM: '' }), /ESCALATION_EMAIL_FROM is required/);
  assert.throws(() => cfg({ SLACK_CHANNEL: 'YOUR_SLACK_CHANNEL' }), /SLACK_CHANNEL is required/);
  const sandbox = cfg({ SANDBOX_MODE: 'true', ESCALATION_EMAIL_FROM: '' });
  assert.ok(sandbox.warnings.some((w) => w.includes('ESCALATION_EMAIL_FROM')));
  const noEmail = cfg({ ENABLE_EMAIL: 'false', ESCALATION_EMAIL_FROM: '', ESCALATION_EMAIL_TO: '', SENIOR_MANAGER_EMAILS: '' });
  assert.equal(noEmail.channels.emailEnabled, false);
});

test('config: placeholders are treated as unset', () => {
  assert.equal(isPlaceholder('your-portal-id'), true);
  assert.equal(isPlaceholder('YOUR_HUBSPOT_API_KEY'), true);
  assert.equal(isPlaceholder('12345678'), false);
  const c = cfg({ SANDBOX_MODE: 'true', HUBSPOT_PORTAL_ID: 'your-portal-id' });
  assert.equal(c.hubspot.portalId, '');
});

test('config: priority map validation and custom property names', () => {
  const problems = [];
  const map = parsePriorityMap('urgent:p1, HIGH:P2, BAD, LOW:P7', problems);
  assert.deepEqual({ ...map }, { URGENT: 'P1', HIGH: 'P2' });
  assert.equal(problems.length, 2);
  assert.throws(() => cfg({ PROP_ESCALATION_LEVEL: 'Bad-Name' }), /lowercase snake_case/);
});

test('config: live mode warns on placeholder email domains', () => {
  const c = cfg();
  assert.ok(c.warnings.some((w) => w.includes('placeholder email address')));
});

// ---------------------------------------------------------------------------
// Dates, tiers and SLA maths
// ---------------------------------------------------------------------------

test('parseHubSpotDate handles ISO, epoch millis, epoch seconds and junk', () => {
  assert.equal(E.parseHubSpotDate('2026-03-04T12:00:00Z').toISOString(), NOW.toISOString());
  assert.equal(E.parseHubSpotDate(String(NOW.getTime())).toISOString(), NOW.toISOString());
  assert.equal(E.parseHubSpotDate(String(NOW.getTime() / 1000)).toISOString(), NOW.toISOString());
  assert.equal(E.parseHubSpotDate(NOW.getTime()).toISOString(), NOW.toISOString());
  assert.equal(E.parseHubSpotDate(''), null);
  assert.equal(E.parseHubSpotDate('not a date'), null);
  assert.equal(E.parseHubSpotDate({}), null);
  assert.equal(E.parseHubSpotDate(-5), null);
});

test('resolveTier maps priorities and falls back to the default tier', () => {
  const c = cfg();
  assert.equal(E.resolveTier('HIGH', c).tier, 'P1');
  assert.equal(E.resolveTier(' medium ', c).tier, 'P2');
  const fallback = E.resolveTier(undefined, c);
  assert.equal(fallback.tier, 'P3');
  assert.equal(fallback.source, 'DEFAULT_TIER');
  assert.equal(E.resolveTier('SOMETHING_NEW', c).source, 'DEFAULT_TIER');
});

test('classify assigns levels at the warning, breach and critical thresholds', () => {
  const c = cfg(); // warning 80, critical 150
  assert.equal(E.classify(7.9, 10, c).level, E.LEVELS.NONE);
  assert.equal(E.classify(8, 10, c).level, E.LEVELS.WARNING);
  assert.equal(E.classify(10, 10, c).level, E.LEVELS.BREACHED);
  assert.equal(E.classify(14.9, 10, c).status, 'BREACHED');
  const crit = E.classify(15, 10, c);
  assert.equal(crit.level, E.LEVELS.CRITICAL);
  assert.equal(crit.pctConsumed, 150);
  assert.equal(crit.remainingHours, 0);
});

test('businessHoursBetween counts only configured working windows', () => {
  const bh = { enabled: true, startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5], tzOffsetMinutes: 0 };
  // Friday 16:00 -> Monday 10:00 = 1h Friday + 1h Monday
  assert.equal(E.businessHoursBetween(new Date('2026-03-06T16:00:00Z'), new Date('2026-03-09T10:00:00Z'), bh), 2);
  // Entirely over a weekend
  assert.equal(E.businessHoursBetween(new Date('2026-03-07T10:00:00Z'), new Date('2026-03-08T20:00:00Z'), bh), 0);
  // Reversed range is zero, never negative
  assert.equal(E.businessHoursBetween(NOW, new Date(NOW.getTime() - HOUR), bh), 0);
  // UTC+6 offset: 03:00Z..05:00Z is 09:00..11:00 local
  const shifted = Object.assign({}, bh, { tzOffsetMinutes: 360 });
  assert.equal(E.businessHoursBetween(new Date('2026-03-04T03:00:00Z'), new Date('2026-03-04T05:00:00Z'), shifted), 2);
});

test('elapsedHours honours SLA_BUSINESS_HOURS_ONLY', () => {
  const start = new Date('2026-03-06T16:00:00Z');
  const end = new Date('2026-03-09T10:00:00Z');
  assert.equal(E.elapsedHours(start, end, cfg()), 66);
  assert.equal(E.elapsedHours(start, end, cfg({ SLA_BUSINESS_HOURS_ONLY: 'true' })), 2);
  assert.equal(E.elapsedHours(end, start, cfg()), 0);
  assert.equal(E.elapsedHours(null, end, cfg()), 0);
});

// ---------------------------------------------------------------------------
// Ticket evaluation
// ---------------------------------------------------------------------------

test('evaluateTicket: P1 ticket without a reply breaches first response', () => {
  const c = cfg();
  const ev = E.evaluateTicket(ticket(1, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(1.2), hubspot_owner_id: '42' }), c, NOW);
  assert.equal(ev.tier, 'P1');
  assert.equal(ev.firstResponse.status, 'BREACHED');
  assert.equal(ev.resolution.status, 'OK');
  assert.equal(ev.level, E.LEVELS.BREACHED);
  assert.deepEqual(ev.breachedClocks, ['FIRST_RESPONSE']);
  assert.equal(ev.notify.shouldNotify, true);
  assert.equal(ev.notify.reason, 'LEVEL_INCREASED');
  assert.deepEqual(ev.notify.channels, ['slack', 'task']);
  assert.equal(ev.hubspotUrl, 'https://app.hubspot.com/contacts/12345678/ticket/1');
});

test('evaluateTicket: answered ticket stops the first-response clock (MET / MET_LATE)', () => {
  const c = cfg();
  const met = E.evaluateTicket(ticket(2, { hs_ticket_priority: 'MEDIUM', createdate: hoursAgo(5), first_agent_reply_date: hoursAgo(4) }), c, NOW);
  assert.equal(met.firstResponse.status, 'MET');
  assert.equal(met.firstResponse.level, 0);
  const late = E.evaluateTicket(ticket(3, { hs_ticket_priority: 'URGENT', createdate: hoursAgo(5), first_agent_reply_date: hoursAgo(2) }), c, NOW);
  assert.equal(late.firstResponse.status, 'MET_LATE');
  assert.equal(late.firstResponse.level, 0, 'a late but completed reply must not keep escalating');
  assert.equal(late.resolution.status, 'OK'); // 5h of 8h = 62.5%
});

test('evaluateTicket: resolution goes CRITICAL past the critical threshold', () => {
  const ev = E.evaluateTicket(ticket(4, { hs_ticket_priority: 'LOW', createdate: hoursAgo(110), first_agent_reply_date: hoursAgo(108) }), cfg(), NOW);
  assert.equal(ev.tier, 'P3');
  assert.equal(ev.resolution.status, 'CRITICAL'); // 110 / 72 = 152.8%
  assert.equal(ev.levelName, 'CRITICAL');
  assert.deepEqual(ev.notify.channels, ['slack', 'email', 'task']);
});

test('evaluateTicket: skips invalid, closed and incomplete tickets without throwing', () => {
  const c = cfg();
  assert.equal(E.evaluateTicket(null, c, NOW).reason, 'INVALID_TICKET');
  assert.equal(E.evaluateTicket({ properties: {} }, c, NOW).reason, 'MISSING_ID');
  assert.equal(E.evaluateTicket({ id: '5' }, c, NOW).reason, 'MISSING_CREATEDATE');
  assert.equal(E.evaluateTicket(ticket(6, { createdate: 'garbage' }), c, NOW).reason, 'MISSING_CREATEDATE');
  assert.equal(E.evaluateTicket(ticket(7, { createdate: hoursAgo(3), closed_date: hoursAgo(1) }), c, NOW).reason, 'TICKET_CLOSED');
});

test('evaluateTicket: missing owner association is flagged and routed to the fallback owner', () => {
  const c = cfg();
  const ev = E.evaluateTicket(ticket(8, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(3) }), c, NOW);
  assert.equal(ev.ownerMissing, true);
  const task = E.buildTaskPayload(ev, c, NOW);
  assert.equal(task.properties.hubspot_owner_id, '999');
  assert.match(task.properties.hs_task_body, /no owner/);

  const noFallback = cfg({ HUBSPOT_FALLBACK_OWNER_ID: '' });
  const task2 = E.buildTaskPayload(E.evaluateTicket(ticket(8, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(3) }), noFallback, NOW), noFallback, NOW);
  assert.equal('hubspot_owner_id' in task2.properties, false, 'owner must be omitted rather than sent empty');
});

test('evaluateTicket: requires a config object', () => {
  assert.throws(() => E.evaluateTicket(ticket(1, {}), {}, NOW), E.SlaEngineError);
});

// ---------------------------------------------------------------------------
// Notification policy (cooldown / level changes)
// ---------------------------------------------------------------------------

test('decideNotification: cooldown suppresses repeats; level increases bypass it', () => {
  const c = cfg(); // cooldown 4h
  const recent = new Date(NOW.getTime() - 1 * HOUR);
  const old = new Date(NOW.getTime() - 5 * HOUR);
  assert.equal(E.decideNotification(2, 2, recent, c, NOW).reason, 'COOLDOWN_ACTIVE');
  assert.equal(E.decideNotification(2, 2, old, c, NOW).reason, 'COOLDOWN_ELAPSED');
  assert.equal(E.decideNotification(3, 2, recent, c, NOW).reason, 'LEVEL_INCREASED');
  assert.equal(E.decideNotification(2, 2, null, c, NOW).reason, 'NO_PRIOR_ESCALATION_RECORD');
  assert.equal(E.decideNotification(0, 2, recent, c, NOW).reason, 'DEESCALATED');
  assert.equal(E.decideNotification(0, 0, null, c, NOW).reason, 'WITHIN_SLA');
});

test('decideNotification: no enabled channel for the level means no notification', () => {
  const c = cfg({ ENABLE_SLACK: 'false' }); // warning level only had Slack
  const d = E.decideNotification(1, 0, null, c, NOW);
  assert.equal(d.shouldNotify, false);
  assert.equal(d.reason, 'NO_CHANNEL_FOR_LEVEL');
});

test('evaluateTicket reads previous escalation state from custom properties', () => {
  const c = cfg();
  const ev = E.evaluateTicket(
    ticket(9, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(1.2), sla_escalation_level: '2', sla_last_escalated_at: hoursAgo(0.5) }),
    c,
    NOW
  );
  assert.equal(ev.previousLevel, 2);
  assert.equal(ev.notify.shouldNotify, false);
  assert.equal(ev.needsPropertySync, false, 'unchanged level inside cooldown needs no write');
});

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

test('buildSearchRequest targets open tickets and requests SLA properties', () => {
  const body = E.buildSearchRequest(cfg({ HUBSPOT_PIPELINE_ID: '0' }));
  assert.deepEqual(body.filterGroups[0].filters[0], { propertyName: 'closed_date', operator: 'NOT_HAS_PROPERTY' });
  assert.deepEqual(body.filterGroups[0].filters[1], { propertyName: 'hs_pipeline', operator: 'EQ', value: '0' });
  ['first_agent_reply_date', 'sla_escalation_level', 'sla_last_escalated_at', 'createdate'].forEach((p) => assert.ok(body.properties.includes(p)));
  assert.equal(body.limit, 100);
  assert.equal(new Set(body.properties).size, body.properties.length, 'no duplicate properties');
});

test('buildTicketUpdatePayload only stamps last_escalated_at when notifying', () => {
  const c = cfg();
  const notifying = E.evaluateTicket(ticket(10, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(2) }), c, NOW);
  const p1 = E.buildTicketUpdatePayload(notifying, c, NOW).properties;
  assert.equal(p1.sla_escalation_level, '3');
  assert.equal(p1.sla_status, 'CRITICAL');
  assert.equal(p1.sla_last_escalated_at, NOW.toISOString());

  const recovered = E.evaluateTicket(
    ticket(11, { hs_ticket_priority: 'LOW', createdate: hoursAgo(5), first_agent_reply_date: hoursAgo(4), sla_escalation_level: '2' }),
    c,
    NOW
  );
  const p2 = E.buildTicketUpdatePayload(recovered, c, NOW).properties;
  assert.equal(p2.sla_escalation_level, '0');
  assert.equal('sla_last_escalated_at' in p2, false);
});

test('buildTaskPayload associates the task with the ticket', () => {
  const c = cfg();
  const ev = E.evaluateTicket(ticket(12, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(20), hubspot_owner_id: '42' }), c, NOW);
  const task = E.buildTaskPayload(ev, c, NOW);
  assert.equal(task.properties.hubspot_owner_id, '42');
  assert.equal(task.properties.hs_task_priority, 'HIGH');
  assert.equal(task.properties.hs_timestamp, new Date(NOW.getTime() + 2 * HOUR).toISOString());
  assert.deepEqual(task.associations[0], {
    to: { id: '12' },
    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 230 }],
  });
  const noSubject = cfg({ INCLUDE_TICKET_SUBJECT: 'false' });
  assert.doesNotMatch(E.buildTaskPayload(ev, noSubject, NOW).properties.hs_task_body, /Synthetic ticket/);
});

test('buildSlackBlocks renders valid Block Kit, escapes input and respects limits', () => {
  const c = cfg();
  const evs = Array.from({ length: 45 }, (_, i) =>
    E.evaluateTicket(ticket(100 + i, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(20), subject: 'Broken <script> & stuff' }), c, NOW)
  );
  const msg = E.buildSlackBlocks(evs.map((ev) => E.toEscalationSummary(ev, c)), c, { runId: 'run-1' });
  assert.equal(msg.channel, '#support-escalations');
  assert.ok(msg.blocks.length <= 50, `Slack allows max 50 blocks, got ${msg.blocks.length}`);
  assert.equal(msg.blocks[0].type, 'header');
  assert.ok(msg.blocks[0].text.text.length <= 150, 'header text limit');
  const json = JSON.stringify(msg.blocks);
  assert.ok(json.includes('&lt;script&gt; &amp; stuff'), 'subject must be escaped');
  assert.ok(json.includes('<!subteam^S0000000000>'), 'senior mention added for critical tickets');
  assert.ok(json.includes('and 5 more ticket(s)'));
  msg.blocks.filter((b) => b.type === 'section').forEach((b) => assert.ok(b.text.text.length <= 3000));
});

test('buildSlackBlocks handles an empty list without throwing', () => {
  const msg = E.buildSlackBlocks([], cfg(), {});
  assert.match(msg.text, /0 ticket/);
  assert.ok(Array.isArray(msg.blocks));
});

test('buildEmailPayload escapes HTML and adds senior managers only for critical tickets', () => {
  const c = cfg({ ESCALATION_EMAIL_MIN_LEVEL: '2' });
  const breached = E.toEscalationSummary(E.evaluateTicket(ticket(20, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(1.2), subject: '<b>x</b>' }), c, NOW), c);
  const critical = E.toEscalationSummary(E.evaluateTicket(ticket(21, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(20) }), c, NOW), c);

  const e1 = E.buildEmailPayload([breached], c, { runId: 'r' });
  assert.deepEqual(e1.to, ['support-leads@example.com']);
  assert.ok(e1.html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(!e1.html.includes('<b>x</b>'));
  assert.match(e1.subject, /^\[SLA BREACH\]/);

  const e2 = E.buildEmailPayload([critical, breached], c, {});
  assert.deepEqual(e2.to, ['support-leads@example.com', 'senior-manager@example.com']);
  assert.match(e2.subject, /CRITICAL/);
  assert.match(E.buildEmailPayload([critical], cfg({ SANDBOX_MODE: 'true' }), {}).subject, /^\[SANDBOX\]/);
});

// ---------------------------------------------------------------------------
// Batch processing, telemetry and n8n items
// ---------------------------------------------------------------------------

function mixedBatch() {
  return [
    ticket(1, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(20), hubspot_owner_id: '42' }), // critical
    ticket(2, { hs_ticket_priority: 'MEDIUM', createdate: hoursAgo(3.5) }), // P2 FR 87.5% warning, unassigned
    ticket(3, { hs_ticket_priority: 'LOW', createdate: hoursAgo(1) }), // fine
    ticket(3, { hs_ticket_priority: 'LOW', createdate: hoursAgo(1) }), // duplicate
    ticket(4, { createdate: hoursAgo(2), closed_date: hoursAgo(1) }), // closed
    { garbage: true },
    ticket(5, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(1.2), sla_escalation_level: '2', sla_last_escalated_at: hoursAgo(0.2) }), // cooldown
  ];
}

test('processTickets: evaluates a mixed batch, dedupes and plans actions', () => {
  const c = cfg();
  const r = E.processTickets(mixedBatch(), c, NOW, { runId: 'run-7' });
  assert.equal(r.received, 7);
  assert.equal(r.evaluations.length, 4);
  assert.equal(r.skipped.length, 3);
  assert.deepEqual(r.actions.escalatedIds, ['1', '2'], 'critical first, cooldown ticket suppressed');
  assert.deepEqual(r.actions.tasks.map((t) => t.ticketId), ['1']);
  assert.deepEqual(r.actions.ticketUpdates.map((u) => u.ticketId), ['1', '2']);
  assert.equal(r.actions.slackSummaries.length, 2);
  assert.equal(r.actions.emailSummaries.length, 1);
  assert.deepEqual(r.telemetry.suppressed, { COOLDOWN_ACTIVE: 1 });
  assert.deepEqual(r.telemetry.skippedByReason, { DUPLICATE: 1, TICKET_CLOSED: 1, MISSING_ID: 1 });
  assert.deepEqual(r.telemetry.unassignedEscalations, ['2']);
  assert.equal(r.telemetry.mode, 'LIVE');
  assert.equal(r.telemetry.runId, 'run-7');
});

test('processTickets: empty and non-array input return a clean, empty result', () => {
  const c = cfg();
  [[], null, undefined, 'nope', {}].forEach((input) => {
    const r = E.processTickets(input, c, NOW);
    assert.equal(r.evaluations.length, 0);
    assert.equal(r.actions.escalatedIds.length, 0);
    assert.equal(r.telemetry.totals.received, 0);
  });
});

test('processTickets: MAX_TICKETS_PER_RUN caps evaluation', () => {
  const c = cfg({ MAX_TICKETS_PER_RUN: '2' });
  const r = E.processTickets([1, 2, 3, 4].map((i) => ticket(i, { createdate: hoursAgo(1) })), c, NOW);
  assert.equal(r.evaluations.length, 2);
  assert.equal(r.telemetry.skippedByReason.RUN_LIMIT_REACHED, 2);
});

test('processTickets: telemetry never contains subjects or email addresses', () => {
  const c = cfg();
  const batch = [ticket(1, { hs_ticket_priority: 'HIGH', createdate: hoursAgo(20), subject: 'Refund for jane.doe@example.com' })];
  const r = E.processTickets(batch, c, NOW, { fetchErrors: [{ status: 401, rateLimited: false, message: 'token pat-na1-abc123 rejected for ops@example.com' }] });
  const json = JSON.stringify(r.telemetry);
  assert.ok(!json.includes('Refund'), 'subject leaked into telemetry');
  assert.ok(!json.includes('@example.com'), 'email leaked into telemetry');
  assert.ok(!json.includes('pat-na1-abc123'), 'token leaked into telemetry');
});

test('toN8nItems: emits typed items with sandbox flag and summary first', () => {
  const c = cfg({ SANDBOX_MODE: 'true' });
  const items = E.toN8nItems(E.processTickets(mixedBatch(), c, NOW), c, { runId: 'x' });
  assert.deepEqual(items.map((i) => i.json.kind), ['run_summary', 'ticket_update', 'ticket_update', 'task_create', 'slack_digest', 'email_digest']);
  items.forEach((i) => assert.equal(i.json.sandbox, true));
  const email = items.find((i) => i.json.kind === 'email_digest').json;
  assert.deepEqual(email.ticketIds, ['1']);
});

test('toN8nItems: never emits an email item without recipients', () => {
  const c = cfg({ SANDBOX_MODE: 'true', ESCALATION_EMAIL_TO: '', SENIOR_MANAGER_EMAILS: '', ESCALATION_EMAIL_MIN_LEVEL: '1' });
  const items = E.toN8nItems(E.processTickets(mixedBatch(), c, NOW), c, {});
  assert.equal(items.some((i) => i.json.kind === 'email_digest'), false);
  assert.match(items[0].json.warnings[0], /no recipients/);
});

test('extractTicketsFromResponses: flattens pages, keeps going on errors, detects rate limits', () => {
  const pages = [
    { json: { total: 2, results: [ticket(1, {}), ticket(2, {})], paging: { next: { after: '2' } } } },
    { json: { results: [ticket(3, {})] } },
    { json: { error: { message: 'Too Many Requests', httpCode: '429' } } },
    { json: ticket(4, {}) },
    { json: 'junk' },
    null,
  ];
  const out = E.extractTicketsFromResponses(pages);
  assert.deepEqual(out.tickets.map((t) => t.id), ['1', '2', '3', '4']);
  assert.equal(out.errors.length, 1);
  assert.equal(out.errors[0].status, 429);
  assert.equal(out.rateLimited, true);
  assert.deepEqual(E.extractTicketsFromResponses(undefined), { tickets: [], errors: [], rateLimited: false });
});

test('buildDryRunReport summarizes planned actions with sanitized lines', () => {
  const c = cfg({ SANDBOX_MODE: 'true' });
  const items = E.toN8nItems(E.processTickets(mixedBatch(), c, NOW), c, { runId: 'dry-1' }).map((i) => i.json);
  const report = E.buildDryRunReport(items);
  assert.equal(report.kind, 'dry_run_report');
  assert.deepEqual(report.planned.ticketUpdates, ['1', '2']);
  assert.equal(report.planned.slackTickets, 2);
  assert.equal(report.planned.emailRecipients, 2);
  assert.ok(report.lines.every((l) => !/@/.test(l)));
  assert.equal(E.buildDryRunReport([]).status, 'NO_SUMMARY');
});

test('redact strips emails, webhook URLs and tokens', () => {
  const out = E.redact(
    'mail ops@example.com hook https://hooks.slack.com/services/YOUR/WEBHOOK/URL token xoxb-YOUR-TOKEN Bearer YOUR_HUBSPOT_API_KEY'
  );
  assert.ok(!out.includes('ops@example.com'));
  assert.ok(!out.includes('hooks.slack.com'));
  assert.ok(!out.includes('xoxb-YOUR-TOKEN'));
  assert.ok(!out.includes('YOUR_HUBSPOT_API_KEY'));
  assert.equal(E.redact(null), '');
});
