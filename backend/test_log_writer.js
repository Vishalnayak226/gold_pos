import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    enqueueLog,
    drainLogWriter,
    getLogWriterStats
} from './logWriter.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'goldpos-log-writer-'));
const telemetry = path.join(temp, 'telemetry.log');
const blackbox = path.join(temp, 'blackbox.log');

try {
    console.log('\n======================================================================');
    console.log('BOUNDED ASYNCHRONOUS LOG WRITER');
    console.log('======================================================================');

    assert.equal(enqueueLog(telemetry, 'one\n'), true);
    assert.equal(enqueueLog(telemetry, 'two\n'), true);
    assert.equal(enqueueLog(blackbox, 'black-box\n'), true);

    const drained = await drainLogWriter();
    assert.equal(drained.ok, true);
    assert.equal(fs.readFileSync(telemetry, 'utf8'), 'one\ntwo\n');
    assert.equal(fs.readFileSync(blackbox, 'utf8'), 'black-box\n');
    assert.equal(getLogWriterStats().queuedEntries, 0);
    assert.equal(getLogWriterStats().inFlightEntries, 0);
    console.log('  ✅ batches per file, preserves line order and drains cleanly');

    console.log('======================================================================');
    console.log('✅ LOG WRITER SUITE PASSED (1 check)');
    console.log('======================================================================');
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
