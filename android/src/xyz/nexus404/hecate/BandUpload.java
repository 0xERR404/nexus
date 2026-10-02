package xyz.nexus404.hecate;

import android.app.job.*;
import android.content.*;
import android.util.AtomicFile;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.*;

public final class BandUpload extends JobService {
  private static final AtomicBoolean running = new AtomicBoolean();
  private final java.util.concurrent.ConcurrentHashMap<Integer, HubHttp.Call> calls =
      new java.util.concurrent.ConcurrentHashMap<>();

  static File directory(Context c) {
    File d = new File(c.getNoBackupFilesDir(), "band-outbox");
    if (!d.exists() && !d.mkdirs()) throw new IllegalStateException("Нет места для очереди");
    return d;
  }

  static File[] files(Context c) {
    File dir = directory(c);
    String[] names = dir.list();
    if (names == null) throw new IllegalStateException("Очередь недоступна");
    TreeSet<String> bases = new TreeSet<>();
    for (String name : names) {
      if (name.endsWith(".json")) bases.add(name);
      else if (name.endsWith(".json.bak")) bases.add(name.substring(0, name.length() - 4));
    }
    return bases.stream().map(name -> new File(dir, name)).toArray(File[]::new);
  }

  static JSONObject config(Context c) throws Exception {
    String s = Vault.prefs(c).getString("bandConnection", "");
    return s.isEmpty() ? null : new JSONObject(Vault.open(s));
  }

  static String target(JSONObject cfg) throws Exception {
    return BandAuth.hex(
        BandAuth.sha(BandAuth.utf(cfg.getString("origin") + "\n" + cfg.getString("token"))));
  }

  static void status(Context c, String s) {
    AppDiagnostics.event(c,"Доставка браслета",s);
    Vault.prefs(c).edit().putString("bandUploadStatus", s).apply();
  }

  static synchronized void saveConfig(Context c, JSONObject cfg, boolean transfer) throws Exception {
    if (BandService.enabled(c)) throw new IOException("Сначала нажми «Остановить связь»");
    if (!running.compareAndSet(false, true))
      throw new IOException("Дождись завершения отправки и повтори сохранение");
    try {
      JSONObject saved = QueueRoute.prepare(config(c), cfg, files(c).length > 0, transfer);
      if (!Vault.prefs(c).edit().putString("bandConnection", Vault.seal(saved.toString())).remove("bandRefreshReceipt").commit())
        throw new IOException("Настройки не сохранены");
    } finally {
      running.set(false);
    }
  }

  static synchronized void enqueue(
      Context c, JSONArray records, boolean complete, String expectedTarget) throws Exception {
    JSONObject cfg = config(c);
    if (cfg == null) throw new IOException("Сначала подключи Асклепий в настройках этого экрана");
    if (!target(cfg).equals(expectedTarget))
      throw new IOException("Подключение изменилось; повтори чтение");
    if (records.length() > 500) throw new IOException("Слишком большой пакет");
    long size = 0;
    File[] old = files(c);
    for (File f : old) size += Math.max(f.length(), new File(f.getPath() + ".bak").length());
    JSONObject body =
        new JSONObject()
            .put("records", records)
            .put("deleted", new JSONArray())
            .put("complete", complete);
    byte[] data =
        Vault.seal(new JSONObject().put("target", target(cfg)).put("body", body).toString())
            .getBytes(StandardCharsets.UTF_8);
    if (data.length > 1800000 || size + data.length > 16 * 1024 * 1024 || old.length >= 2048)
      throw new IOException("Очередь заполнена; отправь накопленное и повтори чтение");
    long seq = Math.max(System.currentTimeMillis(), Vault.prefs(c).getLong("bandSequence", 0) + 1);
    if (!Vault.prefs(c).edit().putLong("bandSequence", seq).commit())
      throw new IOException("Очередь не сохранена");
    AtomicFile file =
        new AtomicFile(new File(directory(c), String.format(Locale.ROOT, "%019d.json", seq)));
    FileOutputStream out = null;
    try {
      out = file.startWrite();
      out.write(data);
      file.finishWrite(out);
    } catch (Exception e) {
      if (out != null) file.failWrite(out);
      throw e;
    }
    BandEvidence.saved(c, records);
    status(c, "В очереди пакетов: " + files(c).length);
    schedule(c, false);
  }

  static void schedule(Context c, boolean now) {
    try {
      if (config(c) == null || files(c).length == 0) return;
      JobScheduler jobs = (JobScheduler) c.getSystemService(JOB_SCHEDULER_SERVICE);
      if (!now && jobs.getPendingJob(12) != null) return;
      int id = now ? 11 : 12;
      if (now && jobs.getPendingJob(id) != null) return;
      JobInfo.Builder b =
          new JobInfo.Builder(id, new ComponentName(c, BandUpload.class))
              .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
              .setPersisted(true)
              .setBackoffCriteria(30000, JobInfo.BACKOFF_POLICY_EXPONENTIAL);
      if (!now) b.setPeriodic(900000);
      if (jobs.schedule(b.build()) != JobScheduler.RESULT_SUCCESS)
        status(c, "Android не смог запланировать отправку; очередь сохранена");
    } catch (Exception e) {
      status(c, "Не удалось запланировать отправку");
    }
  }

  static void manual(Context context) {
    Context c = context.getApplicationContext();
    schedule(c, false);
    new Thread(() -> flush(c, new HubHttp.Call()), "band-manual-upload").start();
  }

  static void progress(Context c, int stage) {
    Vault.prefs(c).edit().putInt("bandUploadStage", stage).apply();
  }

  static void flush(Context c, HubHttp.Call call) {
    if (!running.compareAndSet(false, true)) return;
    Vault.prefs(c).edit().putLong("bandUploadAttempt", System.currentTimeMillis())
        .putInt("bandUploadStage", 1).putInt("bandUploadError", 0)
        .putInt("bandUploadHttp", 0).apply();
    status(c, "Отправка запущена");
    try {
      JSONObject cfg = config(c);
      if (cfg == null) throw new IOException("Подключение Асклепия не настроено");
      String destination = target(cfg);
      String capability = "bandExtended." + destination;
      long checked = Vault.prefs(c).getLong(capability + ".at", 0);
      if (!Vault.prefs(c).contains("bandMetrics." + destination)
          || BandPolicy.due(System.currentTimeMillis(), checked, 3600000L)) {
        progress(c, 2);
        JSONObject hello = call.send(cfg, new JSONObject().put("type", "hello"));
        if (!"ready".equals(hello.optString("state")))
          throw new IOException("Хаб не подтвердил готовность приёмника");
        Vault.prefs(c)
            .edit()
            .putBoolean(capability, hello.optBoolean("bandExtended"))
            .putBoolean("bandMetrics." + destination, hello.optBoolean("bandMetrics"))
            .putLong(capability + ".at", System.currentTimeMillis())
            .apply();
      }
      long deadline = System.currentTimeMillis() + 180000;
      int sent = 0;
      for (File f : files(c)) {
        if (call.stopped || System.currentTimeMillis() > deadline) break;
        progress(c, 3);
        JSONObject item;
        synchronized (BandUpload.class) {
          try (InputStream in = new AtomicFile(f).openRead()) {
            byte[] bytes = read(in, 2000000);
            item = new JSONObject(Vault.open(new String(bytes, StandardCharsets.UTF_8)));
          }
          if (!QueueRoute.accepts(cfg, item.getString("target"))
              || !destination.equals(target(config(c))))
            throw new IOException("Адрес очереди отличается; отправка остановлена");
        }
        JSONObject body = item.getJSONObject("body");
        progress(c, 4);
        JSONObject result = call.send(cfg, body);
        progress(c, 5);
        if (result.optInt("accepted", -1) != body.getJSONArray("records").length()
            || result.optInt("deleted", -1) != 0)
          throw new IOException("Хаб не подтвердил весь пакет");
        synchronized (BandUpload.class) {
          new AtomicFile(f).delete();
        }
        sent += body.getJSONArray("records").length();
        Vault.prefs(c).edit().putLong("bandUploaded", System.currentTimeMillis()).apply();
        status(c, "Хаб подтвердил записей: " + sent + " · пакетов осталось: " + files(c).length);
      }
      progress(c, files(c).length == 0 ? 6 : 7);
      if (files(c).length == 0) {
        status(c, "Очередь отправлена · ожидающих пакетов нет");

      }
    } catch (Exception e) {
      Vault.prefs(c).edit().putInt("bandUploadError", call.stopped ? 7 : UploadDiagnostic.error(e)).apply();
      status(c, UploadDiagnostic.reason(call.stopped ? 7 : UploadDiagnostic.error(e)) + " · очередь сохранена");
    } finally {
      Vault.prefs(c).edit().putInt("bandUploadHttp", call.responseCode).apply();
      running.set(false);
      finishRefreshReceipt(c);
      schedule(c, false);
    }
  }

  static void finishRefreshReceipt(Context c) {
    try {
      String receipt=Vault.prefs(c).getString("bandRefreshReceipt","");
      if(!BandHub.validId(receipt) || files(c).length!=0)return;
      JSONObject cfg=config(c);
      if(cfg==null)return;
      new HubHttp.Call().send(cfg,new JSONObject().put("type","refreshAck").put("id",receipt).put("state","delivered"));
      if(receipt.equals(Vault.prefs(c).getString("bandRefreshReceipt","")))
        Vault.prefs(c).edit().remove("bandRefreshReceipt").apply();
    } catch(Exception e) { AppDiagnostics.event(c,"Сигнал хаба","Подтверждение обновления отложено"); }
  }

  static byte[] read(InputStream in, int max) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buf = new byte[4096];
    int n;
    while ((n = in.read(buf)) != -1) {
      if (out.size() + n > max) throw new IOException("Пакет очереди слишком большой");
      out.write(buf, 0, n);
    }
    return out.toByteArray();
  }

  static synchronized void clear(Context c) throws Exception {
    if (!running.compareAndSet(false, true))
      throw new IOException("Дождись завершения отправки и повтори");
    try {
      for (File f : files(c)) new AtomicFile(f).delete();
      if (files(c).length != 0) throw new IOException("Не удалось удалить очередь");
      status(c, "Очередь удалена. История хаба сохранена.");
    } finally {
      running.set(false);
    }
  }

  public boolean onStartJob(JobParameters p) {
    HubHttp.Call task = new HubHttp.Call();
    calls.put(p.getJobId(), task);
    new Thread(
            () -> {
              boolean retry = true;
              try {
                flush(this, task);
                retry = files(this).length > 0;
              } catch (Exception e) {
                status(this, "Очередь недоступна; повторим отправку");
              } finally {
                calls.remove(p.getJobId(), task);
                if (!task.stopped) jobFinished(p, retry);
              }
            },
            "band-upload")
        .start();
    return true;
  }

  public boolean onStopJob(JobParameters p) {
    HubHttp.Call task = calls.remove(p.getJobId());
    if (task != null) task.cancel();
    return true;
  }
}
