package xyz.nexus404.hecate;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

public final class Sender extends JobService {
  static final AtomicBoolean sending = new AtomicBoolean(false);
  private final java.util.concurrent.ConcurrentHashMap<Integer, HubHttp.Call> calls =
      new java.util.concurrent.ConcurrentHashMap<>();

  static void schedule(Context c) {
    if (!Vault.active(c)) return;
    JobScheduler jobs = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
    ComponentName component = new ComponentName(c, Sender.class);
    if (jobs.getPendingJob(1) == null)
      jobs.schedule(
          new JobInfo.Builder(1, component)
              .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
              .setPersisted(true)
              .setBackoffCriteria(30000, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
              .build());
    if (jobs.getPendingJob(2) == null)
      jobs.schedule(
          new JobInfo.Builder(2, component)
              .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
              .setPersisted(true)
              .setPeriodic(15 * 60 * 1000L)
              .build());
  }

  static HubHttp.Result post(JSONObject config, JSONObject data) throws Exception {
    return new HubHttp.Call().post(config, "/api/balance/notifications", data);
  }

  public boolean onStartJob(JobParameters params) {
    if (!sending.compareAndSet(false, true)) return false;
    HubHttp.Call task = new HubHttp.Call();
    calls.put(params.getJobId(), task);
    new Thread(
            () -> {
              boolean retry = false;
              try (Queue queue = new Queue(this)) {
                for (int i = 0; i < 50 && !task.stopped && Vault.active(this); i++) {
                  JSONObject config, payload;
                  String connection;
                  synchronized (Vault.class) {
                    config = Vault.config(this);
                    payload = queue.first();
                    connection = Vault.prefs(this).getString("connection", "");
                  }
                  if (config == null || payload == null) break;
                  HubHttp.Result response =
                      task.post(config, "/api/balance/notifications", payload);
                  if (!connection.equals(Vault.prefs(this).getString("connection", ""))) break;
                  if (response.acknowledged()) {
                    queue.mark(payload.getString("eventId"), "sent");
                    Vault.prefs(this).edit().putLong("last", System.currentTimeMillis()).apply();
                    Vault.status(
                        this,
                        "accepted".equals(response.body.optString("state"))
                            ? "Операция записана в Плутос."
                            : "pending".equals(response.body.optString("state"))
                                ? "Доставлено в Плутос. Нужна проверка."
                                : "Уведомление обработано Плутосом.");
                  } else if (response.code == 401 || response.code == 403) {
                    Vault.prefs(this).edit().putBoolean("enabled", false).apply();
                    Vault.status(
                        this, "Ключ отозван или приложение не совпадает. Переподключи источник.");
                    break;
                  } else if (response.code == 400 || response.code == 409 || response.code == 413) {
                    queue.mark(payload.getString("eventId"), "blocked");
                    Vault.status(this, "Есть отклонённая операция: HTTP " + response.code);
                  } else {
                    retry = true;
                    Vault.status(
                        this,
                        "Сервер временно недоступен. Очередь сохранена (HTTP "
                            + response.code
                            + ").");
                    break;
                  }
                }
                retry = retry || queue.count("pending") > 0 && Vault.active(this);
              } catch (Exception error) {
                retry = true;
                if (!task.stopped)
                  Vault.status(this, "Нет связи или ошибка доступа. Очередь сохранена.");
              } finally {
                calls.remove(params.getJobId(), task);
                sending.set(false);
                if (!task.stopped) jobFinished(params, retry);
              }
            },
            "hecate-upload")
        .start();
    return true;
  }

  public boolean onStopJob(JobParameters params) {
    HubHttp.Call task = calls.remove(params.getJobId());
    if (task != null) task.cancel();
    return true;
  }
}
