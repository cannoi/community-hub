'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { TrustEngine, TRUST } = require('../src/net/p2p/trust-engine');

describe('Phase 3 Trust Engine', () => {
  it('new peers start NEW and move to PROBATION on success', () => {
    const t = new TrustEngine();
    assert.equal(t.stateOf('12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), TRUST.NEW);
    t.observe('12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', { success: true });
    assert.equal(t.stateOf('12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), TRUST.PROBATION);
  });

  it('rejects bad peer ids', () => {
    const t = new TrustEngine();
    assert.equal(t.validatePeerId('short').ok, false);
    assert.equal(t.validatePeerId('12D3KooWAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').ok, true);
  });

  it('enforces dial quota for NEW peers', () => {
    const t = new TrustEngine();
    const id = '12D3KooWBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    let last = null;
    for (let i = 0; i < 5; i++) last = t.allow(id, 'dial');
    assert.equal(last.ok, false);
    assert.equal(last.reason, 'quota');
  });

  it('quarantines after abuse', () => {
    const t = new TrustEngine({ quarantineMs: 60000 });
    const id = '12D3KooWCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    t.observe(id, { abuse: 3 });
    assert.equal(t.stateOf(id), TRUST.QUARANTINED);
    assert.equal(t.allow(id, 'dial').ok, false);
  });

  it('blocks after repeated abuse', () => {
    const t = new TrustEngine();
    const id = '12D3KooWDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
    t.observe(id, { abuse: 10 });
    assert.equal(t.stateOf(id), TRUST.BLOCKED);
  });

  it('promotes to TRUSTED after enough successes', () => {
    const t = new TrustEngine();
    const id = '12D3KooWEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';
    for (let i = 0; i < 5; i++) t.observe(id, { success: true });
    assert.equal(t.stateOf(id), TRUST.TRUSTED);
  });
});
