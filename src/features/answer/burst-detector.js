const BURST_WINDOW = 10000; // 10 секунд
const BURST_THRESHOLD = 3; // минимальное количество сообщений для пачки
const MESSAGE_INTERVAL_MAX = 2500; // максимальный интервал между сообщениями в пачке

function getAccumulationSlice(pending) {
  if (!pending || pending.length < BURST_THRESHOLD) {
    return null;
  }

  const slice = pending.slice(-BURST_THRESHOLD);
  const firstTs = slice[0].timestamp;
  const lastTs = slice[slice.length - 1].timestamp;
  if (lastTs - firstTs > BURST_WINDOW) {
    return null;
  }

  for (let i = 1; i < slice.length; i += 1) {
    if (slice[i].timestamp - slice[i - 1].timestamp > MESSAGE_INTERVAL_MAX) {
      return null;
    }
  }

  return slice;
}

function shouldTriggerBurst(pending) {
  return Boolean(getAccumulationSlice(pending));
}

module.exports = {
  BURST_WINDOW,
  BURST_THRESHOLD,
  MESSAGE_INTERVAL_MAX,
  getAccumulationSlice,
  shouldTriggerBurst
};
