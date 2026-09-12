import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Config is intentionally read at module load, so set the tiny test-only
// ceiling before importing the writer. Production defaults to 10 MiB.
process.env.GOLD_POS_LOG_MAX_BYTES = '1024';
process.env.GOLD_POS_LOG_RETENTION = '2';

const { enqueueLog, drainLogWriter, getLogWriterStats } = await import('./logWriter.js');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'goldpos-log-rotation-'));
const logfile = path.join(temp, 'telemetry.log');

try {
    console.log('\n======================================================================');
    console.log('BOUNDED LOG ROTATION');
    console.log('======================================================================');

    assert.equal(enqueueLog(logfile, `${'a'.repeat(1100)}\n`), true);
    const drained = await drainLogWriter();
    assert.equal(drained.ok, true);
    assert.equal(fs.existsSync(`${logfile}.1`), true);
    assert.equal(fs.existsSync(logfile), false);
    assert.equal(getLogWriterStats().rotationFailures, 0);
    console.log('  ✅ rotates an oversized diagnostic file asynchronously');

    console.log('======================================================================');
    console.log('✅ LOG ROTATION SUITE PASSED (1 check)');
    console.log('======================================================================');
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
