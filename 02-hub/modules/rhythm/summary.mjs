export const dayName = (time, zone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(time);
export function bounds(day, zone) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day
  )
    throw Error('Некорректная дата');
  const midnight = Date.parse(day),
    next = new Date(midnight + 86400000).toISOString().slice(0, 10);
  const boundary = (target) => {
    let lo = Date.parse(target) - 86400000,
      hi = lo + 3 * 86400000;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (dayName(mid, zone) < target) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  return [boundary(day), boundary(next)];
}
function remainingIntervals(interval, used) {
  let remaining = [interval];
  for (const [a, b] of used) {
    const next = [];
    for (const [x, y] of remaining) {
      if (b <= x || a >= y) next.push([x, y]);
      else {
        if (a > x) next.push([x, a]);
        if (b < y) next.push([b, y]);
      }
    }
    remaining = next;
  }
  return remaining;
}
function covered(interval, used) {
  return remainingIntervals(interval, used).reduce((n, [a, b]) => n + b - a, 0);
}
function merge(intervals) {
  const out = [];
  for (const [a, b] of intervals.sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && last[1] >= a) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
function sleepQuality(r) {
  return r.type === 'sleep' && r.data.detail === 'trusleep'
    ? (r.data.stages?.some(s => s.stage > 0) ? 2 : 1) : 0;
}
function sampleDetail(points, from) {
  if (!points.length) return null;
  const ordered = [...points].sort((a, b) => a.time - b.time), hours = new Map();
  let min = ordered[0], max = ordered[0], total = 0;
  for (const point of ordered) {
    if (point.value < min.value) min = point;
    if (point.value > max.value) max = point;
    total += point.value;
    const start = from + Math.floor((point.time - from) / 3600000) * 3600000;
    let bucket = hours.get(start);
    if (!bucket) { bucket = {start, samples: 0, total: 0, min: point.value, max: point.value}; hours.set(start, bucket); }
    bucket.samples++; bucket.total += point.value;
    bucket.min = Math.min(bucket.min, point.value); bucket.max = Math.max(bucket.max, point.value);
  }
  return {samples: ordered.length, first: ordered[0].time, last: ordered.at(-1).time,
    average: Math.round(total / ordered.length * 100) / 100, min, max,
    hourly: [...hours.values()].map(({total, ...bucket}) => ({...bucket, average: Math.round(total / bucket.samples * 100) / 100}))};
}
export function summarize(day, zone, rows, sources, now = Date.now(), period = null) {
  const [from, to] = period ?? bounds(day, zone),
    rank = new Map(sources.map((s) => [s.id, s.priority])),
    huawei = new Set(sources.filter(s => s.name?.startsWith("Huawei Band 11 · ")).map(s => s.id));
  const sorted = rows
    .filter((r) => !r.deleted)
    .sort(
      (a, b) =>
        (rank.get(a.source) ?? 100) - (rank.get(b.source) ?? 100) ||
        a.source.localeCompare(b.source) ||
        sleepQuality(b) - sleepQuality(a) ||
        b.modified - a.modified ||
        a.id.localeCompare(b.id)
    );
  let steps = 0,
    stepCoverage = [],
    estimated = false,
    stepSeen = false;
  const active = [],
    sleep = [],
    sleepWindows = [],
    sleepUsed = [],
    heart = [],
    workouts = [];
  let sleepEnd = null,
    sleepSource = null,
    sleepEstimated = false,
    sleepSeen = false,
    unknownSleep = [],
    sleepComplete = true;
  const sleepStageIntervals = {light: [], deep: [], rem: [], awake: []};
  const usedSources = new Set(),
    oxygen = new Map(), oxygenTimes = new Map(),
    stressValues = new Map(), stressTimes = new Map(),
    emotionValues = new Map();
  let band = null,
    sleepMetrics = null;
  const movement = {calories: null, distance: null},
    movementCoverage = {calories: [], distance: []},
    sportPoints = new Map();
  for (const r of sorted) {
    const a = Math.max(from, r.start),
      b = Math.min(to, r.end);
    const inDay = b > a;
    const sleepInReport = r.type === 'sleep' && (period ? inDay : dayName(r.end - 1, zone) === day);
    if (
      r.type === 'sleep' &&
      r.data.metrics &&
      Object.keys(r.data.metrics).length &&
      sleepInReport &&
      (!sleepMetrics ||
        (sleepMetrics.source === r.source &&
          r.end - r.start > sleepMetrics.end - sleepMetrics.start))
    )
      sleepMetrics = {...r.data.metrics, start: r.start, end: r.end, source: r.source};
    if (sleepInReport) {
      if (
        r.data.detail !== 'trusleep' &&
        sorted.some(
          (d) =>
            d.type === 'sleep' &&
            d.source === r.source &&
            d.data.detail === 'trusleep' &&
            d.start <= r.start &&
            d.end >= r.end
        )
      )
        continue;
      sleepSource ??= r.source;
      if (sleepSource === r.source) {
        if (r.data.window) {
          const start = period ? Math.max(from, r.data.window.start) : r.data.window.start,
            end = period ? Math.min(to, r.data.window.end) : r.data.window.end;
          if (end > start) sleepWindows.push([start, end]);
        }
        const stages = r.data.stages ?? [];
        const candidates = stages.length ? stages : [{start: r.start, end: r.end, stage: r.data.window ? 0 : 2}];
        let contributed = false;
        for (const stage of candidates) {
          const start = period ? Math.max(from, stage.start) : stage.start,
            end = period ? Math.min(to, stage.end) : stage.end;
          if (end <= start) continue;
          const parts = remainingIntervals([start, end], sleepUsed);
          for (const [start, end] of parts) {
            contributed = true;
            sleepUsed.push([start, end]);
            if ([2, 4, 5, 6].includes(stage.stage)) sleep.push([start, end]);
            if (stage.stage === 0) unknownSleep.push([start, end]);
            const key = {1: 'awake', 4: 'light', 5: 'deep', 6: 'rem'}[stage.stage];
            if (r.data.detail === 'trusleep' && key) sleepStageIntervals[key].push([start, end]);
          }
        }
        if (!contributed) continue;
        sleepSeen = true;
        if (!r.data.complete || candidates.some(s => s.stage === 0)) {
          sleepComplete = false;
          sleepEstimated = true;
        }
        if (!stages.length || merge(stages.map(s => [s.start, s.end])).reduce((n, [a, b]) => n + b - a, 0) < r.end - r.start)
          sleepEstimated = true;
        sleepEnd = Math.max(sleepEnd ?? 0, r.end);
        usedSources.add(r.source);
      }
    }
    if (!inDay) continue;
    if (r.type === 'emotion') {
      const key = r.start;
      if (!emotionValues.has(key)) {
        emotionValues.set(key, {time:r.start, ...r.data.emotion});
        usedSources.add(r.source);
      }
    }
    if (r.type === 'movement') {
      for (const key of ['calories', 'distance'])
        if (r.data.metrics?.[key] !== undefined) {
          const duration = covered([a, b], movementCoverage[key]);
          if (duration) {
            movement[key] =
              (movement[key] ?? 0) + (r.data.metrics[key] * duration) / (r.end - r.start) / (key === "calories" && huawei.has(r.source) ? 1000 : 1);
            movementCoverage[key] = merge([...movementCoverage[key], [a, b]]);
            usedSources.add(r.source);
          }
        }
    }
    if (r.type === 'sport') {
      for (const sample of r.data.samples ?? [])
        if (
          sample.time >= from &&
          sample.time < to &&
          !sportPoints.has(Math.floor(sample.time / 1000))
        )
          sportPoints.set(Math.floor(sample.time / 1000), sample);
      usedSources.add(r.source);
    }
    if (r.type === 'steps') {
      const length = covered([a, b], stepCoverage);
      if (length) {
        stepSeen = true;
        steps += (r.data.value * length) / (r.end - r.start);
        if (length !== r.end - r.start) estimated = true;
        stepCoverage = merge([...stepCoverage, [a, b]]);
        usedSources.add(r.source);
      }
    }
    if (r.type === 'band' && (!band || (band.source === r.source && r.start > band.time))) {
      band = {...r.data, time: r.start, source: r.source};
      usedSources.add(r.source);
    }
    if (r.type === 'spo2' && !oxygen.has(Math.floor(r.start / 60000))) {
      oxygen.set(Math.floor(r.start / 60000), r.data.value);
      oxygenTimes.set(Math.floor(r.start / 60000), r.start);
      usedSources.add(r.source);
    }
    if (r.type === 'stress' && !stressValues.has(Math.floor(r.start / 60000))) {
      stressValues.set(Math.floor(r.start / 60000), r.data.value);
      stressTimes.set(Math.floor(r.start / 60000), r.start);
      usedSources.add(r.source);
    }
    if (r.type === 'activity') {
      active.push([a, b]);
      if (r.data.workout) workouts.push({start: r.start, end: r.end, ...r.data.workout});
      usedSources.add(r.source);
    }
    if (r.type === 'heart') {
      for (const s of r.data.samples)
        if (s.time >= from && s.time < to) heart.push({...s, source: r.source});
      usedSources.add(r.source);
    }
  }
  // One highest-priority source per minute; overlapping devices cannot weight the average twice.
  const minutes = new Map(), acceptedHeart = [],
    seenHeart = new Set();
  for (const s of heart) {
    const sampleId = s.source + '\n' + s.time;
    if (seenHeart.has(sampleId)) continue;
    seenHeart.add(sampleId);
    const key = Math.floor(s.time / 60000);
    let v = minutes.get(key);
    if (!v) {
      v = {source: s.source, values: []};
      minutes.set(key, v);
    }
    if (v.source === s.source) {
      v.values.push(s.bpm);
      acceptedHeart.push({time: s.time, value: s.bpm});
    }
  }
  const values = [...minutes.values()].map(
    (v) => v.values.reduce((a, b) => a + b, 0) / v.values.length
  );
  const sleepMinutes = sleepSeen && (sleep.length > 0 || unknownSleep.length === 0)
    ? Math.round(merge(sleep).reduce((n, [a, b]) => n + b - a, 0) / 60000)
    : null;
  const windows = merge(sleepWindows);
  const sleepAccounting = windows.length ? {insideWindow: {}, outsideWindow: {}} : null;
  if (sleepAccounting) {
    for (const [key, intervals] of Object.entries({sleep, awake: sleepStageIntervals.awake, unknown: unknownSleep})) {
      const parts = merge(intervals), total = parts.reduce((n, [a, b]) => n + b - a, 0);
      const outside = parts.reduce((n, part) => n + covered(part, windows), 0);
      sleepAccounting.insideWindow[key] = Math.round((total - outside) / 60000);
      sleepAccounting.outsideWindow[key] = Math.round(outside / 60000);
    }
  }
  const o2 = [...oxygen.values()],
    spo2 = o2.length
      ? {
          average: Math.round(o2.reduce((a, b) => a + b, 0) / o2.length),
          min: Math.min(...o2),
          max: Math.max(...o2),
          minutes: o2.length
        }
      : null;
  const sleepStages = Object.fromEntries(
    Object.entries(sleepStageIntervals).map(([key, intervals]) => [
      key,
      Math.round(merge(intervals).reduce((n, [a, b]) => n + b - a, 0) / 60000)
    ])
  );
  const stressReadings = [...stressValues.values()],
    stress = stressReadings.length
      ? {
          average: Math.round(stressReadings.reduce((a, b) => a + b, 0) / stressReadings.length),
          min: Math.min(...stressReadings),
          max: Math.max(...stressReadings),
          samples: stressReadings.length
        }
      : null;
  for (const key of Object.keys(movement))
    if (movement[key] !== null) movement[key] = Math.round(movement[key] * (key === "calories" ? 100 : 1)) / (key === "calories" ? 100 : 1);
  const sportValues = [...sportPoints.values()],
    sportHeart = sportValues.map((p) => p.heart).filter(Number.isFinite),
    sportSpeeds = sportValues.map((p) => p.speed).filter(Number.isFinite);
  const sport = sportValues.length
    ? {
        samples: sportValues.length,
        heartMin: sportHeart.length ? sportHeart.reduce((a, b) => Math.min(a, b), Infinity) : null,
        heartMax: sportHeart.length ? sportHeart.reduce((a, b) => Math.max(a, b), -Infinity) : null,
        speedMax: sportSpeeds.length
          ? sportSpeeds.reduce((a, b) => Math.max(a, b), -Infinity)
          : null
      }
    : null;
  const missing = [];
  if (!stepSeen) missing.push('steps');
  if (!values.length) missing.push('heart');
  if (sleepMinutes === null) missing.push('sleep');
  if (!active.length) missing.push('activity');
  return {
    day,
    zone,
    from,
    to,
    band,
    movement,
    sleepMetrics,
    emotion: emotionValues.size ? {
      samples: emotionValues.size,
      latest: [...emotionValues.values()].sort((a,b) => b.time-a.time)[0]
    } : null,
    sport,
    spo2,
    stress,
    workouts,
    sleepStages,
    closed: now >= to,
    steps: stepSeen ? Math.round(steps) : null,
    stepsEstimated: estimated,
    stepCoverageMinutes: Math.round(stepCoverage.reduce((n, [a, b]) => n + b - a, 0) / 60000),
    heart: values.length
      ? {
          average: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
          min: Math.round(Math.min(...values)),
          max: Math.round(Math.max(...values)),
          minutes: values.length
        }
      : null,
    sampleDetails: {
      heart: sampleDetail(acceptedHeart, from),
      spo2: sampleDetail([...oxygen].map(([minute, value]) => ({time: oxygenTimes.get(minute), value})), from),
      stress: sampleDetail([...stressValues].map(([minute, value]) => ({time: stressTimes.get(minute), value})), from)
    },
    sleepMinutes,
    sleepAccounting,
    sleepWindowMinutes: sleepWindows.length
      ? Math.round(merge(sleepWindows).reduce((n, [a, b]) => n + b - a, 0) / 60000) : null,
    sleepWindows: merge(sleepWindows).map(([start, end]) => ({start, end})),
    sleepReceived: sleepSeen,
    unknownSleepMinutes: Math.round(merge(unknownSleep).reduce((n, [a, b]) => n + b - a, 0) / 60000),
    sleepEstimated,
    sleepComplete: sleepSeen && sleepComplete && unknownSleep.length === 0,
    sleepEnd,
    activityMinutes: active.length
      ? Math.round(merge(active).reduce((n, [a, b]) => n + b - a, 0) / 60000)
      : null,
    missing,
    sources: [...usedSources]
  };
}
