(() => {
  // Each page is a separate writer, including two tabs on the same computer.
  window.NexusPlaybackSync = ({snapshot, apply, status, enabled}) => {
    const client = crypto.randomUUID(), endpoint = '/modules/wave/playback';
    let revision = 0, epoch = null, sequence = 0, generation = 0;
    let claiming = false, pulling = null, fingerprint = '', queueFingerprint = '';
    let stopped = false;
    const available = () => !stopped && enabled();
    async function request(data, keepalive = false) {
      const response = await fetch(data ? endpoint : endpoint + '?since=' + revision, {
        method: data ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
        ...(data ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)} : {}),
        keepalive, signal: AbortSignal.timeout(8000)
      });
      if (response.redirected || ![200, 409].includes(response.status)) throw new Error('sync');
      return {ok: response.ok, data: await response.json()};
    }
    async function accept(record) {
      if (!available() || record.revision <= revision) return;
      revision = record.revision;
      if (epoch && record.client === client) return;
      const takenOver = Boolean(epoch);
      epoch = null; generation++; fingerprint = queueFingerprint = '';
      const version = generation;
      if (record.state || takenOver) await apply(record.state, takenOver, () => available() && generation === version && revision === record.revision);
    }
    async function pull() {
      if (!available() || claiming) return;
      if (pulling) return pulling;
      const version = generation;
      pulling = (async () => { try {
        const {data} = await request();
        if (version === generation && !claiming) await accept(data);
      } catch {} finally { pulling = null; } })();
      return pulling;
    }
    async function claim(continuation = false) {
      if (!available()) return false;
      if (epoch) return true;
      if (claiming) return false;
      claiming = true; ++generation;
      try {
        // Read the revision without replacing an explicitly selected track/queue.
        if (!continuation) {
          const latest = await request();
          revision = Math.max(revision, latest.data.revision);
        }
        const result = await request({action: 'claim', revision, client, state: snapshot()});
        if (!available()) return false;
        if (!result.ok) {
          await accept(result.data);
          status('Плеер изменён на другом устройстве. Нажми ▶, чтобы продолжить здесь.');
          return false;
        }
        revision = result.data.revision; epoch = result.data.epoch; sequence = 0;
        fingerprint = queueFingerprint = '';
        return true;
      } catch {
        status('Не удалось получить позицию с сервера. Проверь соединение и нажми ▶ ещё раз.');
        return false;
      } finally { claiming = false; }
    }
    function save(keepalive = false, paused = false) {
      if (!available() || !epoch || claiming) return;
      const state = snapshot();
      if (!state.queue.length) return;
      if (paused) state.playing = false;
      const next = JSON.stringify(state);
      if (next === fingerprint && !keepalive) return;
      fingerprint = next;
      const queues = JSON.stringify([state.queue, state.order]);
      // Lifecycle checkpoints fit the browser's keepalive budget even for a long queue.
      if (queues === queueFingerprint) { delete state.queue; delete state.order; }
      else if (keepalive && queues.length > 58000) keepalive = false;
      const version = generation, owner = epoch;
      const data = {action: 'save', client, epoch, sequence: ++sequence, state};
      void request(data, keepalive).then(async result => {
        if (version !== generation || owner !== epoch || !available()) return;
        if (!result.ok) await accept(result.data);
        else { revision = Math.max(revision, result.data.revision); queueFingerprint = queues; }
      }).catch(() => {
        if (version !== generation) return;
        fingerprint = queueFingerprint = '';
        status('Позиция пока сохранена только на этом устройстве. Ждём соединение с сервером.');
      });
    }
    return {pull, claim, save, get owned() { return Boolean(epoch); },
      stop() { stopped = true; epoch = null; generation++; }};
  };
})();
