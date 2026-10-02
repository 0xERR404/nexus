package xyz.nexus404.hecate;

import android.content.Context;
import android.content.SharedPreferences;
import java.text.DateFormat;
import java.util.Date;
import org.json.*;

/** Only delivery metadata is exported; no raw logs, identifiers or measurements. */
final class BandEvidence {
  static final String[] TYPES = {"band", "steps", "heart", "spo2", "movement", "sleep", "stress", "activity"};
  static final String[] NAMES = {"Счётчик и заряд", "История шагов", "Пульс", "SpO₂", "Движение", "Сон", "Стресс", "Тренировки"};

  static String time(long at) {
    return at <= 0 ? "ещё нет" : DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(new Date(at));
  }

  static void saved(Context c, JSONArray rows) {
    SharedPreferences.Editor edit = Vault.prefs(c).edit();
    long now = System.currentTimeMillis();
    for (int i = 0; i < rows.length(); i++) {
      JSONObject row = rows.optJSONObject(i);
      if (row == null) continue;
      for (String type : TYPES) if (type.equals(row.optString("type")) || (type.equals("activity") && row.optString("type").equals("sport")))
        edit.putLong("bandEvidence." + type, now);
    }
    edit.apply();
  }

  static void attempt(Context c, boolean extended, boolean ok) {
    Vault.prefs(c).edit().putLong("bandEvidence." + (extended ? "extended" : "basic"), System.currentTimeMillis())
      .putBoolean("bandEvidence." + (extended ? "extended" : "basic") + ".ok", ok).apply();
  }

  static String data(Context c) {
    SharedPreferences p = Vault.prefs(c);
    StringBuilder text = new StringBuilder();
    for (int i = 0; i < TYPES.length; i++) {
      long received = p.getLong("bandEvidence." + TYPES[i], 0);
      String group = i >= 6 ? "extended" : "basic";
      long attempted = i == 0 ? p.getLong("bandReadAt", 0) : p.getLong("bandEvidence." + group, 0);
      boolean ok = i == 0 || p.getBoolean("bandEvidence." + group + ".ok", false);
      text.append(NAMES[i]).append(": ");
      boolean unsupported = (i == 7 && p.contains("bandEvidence.workout.supported") && !p.getBoolean("bandEvidence.workout.supported", true)) || (i == 6 && p.contains("bandEvidence.files.supported") && !p.getBoolean("bandEvidence.files.supported", true));
      if (unsupported) text.append("выбранный способ чтения не подтверждён · ");
      if (received > 0) text.append("сохранено на телефоне ").append(time(received));
      else text.append(attempted == 0 ? "ещё не проверено" : ok ? "в прочитанном окне нет записей" : "чтение не завершено");
      if (attempted > received && !ok) text.append(" · последняя попытка не завершена");
      text.append('\n');
    }
    return text.append("Наличие записей не подтверждает полноту данных. Форматы сна и расширенной истории — в диагностике.").toString();
  }

  static String delivery(Context c) {
    SharedPreferences p = Vault.prefs(c);
    String pending;
    try { pending = Integer.toString(BandUpload.files(c).length); }
    catch (RuntimeException e) { pending = "недоступна"; }
    return "Прочитано: " + time(p.getLong("bandReadAt", 0))
      + "\nХаб подтвердил пакет: " + time(p.getLong("bandUploaded", 0))
      + "\nОчередь пакетов: " + pending
      + "\nПопытка отправки: " + time(p.getLong("bandUploadAttempt", 0))
      + "\nЭтап отправки: " + UploadDiagnostic.stage(p.getInt("bandUploadStage", 0))
      + "\nРезультат отправки: " + UploadDiagnostic.reason(p.getInt("bandUploadError", 0))
      + "\nHTTP последней попытки: " + p.getInt("bandUploadHttp", 0);
  }

  static String report(Context c) {
    SharedPreferences p = Vault.prefs(c);
    StringBuilder out = new StringBuilder("Геката ").append(Vault.version(c))
      .append(" · Android ").append(android.os.Build.VERSION.RELEASE)
      .append("\n").append(BandService.linkState(c)).append("\n")
      .append(BandService.powerState(c)).append("\n").append(delivery(c))
      .append("\n").append(data(c));
    out.append("\nМониторинг: ").append(BandService.monitorStatus(c));
    out.append("\nРасширенная история: ").append(p.getString("bandFilesStatus", "ещё не проверено"));
    out.append("\nСлужба: ").append(BandService.instance != null ? "работает" : "не работает")
      .append("\nНеизвестных стадий сна: ").append(p.getInt("bandUnknownSleep", 0))
      .append("\nСлушатель уведомлений: ").append(BankListener.connected() ? "есть" : "нет");
    out.append("\nПоследний отказ браслета: ").append(p.getLong("bandRemoteError", 0))
      .append(" · ").append(time(p.getLong("bandRemoteErrorAt", 0)))
      .append("\nФаза последнего обрыва: ").append(p.getInt("bandFailurePhase", -1))
      .append(" · ").append(time(p.getLong("bandFailureAt", 0)));
    return out.toString();
  }
}
