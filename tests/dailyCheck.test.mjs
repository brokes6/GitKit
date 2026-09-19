import test from 'node:test';
import assert from 'node:assert/strict';
import { DAILY_CHECK_DEFAULT, nextCheckLabel, shouldPresentCheck, validCheckTime } from '../src/dailyCheck.ts';

const config = { ...DAILY_CHECK_DEFAULT, enabled: true, time: '10:30' };
const at = (day, hour = 11) => new Date(2026, 8, day, hour, 0);

test('missed time catches up today; completed day moves to tomorrow even when time changes', () => {
  assert.equal(nextCheckLabel(config, at(18, 9)), '今天 10:30');
  assert.equal(nextCheckLabel(config, at(18)), '今天尚未检查，将在后台补查');
  assert.equal(nextCheckLabel({ ...config, lastRun: +at(18) }, at(18, 12)), '明天 10:30');
  assert.equal(nextCheckLabel({ ...config, time: '14:30', lastRun: +at(18) }, at(18, 15)), '明天 14:30');
});
test('weekend labels match native skip policy without suppressing Monday catch-up', () => {
  const weekdays = { ...config, skipWeekends: true };
  assert.equal(nextCheckLabel(weekdays, at(19)), '9月21日 10:30');
  assert.equal(nextCheckLabel(weekdays, at(20)), '明天 10:30');
  assert.equal(nextCheckLabel({ ...weekdays, lastRun: +at(18) }, at(18, 12)), '9月21日 10:30');
  assert.equal(nextCheckLabel(weekdays, at(21)), '今天尚未检查，将在后台补查');
  assert.equal(nextCheckLabel({ ...weekdays, enabled: false }, at(21)), null);
});
test('background results wait for foreground; viewed or previous-day results never pop automatically', () => {
  const result = { id: 1, completedAt: +at(18), viewed: false, manual: false, total: 1, rows: [] };
  assert.equal(shouldPresentCheck(result, false, at(18, 12)), false);
  assert.equal(shouldPresentCheck(result, true, at(18, 12)), true);
  assert.equal(shouldPresentCheck({ ...result, viewed: true }, true, at(18, 12)), false);
  assert.equal(shouldPresentCheck(result, true, at(19)), false);
  assert.equal(shouldPresentCheck(null, true, at(18)), false);
});
test('invalid persisted times cannot overflow into a different day', () => {
  for (const value of ['24:00', '10:60', '99:99', '', null]) assert.equal(validCheckTime(value), false);
  for (const value of ['00:00', '9:30', '23:59']) assert.equal(validCheckTime(value), true);
});
