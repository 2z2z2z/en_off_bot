const {
  BURST_WINDOW,
  BURST_THRESHOLD,
  MESSAGE_INTERVAL_MAX,
  getAccumulationSlice,
  shouldTriggerBurst
} = require('../src/core/burst-detector');

describe('burst-detector', () => {
  const baseTimestamp = 1_000_000;

  const makeEntry = offset => ({
    answer: `code-${offset}`,
    timestamp: baseTimestamp + offset
  });

  test('возвращает срез при плотной серии сообщений', () => {
    const entries = [
      makeEntry(0),
      makeEntry(MESSAGE_INTERVAL_MAX - 200),
      makeEntry(2 * (MESSAGE_INTERVAL_MAX - 200))
    ];

    const slice = getAccumulationSlice(entries);

    expect(slice).not.toBeNull();
    expect(slice).toHaveLength(BURST_THRESHOLD);
  });

  test('не срабатывает при недостаточном количестве сообщений', () => {
    const entries = [makeEntry(0), makeEntry(50)];

    expect(getAccumulationSlice(entries)).toBeNull();
  });

  test('не срабатывает при выходе за окно', () => {
    const entries = [makeEntry(0), makeEntry(BURST_WINDOW + 1), makeEntry(BURST_WINDOW + 2)];

    expect(getAccumulationSlice(entries)).toBeNull();
  });

  test('не срабатывает при большом разрыве между сообщениями', () => {
    const entries = [
      makeEntry(0),
      makeEntry(MESSAGE_INTERVAL_MAX + 10),
      makeEntry(2 * (MESSAGE_INTERVAL_MAX + 10))
    ];

    expect(getAccumulationSlice(entries)).toBeNull();
  });

  test('shouldTriggerBurst возвращает true при выполнении условий', () => {
    const entries = [
      makeEntry(0),
      makeEntry(MESSAGE_INTERVAL_MAX - 50),
      makeEntry(2 * (MESSAGE_INTERVAL_MAX - 50))
    ];

    expect(shouldTriggerBurst(entries)).toBe(true);
  });

  test('shouldTriggerBurst возвращает false при отсутствии среза', () => {
    const entries = [
      makeEntry(0),
      makeEntry(MESSAGE_INTERVAL_MAX * 5),
      makeEntry(MESSAGE_INTERVAL_MAX * 10)
    ];

    expect(shouldTriggerBurst(entries)).toBe(false);
  });
});
